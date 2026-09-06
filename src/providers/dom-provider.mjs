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
import { ChallengeError, ContractError, SignedOutError, TimeoutError } from '../core/errors.mjs'
import { waitFor, waitStable } from '../core/async.mjs'
import { parseCodeBlocks, parseTables } from '../core/markdown.mjs'
import {
  copyMarkdown,
  count,
  downloadGeneratedFiles,
  isGenerating,
  readRenderedText,
} from '../transports/dom.mjs'

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
  async pickerLabel(page) {
    const s = this.sel
    if (!s.modelPicker || !(await count(page, s.modelPicker))) return null
    const el = page.locator(s.modelPicker).first()
    const aria = await el.getAttribute('aria-label').catch(() => null)
    if (aria) return aria
    return el.innerText().catch(() => null)
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

    await this.openPicker(page)
    const option = page.locator(this.sel.modelOption).filter({ hasText: new RegExp(spec.match) }).first()
    if (!(await option.count().catch(() => 0))) {
      await page.keyboard.press('Escape').catch(() => {})
      return { requested: modelId, applied: before || null, verified: false, note: 'option not in menu' }
    }
    await option.click({ timeout: 10000 })

    // Verify from the UI instead of trusting the click. A picker can accept a
    // click and not change, and a research record needs the model that
    // actually answered - not the one we asked for.
    try {
      const label = await waitFor(
        async () => {
          const l = await this.pickerLabel(page)
          return l && verify.test(l) ? l : null
        },
        { timeout: 8000, what: `the picker to report ${modelId}` }
      )
      return { requested: modelId, applied: label, verified: true, note: 'verified' }
    } catch {
      return {
        requested: modelId,
        applied: (await this.pickerLabel(page)) ?? null,
        verified: false,
        note: 'selection not reflected in the UI',
      }
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

  async submit(page, prompt) {
    const s = this.sel
    const composer = page.locator(s.composer).first()
    await composer.click()
    await page.keyboard.insertText(prompt)

    if (s.submitKey) {
      await composer.press(s.submitKey)
      return
    }
    await this.requireContract(page, 'sendButton', s.sendButton)
    await page.locator(s.sendButton).first().click({ timeout: 15000 })
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

    const total = await waitFor(
      async () => {
        const n = await count(page, s.responseBlocks)
        return n > before ? n : null
      },
      { timeout: cfg.responseTimeoutMs, poll: cfg.pollMs, what: 'a response turn to appear' }
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
        accept: (t) => !!t && !transient.some((re) => re.test(t)),
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

    const rendered = await readRenderedText(page, { blocks: s.responseBlocks, text: s.responseText }, ctx.index)
    const copied = await copyMarkdown(page, s, { expectLen: rendered.length, pollMs: cfg.pollMs, log: this.log })
    const text = copied ?? rendered

    const files = s.generatedFile
      ? await downloadGeneratedFiles(page, s.generatedFile, {
          dir: cfg.downloadDir,
          waitMs: cfg.fileWaitMs,
          pollMs: cfg.pollMs,
          log: this.log,
        })
      : []

    const { browsed, sources } = await this.collectSources(page, ctx)

    return {
      text,
      markdown: !!copied,
      tables: parseTables(text),
      code_blocks: parseCodeBlocks(text),
      files,
      sources,
      browsed,
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
    if (!s.sourceChip) return { browsed: false, sources: [] }

    const chips = await count(page, s.sourceChip)
    const browsed = chips > 0 || !!ctx.browsedHint
    if (!browsed || !s.moreButton || !s.viewSourcesItem) return { browsed, sources: [] }

    const block = page.locator(s.responseBlocks).nth(ctx.index)
    const more = block.locator(s.moreButton).first()
    if (!(await more.count().catch(() => 0))) return { browsed, sources: [] }

    await more.click({ timeout: 8000 }).catch(() => {})
    const item = page.locator(s.viewSourcesItem).first()
    if (!(await item.count().catch(() => 0))) {
      await page.keyboard.press('Escape').catch(() => {})
      return { browsed, sources: [] }
    }
    await item.click({ timeout: 8000 }).catch(() => {})

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
    return { browsed, sources }
  }

  async requireContract(page, key, sel) {
    if (!sel || !(await count(page, sel))) throw new ContractError(this.id, key, sel ?? '(unset)')
  }
}
