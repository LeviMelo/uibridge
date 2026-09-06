// DOM PROVIDER BASE
//
// The generic implementation of the contract for any chat UI driven through
// its DOM. A concrete provider supplies a selector contract and, where the
// UI is genuinely unusual, overrides one method.
//
// This exists so that adding a provider is a selectors file plus its quirks,
// not a second copy of the request flow. The prototype had the flow welded to
// Gemini, so "add ChatGPT" meant "write it all again" - and any fix to
// completion detection or extraction would then have to be made twice.
//
// STRATEGIES let a provider pick a mechanism without new code:
//   attach:  'cdp-drag' | 'file-input' | 'file-chooser'
//   picker:  'combined' (one control carries model AND modes, read from its
//            aria-label) | 'separate' (independent controls)

import { resolve as resolvePath } from 'node:path'
import { Provider, Capabilities } from './contract.mjs'
import { BridgeError, ChallengeError, ContractError, SignedOutError, TimeoutError } from '../core/errors.mjs'
import { sessionState, signedOutMessage } from '../core/auth.mjs'
import { sleep, waitFor, waitStable } from '../core/async.mjs'
import { parseCodeBlocks, parseTables } from '../core/markdown.mjs'
import {
  copyMarkdown,
  count,
  downloadGeneratedFiles,
  isGenerating,
  readRenderedText,
} from '../transports/dom.mjs'
import { reconstructMarkdown } from '../transports/markdown-dom.mjs'
import { sweepThread } from '../transports/thread-dom.mjs'
import { WireTap } from '../transports/wire.mjs'
import { decodeDeltaStream } from '../transports/sse-openai.mjs'

const cdpSessions = new WeakMap()
async function cdp(page) {
  if (!cdpSessions.has(page)) cdpSessions.set(page, await page.context().newCDPSession(page))
  return cdpSessions.get(page)
}

export class DomProvider extends Provider {
  /** Overridden per provider; see each selectors.json. */
  static selectors = {}

  get sel() {
    return this.constructor.selectors
  }

  capabilities() {
    const s = this.sel
    return new Capabilities({
      models: s.models ?? {},
      modes: s.modes ?? {},
      attachments: !!s.dropTarget || !!s.fileInput,
      generatedFiles: !!(s.generatedFile?.chip || s.generatedFile?.scheme),
      citations: !!s.sourceChip || !!s.wire?.answer,
      // A provider whose answer is readable off the network declares it in
      // selectors.json under `wire`; the DOM stays as the fallback.
      transports: s.wire?.answer ? ['wire', 'dom'] : ['dom'],
      // Whole-thread export needs a MEASURED message-identity contract; a
      // provider without one says so rather than exporting a fragment.
      threadExport: !!s.thread?.export?.messageNode,
    })
  }

  /** Is the answer read from the network on this provider? */
  get wired() {
    return !!this.sel.wire?.answer
  }

  // --- lifecycle -----------------------------------------------------------

  async prepareAuth(page) {
    const { url } = this.settings
    if (page.url() === 'about:blank' || !page.url().startsWith(new URL(url).origin)) {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
    }
  }

  async open(page) {
    const { url, readyTimeoutMs } = this.settings
    await this.prepareAuth(page)
    await this.assertNoChallenge(page)

    // Insist on VISIBLE, not merely present: a leftover overlay (a file
    // viewer, a dialog) leaves the composer attached but unusable, and
    // waiting on presence then succeeds instantly and everything after fails.
    const composer = () => page.locator(this.sel.composer).first().waitFor({ state: 'visible', timeout: readyTimeoutMs })
    try {
      await composer()
    } catch {
      await this.assertNoChallenge(page)
      await page.keyboard.press('Escape').catch(() => {})
      await page.reload({ waitUntil: 'domcontentloaded' })
      try {
        await composer()
      } catch {
        throw new SignedOutError(this.id, signedOutMessage(this.id, await this.sessionState(page).catch(() => null)))
      }
    }
  }

  /**
   * The full verdict, with the evidence that produced it.
   *
   * Ranked in ../core/auth.mjs: a session cookie or the app's own session
   * endpoint outranks anything read off the page, because page text is a
   * guess about a translation - this account renders Gemini in pt-BR - and
   * because the strongest signal of all is which APPLICATION the server
   * chose to serve.
   */
  async sessionState(page) {
    return sessionState(page, this.sel.auth ?? {})
  }

  async isSignedIn(page) {
    // Note the shape of the version this replaced: it returned TRUE when it
    // had nothing to go on. A rendered composer proves nothing - these sites
    // serve a whole anonymous app, so a signed-out request does not fail, it
    // answers from a weaker model with nothing to mark it. Only a positive
    // proof counts now.
    const v = await this.sessionState(page)
    return v.state === 'in'
  }

