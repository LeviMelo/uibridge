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
import { waitFor, waitStable } from '../core/async.mjs'
import { parseCodeBlocks, parseTables } from '../core/markdown.mjs'
import {
  copyMarkdown,
  count,
  downloadGeneratedFiles,
  isGenerating,
  readRenderedText,
} from '../transports/dom.mjs'
import { reconstructMarkdown } from '../transports/markdown-dom.mjs'

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
      generatedFiles: !!s.generatedFile?.chip,
      citations: !!s.sourceChip,
      transports: ['dom'],
    })
  }

  // --- lifecycle -----------------------------------------------------------

  async open(page) {
    const { url, readyTimeoutMs } = this.settings
    if (page.url() === 'about:blank' || !page.url().startsWith(url.split('?')[0])) {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
    }
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
        throw new SignedOutError(this.id)
      }
    }
  }

  async isSignedIn(page) {
    const s = this.sel
    // A rendered composer proves nothing: an anonymous session shows one too,
    // and every request then runs against no account at all.
    if (s.accountMarker && (await count(page, s.accountMarker))) return true
    if (!s.signedOutMarker) return true
    const body = await page.locator('body').innerText().catch(() => '')
    return !new RegExp(s.signedOutMarker, 'i').test(body)
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

  async turnCount(page) {
    return count(page, this.sel.responseBlocks)
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
    if (how === 'cdp-drag') await this.#attachByDrag(page, files)
    else if (how === 'file-input') await this.#attachByInput(page, files)
    else if (how === 'file-chooser') await this.#attachByChooser(page, files)
    else throw new ContractError(this.id, 'attachStrategy', how)
    await this.waitForAttachments(page, files.length)
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
  async submit(page, prompt) {
    const s = this.sel
    const composer = page.locator(s.composer).first()

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
      await page.locator(s.sendButton).first().click({ timeout: 15000 })
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      await type()
      await fire()
      try {
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

    // A turn appears within a second or two of a real submission, so this
    // gets its OWN short budget rather than the full response timeout.
    // Waiting ten minutes to discover nothing was ever sent tells you
    // nothing; failing in one, retryably, tells you plenty.
    const total = await waitFor(
      async () => {
        const n = await count(page, s.responseBlocks)
        return n > before ? n : null
      },
      { timeout: cfg.submitAckMs ?? 60000, poll: cfg.pollMs, what: 'a response turn to appear' }
    )
    ctx.index = total - 1

    const transient = (s.transientText ?? []).map((t) => new RegExp(t, 'i'))
    const searchRe = s.searchTransient ? new RegExp(s.searchTransient, 'i') : null
    ctx.browsedHint = false

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
        // internet", "Thinking"), so only treat SHORT text as one. Matching
        // these words anywhere rejects a real answer forever: with extended
        // thinking on, the response block carries its own "Show thinking"
        // control, so every read looked transient and the request sat until
        // the 600s timeout even though the answer was complete on screen.
        accept: (t) => !!t && !(t.trim().length <= 64 && transient.some((re) => re.test(t))),
      }
    )

    if (await isGenerating(page, s.stopButton)) {
      await waitFor(async () => !(await isGenerating(page, s.stopButton)), {
        timeout: cfg.responseTimeoutMs,
        poll: cfg.pollMs,
        what: 'generation to stop',
      }).catch((e) => {
        // Stability already said the text was final; a stop control that
        // lingers should not fail an otherwise complete answer.
        if (!(e instanceof TimeoutError)) throw e
      })
    }
    return ctx
  }

  // --- output --------------------------------------------------------------

  async extract(page, ctx) {
    const s = this.sel
    const cfg = this.settings

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

    const files = s.generatedFile
      ? await downloadGeneratedFiles(page, s.generatedFile, {
          dir: cfg.downloadDir,
          waitMs: cfg.fileWaitMs,
          pollMs: cfg.pollMs,
          log: this.log,
        })
      : []

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