  /**
   * Dismiss the site's own blocking notices, and say which ones were there.
   *
   * THIS IS NOT COSMETIC. ChatGPT's rate-limit modal sits in a `fixed
   * inset-0 z-50` backdrop, so while it is up EVERY click is swallowed:
   * Playwright reports "subtree intercepts pointer events" and a download
   * click times out having sent no request at all. Two runs were spent
   * blaming the download endpoint for that.
   *
   * The notice is still REPORTED rather than raised - on ChatGPT it locks
   * history, not sending, so a request that otherwise worked must not be
   * turned into a failure. Returns [{ kind, name, text }].
   */
  async dismissNotices(page) {
    const specs = this.sel.notices ?? []
    const found = []
    for (const spec of specs) {
      const re = new RegExp(spec.match, 'i')
      const dialog = page.locator(spec.dialog ?? "[role='dialog']").filter({ hasText: re }).first()
      if (!(await dialog.count().catch(() => 0))) continue
      const text = ((await dialog.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
      found.push({ kind: spec.kind ?? 'notice', name: spec.name ?? 'notice', text })

      let closed = false
      if (spec.dismiss) {
        const btn = dialog.locator(spec.dismiss).filter(spec.dismissText ? { hasText: new RegExp(spec.dismissText, 'i') } : {}).first()
        if (await btn.count().catch(() => 0)) {
          await btn.click({ timeout: 5000 }).catch(() => {})
          closed = true
        }
      }
      // Escape is the fallback, not the first choice: a modal that ignores it
      // would otherwise look dismissed and keep eating clicks.
      if (!closed) await page.keyboard.press('Escape').catch(() => {})
      const gone = await waitFor(async () => ((await dialog.count().catch(() => 0)) ? null : true), {
        timeout: 5000,
        poll: this.settings.pollMs,
        what: `the "${spec.name}" notice to close`,
      }).catch(() => false)
      this.log?.warn(
        `the site showed its "${spec.name}" notice${gone ? ' (dismissed)' : ' AND IT WOULD NOT CLOSE - clicks may be blocked'}: ${text}`
      )
    }
    return found
  }

  /**
   * Click something that a reappearing modal keeps covering.
   *
   * THE MODAL COMES BACK. While the rate-limit lock is active the app keeps
   * polling its conversations endpoint, every poll returns 429, and every
   * 429 raises the notice again - so dismissing it once and then clicking is
   * a race that loses about as often as it wins. Measured the hard way: two
   * download runs reported "the site never answered" when the truth was that
   * the click never landed.
   *
   * So: dismiss, click, and if the click is intercepted, dismiss and try
   * again. The error thrown on the last attempt is the real one, not a
   * timeout with the cause hidden.
   */
  async clickThrough(locator, { attempts = 3, timeout = 6000, what = 'a control' } = {}) {
    const page = locator.page()
    let last = null
    for (let i = 1; i <= attempts; i++) {
      const dismissed = await this.dismissNotices(page).catch(() => [])
      // Closing a modal re-renders the page underneath it. Clicking into
      // that re-render is how a click gets accepted and then ignored, so
      // give it a moment - but only when something was actually closed.
      if (dismissed.length) await sleep(600)
      // CENTRE IT FIRST. "Scrolled into view" is not the same as clickable:
      // a link at the bottom of a thread ends up under the sticky composer,
      // and a coordinate click then lands on the composer instead.
      await locator.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {})

      try {
        if (i === 1) {
          await locator.click({ timeout })
        } else {
          // A real click is preferred, but it is impossible while something
          // transparent sits on top - the app's own layout panels do exactly
          // that ("data-side-pane-shell-host ... intercepts pointer events").
          // Dispatching on the element reaches the handler regardless of what
          // is painted above it.
          await locator.evaluate((el) => el.click())
          this.log?.debug(`clicked ${what} on the element itself, because something is covering it`)
        }
        return
      } catch (e) {
        last = e
        const covered = /intercepts pointer events|not stable|element is not visible/i.test(e.message)
        this.log?.debug(`click on ${what} failed (attempt ${i})${covered ? ' - something is covering it' : ''}`)
      }
    }
    throw last
  }

  async assertNoChallenge(page) {
    if (!this.sel.challengeText) return
    const body = await page.locator('body').innerText().catch(() => '')
    const m = body.match(new RegExp(this.sel.challengeText, 'i'))
    // A challenge is for the human to clear in the visible window. We neither
    // solve nor evade one.
    if (m) throw new ChallengeError(this.id, m[0])
  }

  async newConversation(page) {
    const s = this.sel
    if (s.newChatButton && (await count(page, s.newChatButton))) {
      await page.locator(s.newChatButton).first().click({ timeout: 10000 }).catch(() => {})
    } else {
      await page.goto(this.settings.url, { waitUntil: 'domcontentloaded' })
    }
    await page.locator(s.composer).first().waitFor({ state: 'visible', timeout: 30000 })
  }

  async resumeThread(page, threadId) {
    const spec = this.sel.thread
    if (!spec?.urlTemplate || !/^[A-Za-z0-9_-]+$/.test(threadId)) {
      throw new BridgeError(`${this.id}: invalid provider thread id`, { status: 400, code: 'invalid_request' })
    }
    const url = new URL(spec.urlTemplate.replace('{id}', threadId), this.origin).href
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator(this.sel.composer).first().waitFor({ state: 'visible', timeout: this.settings.readyTimeoutMs })

    // VERIFY WE ARE STILL IN THE THREAD. Navigating and finding a composer is
    // not the same as arriving: measured on ChatGPT, a /c/<id> load can land
    // on a blank new chat, whose composer is equally visible. Without this
    // check the caller's message was typed into a BRAND NEW conversation -
    // misattributed, and creating exactly the fresh chats that trip the
    // site's rate limiter. Better to refuse than to write to the wrong place.
    const landed = await this.currentThread(page)
    if (landed !== threadId) {
      const notices = await this.dismissNotices(page).catch(() => [])
      const blocked = notices.map((n) => n.text).join(' | ')
      throw new BridgeError(
        `${this.id}: thread ${threadId} did not open - the site left us on ` +
          `${landed ? `thread ${landed}` : 'a new, empty chat'}` +
          (blocked ? `. It is showing: ${blocked}` : '. Nothing was sent.'),
        { status: 503, code: 'thread_unavailable', retryable: true, detail: { thread_id: threadId, landed, notices } }
      )
    }
  }

  async threadIds(page) {
    if (!this.sel.thread?.urlPattern) return []
    const pattern = this.sel.thread.urlPattern
    return page.locator('a[href]').evaluateAll((links, pattern) => {
      const re = new RegExp(pattern)
      return [...new Set(links.map((a) => {
        try { return new URL(a.href).pathname.match(re)?.[1] ?? null } catch { return null }
      }).filter(Boolean))]
    }, pattern).catch(() => [])
  }

  async currentThread(page, ctx = {}) {
    const current = new URL(page.url())
    if (current.origin !== this.origin || !this.sel.thread?.urlPattern) return null
    const fromUrl = current.pathname.match(new RegExp(this.sel.thread.urlPattern))?.[1] ?? null
    if (fromUrl) return fromUrl
    const before = new Set(ctx.threadIdsBefore ?? [])
    return (await this.threadIds(page)).find((id) => !before.has(id)) ?? null
  }

  async turnCount(page) {
    return count(page, this.sel.responseBlocks)
  }

  async lastResponseText(page) {
    const n = await count(page, this.sel.responseBlocks)
    if (!n) return null
    return readRenderedText(page, { blocks: this.sel.responseBlocks, text: this.sel.responseText }, n - 1)
  }

  async responseTexts(page) {
    const n = await count(page, this.sel.responseBlocks)
    return Promise.all(Array.from({ length: n }, (_, i) =>
      readRenderedText(page, { blocks: this.sel.responseBlocks, text: this.sel.responseText }, i)
    ))
  }

  /**
   * Export the active branch of a thread: every message, in order.
   *
   * The walking, de-duplication and completeness accounting live in
   * ../transports/thread-dom.mjs and know nothing about any provider. What
   * belongs here is only the CONTRACT: which node is a message and which of
   * its attributes carry identity, role and model. That contract is measured
   * per provider and written in its selectors file, because the previous
   * version hardcoded ChatGPT's `data-message-id` in this shared class and
   * would have silently exported nothing on any other provider.
   */
  async exportThread(page, threadId) {
    const contract = this.sel.thread?.export
    if (!contract?.messageNode) {
      throw new BridgeError(
        `${this.id}: thread export is not calibrated for this provider. ` +
          'Measure how its messages are identified in the DOM and add thread.export ' +
          'to its selectors.json - guessing it would export a plausible fragment of a thread.',
        { status: 501, code: 'not_calibrated' }
      )
    }

    // A thread whose history never arrives is its OWN failure, not an empty
    // thread. On ChatGPT the rate-limit lock does exactly this: sending
    // still works while previous conversations stop being served, and
    // reporting "0 messages, complete" for that would be a lie the caller
    // cannot detect.
    try {
      await page
        .locator(contract.messageNode)
        .first()
        .waitFor({ state: 'attached', timeout: this.settings.historyTimeoutMs ?? 60000 })
    } catch {
      const notices = await this.dismissNotices(page).catch(() => [])
      const blocked = notices.map((n) => n.text).join(' | ')
      throw new BridgeError(
        `${this.id}: the thread's history did not load, so it cannot be exported` +
          (blocked ? `. The site is showing: ${blocked}` : '. No message ever appeared.'),
        {
          status: 503,
          code: 'thread_history_unavailable',
          retryable: true,
          detail: { thread_id: threadId, notices },
        }
      )
    }

    const swept = await sweepThread(page, { fileControl: this.sel.generatedFile?.control, ...contract }, {
      settleMs: this.settings.threadSettleMs ?? 400,
      log: this.log,
    })
    if (!swept.complete) {
      this.log?.warn(
        `thread export is INCOMPLETE: top=${swept.evidence.reached_top} bottom=${swept.evidence.reached_bottom} ` +
          `${swept.evidence.message_count} message(s) found - reported as incomplete rather than as the whole thread`
      )
    }
    return {
      provider: this.id,
      thread_id: threadId,
      url: page.url(),
      exported_at: new Date().toISOString(),
      branch: 'active',
      complete: swept.complete,
      evidence: swept.evidence,
      messages: swept.messages,
    }
  }

  // --- controls ------------------------------------------------------------

  /**
   * The picker's own label, which is the only readable state on a 'combined'
   * picker - it reports the model and whether extended thinking is on.
   */
  async pickerLabel(page, { wait = 5000 } = {}) {
    const s = this.sel
    if (!s.modelPicker) return null
    // Wait briefly: count() does not auto-wait, and reading it too early
    // returns nothing for a picker that is merely a few frames late. An empty
    // label then looks like "the wrong model is selected", so we open the
    // menu and try to click the option that is ALREADY active - which the UI
    // marks aria-disabled, so the click can never succeed and the request
    // dies on a 10s click timeout.
    try {
      await waitFor(async () => (await count(page, s.modelPicker)) || null, {
        timeout: wait,
        poll: this.settings.pollMs,
        what: 'the model picker',
      })
    } catch {
      return null
    }
    const el = page.locator(s.modelPicker).first()
    const aria = await el.getAttribute('aria-label').catch(() => null)
    if (aria) return aria
    return el.innerText().catch(() => null)
  }

  /** Authoritative provenance: the picker label after model AND modes. */
  async readState(page) {
    return this.pickerLabel(page)
  }

  async openPicker(page) {
    const s = this.sel
    await this.requireContract(page, 'modelPicker', s.modelPicker)
    await page.locator(s.modelPicker).first().click({ timeout: 10000 })
    await waitFor(() => count(page, s.modelOption), { timeout: 8000, what: 'the model menu to open' })
  }

  async selectModel(page, modelId) {
    const spec = this.sel.models?.[modelId]
    if (!spec) return { requested: modelId, applied: null, verified: false, note: 'unknown model' }

    const verify = new RegExp(spec.verify)
    const before = (await this.pickerLabel(page)) ?? ''
    if (verify.test(before)) return { requested: modelId, applied: before, verified: true, note: 'already active' }

    // Gemini's picker genuinely drops selections - a known bug on their side,
    // where a switch sometimes only takes on a later attempt. So try more
    // than once rather than reporting failure on the first miss.
    const attempts = this.settings.modelSelectAttempts ?? 3
    for (let i = 1; i <= attempts; i++) {
      await this.openPicker(page)
      const option = page.locator(this.sel.modelOption).filter({ hasText: new RegExp(spec.match) }).first()
      if (!(await option.count().catch(() => 0))) {
        await page.keyboard.press('Escape').catch(() => {})
        return { requested: modelId, applied: before || null, verified: false, note: 'option not in menu' }
      }

      // A DISABLED option is the one already in use: Gemini marks the active
      // model aria-disabled. Clicking it is impossible, so treat it as
      // confirmation rather than spending a click timeout failing.
      if ((await option.getAttribute('aria-disabled').catch(() => null)) === 'true') {
        await page.keyboard.press('Escape').catch(() => {})
        const label = await this.pickerLabel(page)
        return {
          requested: modelId,
          applied: label ?? before ?? null,
          verified: true,
          note: 'already active (option disabled)',
        }
      }
      await option.click({ timeout: 10000 })

      // Verify from the UI instead of trusting the click. A picker can accept
      // a click and not change, and a research record needs the model that
      // actually answered - not the one that was asked for.
      try {
        const label = await waitFor(
          async () => {
            const l = await this.pickerLabel(page)
            return l && verify.test(l) ? l : null
          },
          { timeout: 8000, what: `the picker to report ${modelId}` }
        )
        return {
          requested: modelId,
          applied: label,
          verified: true,
          note: i === 1 ? 'verified' : `verified on attempt ${i}`,
        }
      } catch {
        await page.keyboard.press('Escape').catch(() => {})
        if (i < attempts) this.log?.debug(`model switch to ${modelId} did not take (attempt ${i})`)
      }
    }

    // Unverified is reported, never hidden. Answering with a different model
    // than the caller recorded is exactly the kind of silent wrongness a
    // systematic review cannot absorb, so this must be visible in provenance.
    const applied = (await this.pickerLabel(page)) ?? null
    this.log?.warn(
      `requested ${modelId} but the picker still reports "${applied}" after ${attempts} attempts ` +
        '(a known Gemini switching bug) - recorded as unverified'
    )
    return {
      requested: modelId,
      applied,
      verified: false,
      note: `selection not reflected in the UI after ${attempts} attempts`,
    }
  }

  async setMode(page, mode, on) {
    const spec = this.sel.modes?.[mode]
    if (!spec) return { mode, applied: null, verified: false, note: 'unknown mode' }

    const isOn = async () => new RegExp(spec.onLabel, 'i').test((await this.pickerLabel(page)) ?? '')
    if ((await isOn()) === !!on) return { mode, applied: !!on, verified: true, note: 'already set' }

    await this.openPicker(page)
    const item = page.locator(this.sel.modelOption).filter({ hasText: new RegExp(spec.option, 'i') }).first()
    if (!(await item.count().catch(() => 0))) {
      await page.keyboard.press('Escape').catch(() => {})
      return { mode, applied: null, verified: false, note: 'toggle not in menu' }
    }
    if ((await item.getAttribute('aria-disabled').catch(() => null)) === 'true') {
      // Unavailable for the current model (extended thinking is not offered
      // on every one), so report it rather than failing on a dead click.
      await page.keyboard.press('Escape').catch(() => {})
      return { mode, applied: null, verified: false, note: 'toggle disabled for this model' }
    }
    await item.click({ timeout: 10000 })

    try {
      await waitFor(async () => ((await isOn()) === !!on ? true : null), {
        timeout: 8000,
        what: `${mode} to read back as ${on}`,
      })
      return { mode, applied: !!on, verified: true, note: 'verified' }
    } catch {
      return { mode, applied: null, verified: false, note: 'toggle not reflected in the UI' }
    }
  }

  // --- input ---------------------------------------------------------------

  async attach(page, files) {
    const how = this.sel.attachStrategy ?? 'cdp-drag'
    // Where the upload is visible on the network, THAT is the readiness
    // signal: one completed upload-confirmation request per file. Armed
    // before the files are handed over, so none can be missed.
    const uploadPattern = this.sel.wire?.upload
    const uploads = uploadPattern ? (await WireTap.attach(page)).collect(uploadPattern) : null
    try {
      if (how === 'cdp-drag') await this.#attachByDrag(page, files)
      else if (how === 'file-input') await this.#attachByInput(page, files)
      else if (how === 'file-chooser') await this.#attachByChooser(page, files)
      else throw new ContractError(this.id, 'attachStrategy', how)
      if (uploads) {
        const done = await uploads.atLeast(files.length, this.settings.uploadTimeoutMs)
        // A completed call is not the same as a processed file: the stream
        // has to say so (e.g. "file_ready"), or the site may still be
        // extracting text from it when the prompt goes out.
        const ready = this.sel.wire.uploadReady ? new RegExp(this.sel.wire.uploadReady) : null
        const failed = done.filter((u) => !u.ok || (ready && !ready.test(u.body)))
        if (failed.length) {
          throw new BridgeError(
            `${this.id}: ${failed.length} of ${files.length} upload(s) were refused by the site ` +
              `(HTTP ${failed.map((u) => u.status ?? u.error).join(', ')})`,
            { status: 502, code: 'upload_failed', retryable: true }
          )
        }
        this.log?.debug(`${files.length} upload(s) confirmed on the wire`)
      }
      await this.waitForAttachments(page, files.length)
    } finally {
      uploads?.stop()
    }
  }

  /**
   * A TRUSTED drag, dispatched through CDP.
   *
   * A synthetic `new DragEvent(...)` from page context is ignored - tested on
   * Gemini against document, window, body, input-area-v2, input-container,
   * rich-textarea, .ql-editor, chat-window and main: zero attachments every
   * time. CDP produces a real event and takes file PATHS, so a large PDF
   * needs no base64 round-trip.
   */
  async #attachByDrag(page, files) {
    const target = page.locator(this.sel.dropTarget).first()
    const box = await target.boundingBox()
    if (!box) throw new ContractError(this.id, 'dropTarget', this.sel.dropTarget)
    const client = await cdp(page)
    const data = { items: [], files: files.map((f) => resolvePath(f)), dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await client.send('Input.dispatchDragEvent', {
        type,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        data,
      })
    }
  }

  /** The simple case: a real input[type=file] we can set directly. */
  async #attachByInput(page, files) {
    await this.requireContract(page, 'fileInput', this.sel.fileInput)
    await page.locator(this.sel.fileInput).first().setInputFiles(files.map((f) => resolvePath(f)))
  }

  /** A button that opens the OS dialog: intercept the filechooser event. */
  async #attachByChooser(page, files) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.locator(this.sel.uploadButton).first().click({ timeout: 10000 }),
    ])
    await chooser.setFiles(files.map((f) => resolvePath(f)))
  }

  /**
   * Wait until the UI has really registered the files.
   *
   * Never key this off the send button: it is enabled the entire time, so the
   * prompt goes out before the upload lands and the model answers about a
   * file it never received. The chip appearing, and any "uploading" text
   * going away, is the actual signal.
   */
  async waitForAttachments(page, n) {
    const s = this.sel
    if (!s.attachmentChip) return
    const uploading = s.uploadingText ? new RegExp(s.uploadingText, 'i') : null
    await waitFor(
      async () => {
        if ((await count(page, s.attachmentChip)) < n) return null
        if (!uploading) return true
        const scope = s.dropTarget ?? 'body'
        const text = await page.locator(scope).first().innerText().catch(() => '')
        return uploading.test(text) ? null : true
      },
      {
        timeout: this.settings.uploadTimeoutMs,
        poll: this.settings.pollMs,
        what: `${n} attachment(s) to finish uploading`,
      }
    )
    this.log?.debug(`${n} attachment(s) registered`)
  }

  /**
   * Type the prompt and send it - then CHECK that it went.
   *
   * A click on the send button is not proof of submission. If the composer
   * had lost focus, insertText goes nowhere and the click submits an empty
   * box: no turn is ever created, and the request then sits in
   * awaitCompletion until its timeout. That produced a 600s hang whose log
   * line ("waiting for a response turn to appear") described the symptom and
   * said nothing about the cause.
   *
   * The composer emptying is the observable confirmation, so verify it and
   * retry once before giving up.
   */
  async submit(page, prompt, ctx = {}) {
    const s = this.sel
    const composer = page.locator(s.composer).first()

    // ARM THE WIRE BEFORE TYPING. On a wired provider the answer is read
    // from the response the page receives, and a tap armed after the click
    // can only see the next request. It also gives a stronger proof of
    // submission than an emptied composer: the request actually went out.
    if (this.wired) ctx.wire = (await WireTap.attach(page)).expect(s.wire.answer)

    const type = async () => {
      await composer.click()
      await page.keyboard.insertText(prompt)
      const typed = ((await composer.innerText().catch(() => '')) ?? '').trim()
      if (!typed) throw new BridgeError('the prompt did not reach the composer', {
        status: 502,
        code: 'compose_failed',
        retryable: true,
      })
    }
    const fire = async () => {
      if (s.submitKey) return composer.press(s.submitKey)
      await this.requireContract(page, 'sendButton', s.sendButton)
      // Through any blocking notice: the rate-limit modal covers the
      // composer too, and a swallowed send presents as "no turn appeared".
      await this.clickThrough(page.locator(s.sendButton).first(), { timeout: 15000, what: 'the send button' })
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      await type()
      await fire()
      try {
        if (ctx.wire) {
          await ctx.wire.request(8000)
          return
        }
        // Submission clears the composer. Seconds, not minutes - if it has
        // not happened by now it is not going to.
        await waitFor(
          async () => {
            const left = ((await composer.innerText().catch(() => '')) ?? '').trim()
            return left ? null : true
          },
          { timeout: 8000, poll: this.settings.pollMs, what: 'the composer to clear after sending' }
        )
        return
      } catch {
        if (attempt === 2) {
          throw new BridgeError(
            `${this.id}: the prompt was typed but never submitted - the composer still holds it`,
            { status: 502, code: 'submit_failed', retryable: true }
          )
        }
        this.log?.warn('send did not take; retrying once')
      }
    }
  }

  // --- completion ----------------------------------------------------------

  /**
   * Done means ALL of: a new turn exists, its text stopped changing, the text
   * is not a placeholder, and the stop control is gone.
   *
   * Each condition alone is insufficient. Text stability alone fires during a
   * pause mid-stream. The stop control alone flickers. Ignoring placeholders
   * returns "Searching the internet" as the model's answer.
   */
  async awaitCompletion(page, ctx) {
    const s = this.sel
    const cfg = this.settings
    const before = ctx.turnsBefore ?? 0

    if (ctx.wire && (await this.#awaitWire(ctx))) return ctx

    // A turn appears within a second or two of a real submission, so this
    // gets its OWN short budget rather than the full response timeout.
    // Waiting ten minutes to discover nothing was ever sent tells you
    // nothing; failing in one, retryably, tells you plenty.
    const responseProbe = async () => {
        const texts = await this.responseTexts(page)
        const prior = ctx.responseTextsBefore ?? []
        // The history may be virtualized, inserted at either end, or keep a
        // fixed number of DOM nodes. Attribute the response to the block
        // whose content actually changed, rather than deriving an index from
        // a count that can race with history hydration.
        for (let i = texts.length - 1; i >= 0; i--) {
          if (texts[i] !== (prior[i] ?? '') && (texts[i] || texts.length > prior.length)) return { total: texts.length, index: i }
        }
        return null
      }
    let acknowledged
    try {
      acknowledged = await waitFor(responseProbe, {
        timeout: cfg.submitAckMs ?? 60000, poll: cfg.pollMs, what: 'a response turn to appear',
      })
    } catch (e) {
      if (!(e instanceof TimeoutError) || !(await isGenerating(page, s.stopButton))) throw e
      // Thinking models can acknowledge the request (composer cleared and a
      // stop control appeared) long before they expose an assistant block.
      // That is live progress, not a failed submit, so give it the response
      // budget. A genuinely wedged turn still ends in a typed timeout.
      this.log?.debug('request is still generating without an answer block; extending to the response timeout')
      acknowledged = await waitFor(responseProbe, {
        timeout: cfg.responseTimeoutMs, poll: cfg.pollMs, what: 'a thinking model to expose its response',
      })
    }
    ctx.index = acknowledged.index

    const transient = (s.transientText ?? []).map((t) => new RegExp(t, 'i'))
    const searchRe = s.searchTransient ? new RegExp(s.searchTransient, 'i') : null
    ctx.browsedHint = false

    const usable = (t) => !!t && !(t.trim().length <= 64 && transient.some((re) => re.test(t)))
    try {
      await waitStable(
        async () => {
          const t = await readRenderedText(page, { blocks: s.responseBlocks, text: s.responseText }, ctx.index)
          if (searchRe && searchRe.test(t)) ctx.browsedHint = true
          return t
        },
        {
          checks: cfg.settleChecks,
          timeout: cfg.responseTimeoutMs,
          poll: cfg.pollMs,
          what: 'the answer to finish',
          // A placeholder IS the whole content at that moment ("Searching the
          // internet", "Thinking"), so only treat SHORT text as one.
          accept: usable,
        }
      )
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e
      const partial = await readRenderedText(page, { blocks: s.responseBlocks, text: s.responseText }, ctx.index)
      if (!usable(partial)) throw e
      ctx.truncated = true
      this.log?.warn(`response timeout after usable text appeared; returning ${partial.length} chars as truncated`)
    }

    if (await isGenerating(page, s.stopButton)) {
      await waitFor(async () => !(await isGenerating(page, s.stopButton)), {
        timeout: cfg.responseTimeoutMs,
        poll: cfg.pollMs,
        what: 'generation to stop',
      }).catch((e) => {
        // Stability already said the text was final; a stop control that
        // lingers should not fail an otherwise complete answer.
        if (!(e instanceof TimeoutError)) throw e
        ctx.truncated = true
        this.log?.warn('the answer text stabilized but the generating control did not clear; returning it as truncated')
      })
    }
    return ctx
  }

  /**
   * Completion on the wire: the response connection closes.
   *
   * Returns true when a usable answer was decoded, false to let the DOM path
   * take over. A refusal from the site (a 4xx/5xx on the request) is thrown
   * here, because then no message was generated for anyone to read.
   */
  async #awaitWire(ctx) {
    const cfg = this.settings
    let lastProgress = ''
    const res = await ctx.wire.finished(cfg.responseTimeoutMs, (partial) => {
      if (!ctx.onProgress || !partial?.body) return
      const decoded = decodeDeltaStream(partial.body)
      if (!decoded.text || decoded.text === lastProgress) return
      lastProgress = decoded.text
      ctx.onProgress(decoded.text)
    })
    if (!res.ok && res.status && !(res.body && res.body.includes('data:'))) {
      let detail = res.body.slice(0, 300)
      try {
        const j = JSON.parse(res.body)
        detail = j?.detail?.message ?? j?.detail ?? j?.error?.message ?? detail
      } catch {}
      const limited = res.status === 429
      throw new BridgeError(
        `${this.id}: the site ${limited ? 'rate-limited' : 'refused'} the request with HTTP ${res.status}: ` +
          `${typeof detail === 'string' ? detail : JSON.stringify(detail)}` +
          (limited ? '. Wait a few minutes; raise minIntervalMs in config.json for this provider.' : ''),
        { status: limited ? 429 : 502, code: limited ? 'rate_limited' : 'upstream_refused', retryable: limited || res.status >= 500, detail: { status: res.status } }
      )
    }
    const decoded = decodeDeltaStream(res.body)
    // What the UI put in its own request - the model field it chose from
    // the picker state. Independent of the answer and of the picker label.
    let sentAs = null
    let sentEffort = null
    try {
      const body = await ctx.wire.sentBody()
      const j = body ? JSON.parse(body) : null
      sentAs = j?.model ?? null
      // Named by the provider contract, because the field is the site's own
      // vocabulary (ChatGPT: thinking_effort = standard | extended).
      const effortField = this.sel.wire.effortField
      sentEffort = effortField && j ? j[effortField] ?? null : null
    } catch {}
    ctx.wireResult = { res, decoded, sentAs, sentEffort }
    if (decoded.text) {
      if (res.error) this.log?.warn(`the response connection ended with "${res.error}"; the answer may be cut short`)
      return true
    }
    this.log?.warn(
      `the wire carried no assistant text (${res.bytes} bytes, ${decoded.frames} frames` +
        `${res.error ? `, ${res.error}` : ''}); reading the page instead`
    )
    return false
  }

  // --- output --------------------------------------------------------------

  async extract(page, ctx) {
    const s = this.sel
    const cfg = this.settings

    if (ctx.wireResult?.decoded?.text) return this.#extractWire(page, ctx)

    // THREE TIERS, best first. The reason there are three is that the best
    // one depends on the system clipboard, which can fail on its own: on this
    // machine every clipboard write reported success while every read came
    // back empty, and PowerShell's Get-Clipboard failed at the same moment.
    // With innerText as the only fallback, such an outage silently turns
    // every table into tab-separated text - plausible-looking and wrong.
    //   copy         the provider's own canonical markdown
    //   dom-markdown rebuilt from the elements: tables, fences, lists survive
    //   rendered     innerText, structure lost - last resort
    const rendered = await readRenderedText(page, { blocks: s.responseBlocks, text: s.responseText }, ctx.index)
    const copied = await copyMarkdown(page, s, {
      expectLen: rendered.length,
      rendered,
      pollMs: cfg.pollMs,
      log: this.log,
    })

    let text = copied
    let extraction = 'copy'
    let lossyMath = false
    if (!text) {
      const rebuilt = await reconstructMarkdown(
        page,
        { blocks: s.responseBlocks, text: s.responseText },
        ctx.index
      )
      if (rebuilt?.text) {
        text = rebuilt.text
        extraction = 'dom-markdown'
        lossyMath = rebuilt.lossyMath
        this.log?.warn('clipboard unavailable; rebuilt markdown from the DOM (maths may be lossy)')
      }
    }
    if (!text) {
      text = rendered
      extraction = 'rendered'
      this.log?.warn('falling back to innerText - table and code structure is lost')
    }

    // A provider's OWN failure arrives as an ordinary assistant message
    // ("Sorry, something went wrong. Please try your request again.").
    //
    // That is still a message the UI produced and this bridge retrieved, so
    // it is DELIVERED, not thrown: whether a "something went wrong" turn is
    // fatal, worth retrying, or simply logged is the caller's policy, not
    // ours. It is flagged so that policy can be written without regex-ing
    // the text downstream.
    const providerError =
      !!s.errorText && new RegExp(s.errorText, 'i').test(text) && text.length < 400
    if (providerError) {
      this.log?.warn(`the UI answered with its own error message: "${text.trim().slice(0, 90)}"`)
    }

    const files = await this.generatedFiles(page, ctx, text)

    const { browsed, searched, sources } = await this.collectSources(page, ctx)

    return {
      text,
      // Which tier produced this, so a caller can judge the text rather than
      // guess. `markdown` stays for compatibility: true when the text is
      // real markdown, whichever tier built it.
      extraction,
      markdown: extraction !== 'rendered',
      lossy_math: lossyMath,
      // The text is the provider's own error notice rather than an answer.
      // Delivered anyway; the caller decides what that means.
      provider_error: providerError,
      tables: parseTables(text),
      code_blocks: parseCodeBlocks(text),
      files,
      sources,
      browsed,
      searched,
      truncated: !!ctx.truncated,
    }
  }

  /**
   * Files the PROVIDER generated, downloaded to disk.
   *
   * A hook, because the two providers expose them in genuinely different
   * ways: Gemini behind a viewer overlay in the DOM, ChatGPT as a link the
   * page fetches with its own credentials. Default is the DOM path; a
   * provider whose files are readable on the network overrides it.
   */
  async generatedFiles(page, ctx, _text) {
    const s = this.sel
    const cfg = this.settings
    if (!s.generatedFile?.chip) return []
    return downloadGeneratedFiles(page, s.generatedFile, {
      dir: cfg.downloadDir,
      waitMs: cfg.fileWaitMs,
      pollMs: cfg.pollMs,
      log: this.log,
    })
  }

  /**
   * The answer as the server sent it. No clipboard, no DOM, no guessing
   * which tier produced the text: this IS the model's markdown.
   */
  async #extractWire(page, ctx) {
    const s = this.sel
    const { res, decoded } = ctx.wireResult
    const text = decoded.text
    const providerError = !!s.errorText && new RegExp(s.errorText, 'i').test(text) && text.length < 400
    if (providerError) this.log?.warn(`the site answered with its own error message: "${text.trim().slice(0, 90)}"`)
    return {
      text,
      extraction: 'wire',
      markdown: true,
      lossy_math: false,
      provider_error: providerError,
      tables: parseTables(text),
      code_blocks: parseCodeBlocks(text),
      files: await this.generatedFiles(page, ctx, text),
      // Sources are everything the turn consulted; citations are the ones
      // the answer actually leans on, each with the offset in `text` where
      // the claim is made.
      sources: decoded.sources,
      citations: decoded.citations,
      browsed: decoded.citations.length > 0,
      searched: decoded.sources.length > 0,
      unresolved_citations: decoded.unresolved_markers,
      model_slug: decoded.model,
      sent_as: ctx.wireResult.sentAs,
      sent_effort: ctx.wireResult.sentEffort,
      conversation_id: decoded.conversationId,
      // A stream that ended without [DONE] was cut off, and the text is
      // whatever had arrived. Reported, never hidden.
      truncated: !decoded.finished || !!res.error,
    }
  }

  /**
   * Citations. Where a provider hides them behind a menu, follow the menu:
   * body chips alone are not the real list.
   *
   * `browsed` reports what the UI actually did, not what the prompt asked
   * for - providers routinely answer from their own weights despite being
   * told to search, and a pipeline must be able to tell the difference.
   */
  async collectSources(page, ctx) {
    const s = this.sel
    if (!s.sourceChip) return { browsed: false, searched: false, sources: [] }

    // Two DIFFERENT facts, and conflating them made the bridge claim
    // citations that did not exist:
    //   searched - the "Searching the internet" placeholder appeared, so a
    //              search was ATTEMPTED
    //   browsed  - the response actually carries citations
    // A response can search and still answer from its own weights: measured
    // directly, one such reply had zero inline chips AND no "View sources"
    // entry in its menu (which held only Branch in new chat, Listen, Export
    // to Docs, Draft in Gmail, Report legal issue, See response details).
    // Only chips and the sources menu are authoritative.
    const searched = !!ctx.browsedHint
    const chips = await count(page, s.sourceChip)
    if (!s.moreButton || !s.viewSourcesItem) return { browsed: chips > 0, searched, sources: [] }
    if (!chips && !searched) return { browsed: false, searched, sources: [] }

    const block = page.locator(s.responseBlocks).nth(ctx.index)
    const more = block.locator(s.moreButton).first()
    if (!(await more.count().catch(() => 0))) return { browsed: chips > 0, searched, sources: [] }

    await more.click({ timeout: 8000 }).catch(() => {})
    const item = page.locator(s.viewSourcesItem).first()
    if (!(await item.count().catch(() => 0))) {
      // No sources entry means this response has no citations, whatever the
      // placeholder suggested during generation.
      await page.keyboard.press('Escape').catch(() => {})
      return { browsed: chips > 0, searched, sources: [] }
    }
    await item.click({ timeout: 8000 }).catch(() => {})
    const browsed = true

    const links = await page
      .locator(s.sourcePanelLink)
      .evaluateAll((els) => els.map((e) => ({ url: e.href, title: (e.innerText || '').trim().slice(0, 200) })))
      .catch(() => [])
    await page.keyboard.press('Escape').catch(() => {})

    const ignore = s.sourceIgnoreHosts ?? []
    const seen = new Set()
    const sources = links.filter((l) => {
      if (!l.url || ignore.some((h) => l.url.includes(h))) return false
      if (seen.has(l.url)) return false
      seen.add(l.url)
      return true
    })
    return { browsed, searched, sources }
  }

  /**
   * Assert a selector still matches - but WAIT before concluding it does not.
   *
   * count() does not auto-wait. Reading it the instant a fresh conversation
   * renders reports zero for controls that are merely a few frames late, and
   * that misreads a timing race as "the UI changed" - the exact confusion
   * that sent me hunting for three phantom selector bugs in the prototype.
   * So a contract violation means "absent even after waiting".
   */
  async requireContract(page, key, sel, timeout = 8000) {
    if (!sel) throw new ContractError(this.id, key, '(unset)')
    try {
      await waitFor(async () => (await count(page, sel)) || null, {
        timeout,
        poll: this.settings.pollMs,
        what: `${key} to appear`,
      })
    } catch {
      throw new ContractError(this.id, key, sel)
    }
  }
}
