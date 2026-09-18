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
import { currentSignal, withCancellation } from '../core/cancel.mjs'
import { parseCodeBlocks, parseTables } from '../core/markdown.mjs'
import {
  copyMarkdown,
  count,
  downloadFromPreview,
  downloadGeneratedFiles,
  isGenerating,
  readRenderedText,
} from '../transports/dom.mjs'
import { reconstructMarkdown } from '../transports/markdown-dom.mjs'
import { sweepThread, mountMessage } from '../transports/thread-dom.mjs'
import { WireTap } from '../transports/wire.mjs'
import { nudgeOnScreen } from '../core/window.mjs'
import { fillComposer, normalizeComposerText, readComposer } from '../core/composer.mjs'
import { captureDownload, previewProgressed } from '../transports/files-wire.mjs'
import { cardFor, cardNames, downloadFromCard } from '../transports/file-card.mjs'
import { classifyAnswer, errorPatterns } from '../core/answer-integrity.mjs'
import { decodeDeltaStream } from '../transports/sse-openai.mjs'
import { UploadWatch, refusedUploads, uploadRefused } from '../transports/uploads.mjs'

/** The default `wireStallMs` (see config.mjs), and what its expiry yields. */
const WIRE_STALL_MS = 60000
const STREAM_UNSEEN = Symbol('the answer stream was never seen to end')

/**
 * True when a decoded response stream is not the whole turn: it ended
 * without its finish marker and the page still shows the turn generating.
 * Either alone is not it - a finished stream can leave a lingering stop
 * control, and an unfinished one on a quiet page is a genuine cut-off.
 */
export function wireContinues(decoded, generating) {
  return !!decoded && !decoded.finished && !!generating
}

/**
 * Is the page asking which of two candidate responses is preferred?
 *
 * ChatGPT sometimes answers one turn with two candidates and asks the
 * reader to choose (REPORTED 2026-09-17; the wording is in the provider's
 * selectors, where only OBSERVED locales are listed). Until a choice is
 * made the turn is not committed and the composer refuses the next prompt,
 * so the whole thread is wedged and not merely this request.
 *
 * `pattern` is the provider's own; with none configured this is always
 * false, because a provider whose wording nobody has read must not be
 * matched by a pattern invented here (AGENTS.md).
 */
export function showsResponseComparison(bodyText, pattern) {
  if (!pattern || !bodyText) return false
  return new RegExp(pattern, 'i').test(bodyText)
}

const cdpSessions = new WeakMap()
async function cdp(page) {
  if (!cdpSessions.has(page)) cdpSessions.set(page, await page.context().newCDPSession(page))
  return cdpSessions.get(page)
}

export class DomProvider extends Provider {
  static #fileCollectors = new WeakMap()

  // One request's attachments, carried from attach() to submit() and
  // awaitCompletion(): session.mjs builds a provider per attempt, so this is
  // per request. `#uploads` is the watch over uploads still in flight when
  // the prompt goes out; `#uploadStamps` are transport_timing entries the
  // waiting flow records before any request context exists.
  #uploads = null
  #uploadStamps = {}

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
   * A standing collector for generated-file bytes, armed once per tab.
   *
   * The bytes of a generated file can cross the wire at moments nobody
   * chose: MEASURED on ChatGPT, simply opening a conversation pre-fetches
   * its artifact during page load. A capture armed at click time therefore
   * misses precisely the copy that exists. This collector is installed the
   * first time a tab is used for files and keeps every matching response, so
   * retrieval becomes "take the bytes we already have, or click and wait for
   * them" instead of "click and hope a request follows".
   */
  fileBytes(tap) {
    const g = this.sel.generatedFile
    if (!g?.contentPattern) return null
    if (!DomProvider.#fileCollectors.has(tap)) {
      DomProvider.#fileCollectors.set(tap, tap.collect(g.contentPattern))
      this.log?.debug('watching for generated-file bytes on this tab')
    }
    return DomProvider.#fileCollectors.get(tap)
  }

  /**
   * Is this answer really an answer? See core/answer-integrity.mjs.
   *
   * Kept in one place because both extraction tiers need the same verdict,
   * and because the previous copy-paste meant a fix to one path silently
   * left the other wrong.
   */
  classifyAnswer(text) {
    const verdict = classifyAnswer(text, {
      patterns: errorPatterns(this.sel, this.settings),
      maxChars: this.settings.errorNoticeMaxChars ?? 400,
    })
    if (verdict.error) {
      this.log?.warn(`the UI answered with its own error message: "${String(text).trim().slice(0, 90)}"`)
    } else if (verdict.suspected) {
      this.log?.warn(
        `this answer opens like a provider failure but matches no measured pattern, so it is ` +
          `reported as SUSPECTED rather than treated as one: "${String(text).trim().slice(0, 90)}". ` +
          `If it is a real failure notice, add its wording to providers.${this.id}.errorTextExtra.`
      )
    }
    return verdict
  }

  /**
   * Find, report and (safely) close the site's blocking notices.
   *
   * A spec may match by TEXT (`match`), which is how ChatGPT's rate-limit
   * modal is recognised, or STRUCTURALLY (no `match`), which is how a
   * provider whose notice wording has never been observed still gets
   * coverage. Inventing the wording would be worse than admitting we have
   * not seen it: a made-up pattern silently matches nothing, and the caller
   * is told "no notice" while a modal eats every click.
   *
   * Structural specs classify the text they find with `classify`, and
   * anything unrecognised is reported as `kind: 'unknown'` rather than
   * squeezed into a category.
   *
   * SAFETY: with a structural spec, ANY dialog matches - including one
   * asking whether to delete a conversation. So a button is only ever
   * clicked when its own label matches `dismissText`; otherwise the only
   * gesture used is Escape, which cannot confirm anything.
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
      const re = spec.match ? new RegExp(spec.match, 'i') : null
      const all = page.locator(spec.dialog ?? "[role='dialog']")
      const base = re ? all.filter({ hasText: re }) : all

      // Only a VISIBLE overlay is a notice. Angular and React apps keep
      // detached dialog containers in the tree, and reporting those as
      // notices would cry wolf on every request.
      let dialog = null
      const n = await base.count().catch(() => 0)
      for (let i = 0; i < n; i++) {
        const candidate = base.nth(i)
        if (await candidate.isVisible().catch(() => false)) { dialog = candidate; break }
      }
      if (!dialog) continue

      const text = ((await dialog.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
      if (!text) continue
      const kind = classifyNotice(spec, text)

      // A TRANSIENT IS NOT A NOTICE. MEASURED 2026-09-08: clicking Gemini's
      // Copy button - which this provider does on every turn, because it is
      // how the original markdown is obtained - raises
      // <mat-snack-bar-container> "Copied to clipboard", which this spec
      // matched structurally. It has no buttons, blocks nothing, and vanishes
      // in under 4s. Treating it as a notice reported a phantom to the
      // caller, pressed Escape at the page (a real gesture, aimed at nothing),
      // and then spent up to five seconds waiting for a toast to go away.
      // Specs that can match a transient container say `reportUnknown: false`
      // and are believed only when `classify` recognises the wording.
      if (kind === 'unknown' && spec.reportUnknown === false) continue
      found.push({ kind, name: spec.name ?? 'notice', text })

      let closed = false
      if (spec.dismiss) {
        const btn = dialog.locator(spec.dismiss).filter(spec.dismissText ? { hasText: new RegExp(spec.dismissText, 'i') } : {}).first()
        if (await btn.count().catch(() => 0)) {
          await btn.click({ timeout: 5000 }).catch(() => {})
          closed = true
        }
      }
      // Escape is the fallback, not the first choice: a modal that ignores it
      // would otherwise look dismissed and keep eating clicks. A spec that
      // describes something non-blocking opts out: pressing Escape at the
      // page to chase a toast can close a menu the caller opened.
      if (!closed && spec.escape !== false) await page.keyboard.press('Escape').catch(() => {})
      const gone = await waitFor(async () => ((await dialog.isVisible().catch(() => false)) ? null : true), {
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
  async clickThrough(locator, { attempts = 3, timeout = 6000, what = 'a control', scroll = true } = {}) {
    const page = locator.page()
    let last = null
    // Any notice that was up while a click failed is a candidate explanation,
    // not just a throttling one.
    let blocking = null
    for (let i = 1; i <= attempts; i++) {
      const dismissed = await this.dismissNotices(page).catch(() => [])
      blocking = dismissed[0] ?? blocking
      // Closing a modal re-renders the page underneath it. Clicking into
      // that re-render is how a click gets accepted and then ignored, so
      // give it a moment - but only when something was actually closed.
      if (dismissed.length) await sleep(600)
      // CENTRE IT FIRST. "Scrolled into view" is not the same as clickable:
      // a link at the bottom of a thread ends up under the sticky composer,
      // and a coordinate click then lands on the composer instead.
      //
      // NOT FOR A CONTROL THAT LIVES IN THE STICKY CHROME. MEASURED
      // 2026-09-17 on ChatGPT: with a file attached and a prompt of more
      // than a few lines the composer is tall enough to scroll, and centring
      // its send button scrolls that inner region; the click that follows
      // is accepted by the browser and ignored by the app, on every attempt,
      // and the request ends `submit_failed` with the prompt still in the
      // composer. The same click without the scroll submits at once. A
      // caller whose control is always on screen says `scroll: false`.
      if (scroll) {
        await locator.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {})
      }

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
    // NAME THE REAL CAUSE. When one of the site's notices was up on any
    // attempt, "locator.click: Timeout 10000ms exceeded" is a true statement
    // about the wrong thing: the modal is dismissed, the app re-raises it,
    // and the click never lands.
    //
    // IT IS NOT AN ACCOUNT LIMIT, and this used to say it was. ChatGPT's
    // "Excesso de solicitações" modal is a data-protection measure that
    // stops PREVIOUS CONVERSATIONS being served; it is dismissible, sending
    // is unaffected, and you can carry on. Reporting it as HTTP 429 "wait a
    // few minutes" told callers to back off from something they could simply
    // click past - and made a transient overlay look like a quota.
    if (blocking) {
      throw new BridgeError(
        `${this.id}: the site's "${blocking.name}" notice kept covering ${what} - it was dismissed on each of ` +
          `${attempts} attempts and came straight back. It says: ${blocking.text.slice(0, 160)}` +
          (blocking.kind === 'rate_limit'
            ? '. This notice restricts access to previous conversations, not sending, so a retry usually succeeds.'
            : ''),
        { status: 503, code: 'notice_blocking', retryable: true, detail: { notice: blocking.text.slice(0, 240), kind: blocking.kind, control: what } }
      )
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
    const fresh = async () => !(await this.currentThread(page)) && (await this.turnCount(page)) === 0
    if (s.newChatButton && (await count(page, s.newChatButton))) {
      await page.locator(s.newChatButton).first().click({ timeout: 10000 }).catch(() => {})
    }
    try {
      await waitFor(fresh, { timeout: 3000, poll: this.settings.pollMs, what: 'a fresh conversation' })
    } catch {
      await page.goto(this.settings.url, { waitUntil: 'domcontentloaded' })
    }
    await this.requireComposer(page, { timeout: 30000, where: 'on a new conversation' })
    await waitFor(fresh, { timeout: 10000, poll: this.settings.pollMs, what: 'a verified empty conversation' })
  }

  async resumeThread(page, threadId) {
    const spec = this.sel.thread
    if (!spec?.urlTemplate || !/^[A-Za-z0-9_-]+$/.test(threadId)) {
      throw new BridgeError(`${this.id}: invalid provider thread id`, { status: 400, code: 'invalid_request' })
    }
    const url = new URL(spec.urlTemplate.replace('{id}', threadId), this.origin).href
    // ARM BEFORE NAVIGATING. Opening a conversation is itself what makes the
    // app fetch that conversation's generated files, so a collector installed
    // after this line would be installed after the only copy of the bytes
    // went past. Idempotent: one collector per tab.
    this.fileBytes(await WireTap.attach(page))
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await this.requireComposer(page, { timeout: this.settings.readyTimeoutMs, where: `opening thread ${threadId}` })

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
          `${landed ? `thread ${landed}` : 'a new, empty chat'}. Nothing was sent.` +
          // The guarantee comes FIRST and unconditionally. It used to be the
          // else-branch of the notice text, so exactly when something was
          // covering the page - the case where a caller most needs to know
          // whether their prompt went out - the one reassuring fact was
          // dropped.
          (blocked ? ` The site is showing: ${blocked}` : ''),
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
    // The answer stream carries the authoritative conversation identity.
    if (ctx.wireResult?.decoded?.conversationId) return ctx.wireResult.decoded.conversationId
    if (ctx.wireProvenance?.conversationId) return ctx.wireProvenance.conversationId
    const current = new URL(page.url())
    if (current.origin !== this.origin || !this.sel.thread?.urlPattern) return null
    const fromUrl = current.pathname.match(new RegExp(this.sel.thread.urlPattern))?.[1] ?? null
    if (fromUrl) return fromUrl
    // A sidebar lists unrelated history. The first link is never evidence
    // that this page belongs to that thread, even while the URL is updating.
    return null
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
   * Retrieve files a thread generated at any point in its past.
   *
   * Downloading only works today on the turn that produced the file, which
   * covers "ask for a CSV and get it" but not "here is a six-week thread,
   * give me everything it made". The controls are the same ones; what is
   * missing is that a message far up the thread is not in the document at
   * all until it is scrolled back, and that its answer text is long gone
   * from memory. Both are handled here, and every failure is reported
   * against the message it belongs to rather than dropped.
   */
  async downloadThreadFiles(page, messages, { onFile } = {}) {
    const g = this.sel.generatedFile
    const contract = this.sel.thread?.export
    // TWO SHAPES OF DOWNLOAD CONTROL, both measured, both supported.
    //   - ChatGPT: one button per file, inside the message (g.control).
    //   - Gemini: a <generated-file> chip that opens a viewer overlay whose
    //     toolbar holds the real download (g.chip + g.open + g.download).
    // Only the first was implemented here, so `export --files` on Gemini
    // answered "this provider has no measured download control" for threads
    // whose files download perfectly well at the time the answer arrives.
    // The viewer flow already exists for the live path; it just needed to be
    // pointed at a message scrolled back into view instead of the newest one.
    const viewerFlow = !g?.control && !!(g?.chip && g?.download)
    if (!contract?.idAttr || (!g?.control && !viewerFlow)) {
      return { files: [], skipped: 'this provider has no measured download control' }
    }

    const wanted = messages.filter((m) => m.file_controls?.length && m.id)
    if (!wanted.length) return { files: [] }

    const tap = await WireTap.attach(page)
    const standing = this.fileBytes(tap)
    const taken = new Set()
    const files = []
    for (const message of wanted) {
      const selector = `[${contract.idAttr}="${message.id.replace(/"/g, '\\"')}"]`
      const mounted = await mountMessage(page, { fileControl: g.control, ...contract }, selector, {
        settleMs: this.settings.threadSettleMs ?? 400,
      })
      if (!mounted) {
        for (const name of message.file_controls) {
          files.push({ name, message_id: message.id, error: 'the message holding this file could not be brought back into view' })
        }
        continue
      }
      const host = page.locator(selector).first()
      if (viewerFlow) {
        // The same routine the live path uses, scoped to this old message.
        // Scope to the whole MESSAGE, not to its text node. `selector` targets
        // the element carrying the id (Gemini: message-content), while the
        // chip and the tool marker that gates it live on the message root
        // above it - so a scope of `host` found neither and returned nothing.
        const whole = contract.messageNode
          ? page.locator(contract.messageNode).filter({ has: page.locator(selector) }).first()
          : host
        const got = await downloadGeneratedFiles(page, g, {
          scope: whole,
          dir: this.settings.downloadDir,
          waitMs: this.settings.fileWaitMs,
          pollMs: this.settings.pollMs,
          log: this.log,
        }).catch((e) => [{ name: message.file_controls[0] ?? 'download.bin', error: e.message.split('\n')[0] }])
        for (const f of got) {
          files.push({ ...f, message_id: message.id })
          if (!f.error) onFile?.(f)
        }
        continue
      }
      // The FILE CARD, when the provider has one. It lives in the message's
      // TURN, outside the message element itself - which is why retrieval
      // scoped to `host` never found it. See `_fileCard`.
      const turn = g.card?.scope
        ? page.locator(g.card.scope).filter({ has: page.locator(selector) }).first()
        : host
      const cards = await cardNames(turn, g)
      const controls = host.locator(g.control)
      const controlCount = await controls.count().catch(() => 0)
      for (let i = 0; i < message.file_controls.length; i++) {
        const fallbackName = message.file_controls[i] || `download-${i + 1}.bin`
        // The card goes FIRST on this path. The link is measured to issue no
        // request at all on a reloaded thread - it only opens the preview
        // panel - so leading with it spent several doomed clicks per file,
        // each toggling that panel. The card fetches the file directly. The
        // link and the panel stay as the fallbacks for a file with no card.
        const cardName = cardFor(cards, message.file_controls[i])
        const viaCard = cardName
          ? await downloadFromCard(page, g, {
            scope: turn, name: cardName, tap,
            dir: this.settings.downloadDir, downloadMs: this.settings.fileWaitMs, log: this.log,
          }).catch((err) => {
            this.log?.debug(`the file card did not yield ${cardName}: ${err.message.split('\n')[0]}`)
            return null
          })
          : null
        if (viaCard) {
          files.push({ ...viaCard, message_id: message.id })
          onFile?.(viaCard)
          continue
        }
        if (i >= controlCount) {
          files.push({ name: fallbackName, message_id: message.id, error: 'the download control is no longer rendered on this message' })
          continue
        }
        try {
          const file = await captureDownload(
            tap,
            () => this.clickThrough(controls.nth(i), { attempts: 2, timeout: 4000, what: `the ${fallbackName} download link` }),
            {
              contentPattern: g.contentPattern,
              metaPattern: g.metadataPattern,
              dir: this.settings.downloadDir,
              timeoutMs: this.settings.fileWaitMs,
              fallbackName,
              taken,
              standing,
              progressed: previewProgressed(page, g),
              log: this.log,
            }
          )
          files.push({ ...file, message_id: message.id })
          onFile?.(file)
        } catch (e) {
          // A RELOADED THREAD IS A DIFFERENT MECHANISM, not a flakier one.
          // The message's own link stops fetching once the page has been
          // reloaded - it only opens the preview panel - so the wire capture
          // above is structurally unable to succeed there, however many times
          // it clicks. The panel's own control still downloads the file, as a
          // browser download rather than an in-page fetch. Measured
          // 2026-09-09; see `_previewDownload` in the ChatGPT selectors.
          const viaPreview = await downloadFromPreview(page, g, {
            control: controls.nth(i),
            dir: this.settings.downloadDir,
            downloadMs: this.settings.fileWaitMs,
            log: this.log,
          }).catch((err) => {
            this.log?.debug(`the preview panel did not yield the file either: ${err.message.split('\n')[0]}`)
            return null
          })
          if (viaPreview) {
            files.push({ ...viaPreview, message_id: message.id })
            onFile?.(viaPreview)
            continue
          }
          this.log?.warn(
            `${fallbackName}: could not retrieve the file - ${e.message.split('\n')[0]}` +
              `; the page's recent requests were: ${tap.seen().slice(-8).join(', ')}`
          )
          files.push({ name: fallbackName, message_id: message.id, error: e.message.split('\n')[0] })
        }
      }
    }
    return { files }
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
    // Through any notice: the site's rate-limit modal covers the picker as
    // readily as it covers the composer, and a bare click on it reports a
    // 10s timeout instead of the lock that caused it.
    await this.clickThrough(page.locator(s.modelPicker).first(), { timeout: 10000, what: 'the model picker' })
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
      // NOT BEING THERE YET IS NOT THE SAME AS BEING GONE. openPicker calls
      // requireContract, which throws ui_contract ("the UI has changed") the
      // moment the picker is not matched inside its 8s budget - and that
      // throw used to escape this loop, so a picker that was merely late on a
      // freshly opened tab killed the whole request. Measured 2026-09-09
      // against the live site: one `ask --model=gemini-pro` died on it while
      // the very next identical call succeeded. This loop exists precisely
      // for picker flakiness, so a late picker is retried like any other
      // miss; only the final attempt is allowed to report a changed UI.
      try {
        await this.openPicker(page)
      } catch (e) {
        if (i === attempts) throw e
        this.log?.debug(`the model picker was not ready (attempt ${i}/${attempts}): ${e.message}`)
        await page.keyboard.press('Escape').catch(() => {})
        await sleep(1000)
        continue
      }
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
      await this.clickThrough(option, { timeout: 10000, what: `the ${modelId} option` })

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
    // A completed call is not the same as a processed file: the stream has
    // to say so (e.g. "file_ready"), or the site may still be extracting
    // text from it.
    const ready = this.sel.wire?.uploadReady ? new RegExp(this.sel.wire.uploadReady) : null
    const budget = this.#uploadBudget(files.length)

    // SEND DURING UPLOAD (`sendDuringUpload`, on by default). The files are
    // handed over and this returns at once: the prompt is typed while they
    // upload and sent as soon as the site's own send button allows it.
    // Waiting here for every confirmation was OUR gate, not the site's, and
    // the expensive one - 31 of 1,205 requests (2026-09-17/18) sat on a
    // process_upload_stream that never finished, each for the whole budget
    // before failing. The user, who drives this site by hand, sends while
    // attachments are still in flight and the model runs once they finish.
    // The page's own code says the same (the 2026-09-06 capture, read
    // 2026-09-18; docs/UI-RECON.md): a prompt sent with PDFs or images still
    // uploading is HELD by the page and posted when every file is ready, one
    // whose upload fails is not posted at all, and any other file type keeps
    // the send button disabled until it is ready.
    //
    // ONLY WHERE THE UPLOAD IS ON THE WIRE. Once we stop waiting, the
    // confirmations are what still catch a file the site refused (see
    // transports/uploads.mjs). Gemini has no `wire.upload`, so nothing would
    // watch its files after the send, and its send button is recorded (its
    // selectors.json, `_upload`) as enabled while the file is still
    // uploading, with the prompt then going out before the file lands. There
    // the waiting flow below is the only protection, so it stays.
    const overlap = !!uploads && this.settings.sendDuringUpload !== false
    let handedOver = false
    try {
      if (how === 'cdp-drag') await this.#dropUntilRegistered(page, files)
      else if (how === 'file-input') await this.#attachByInput(page, files)
      else if (how === 'file-chooser') await this.#attachByChooser(page, files)
      else throw new ContractError(this.id, 'attachStrategy', how)
      if (overlap) {
        // The page must still have TAKEN the files: a chip, where the
        // provider has one, and every upload request actually going out,
        // which submit() checks after typing. A file that never left is not
        // in flight, and sending without it is the one thing to avoid.
        await this.waitForAttachments(page, files.length, { uploaded: false })
        this.#uploads = new UploadWatch(uploads, { expected: files.length, budgetMs: budget, ready })
        handedOver = true
        this.log?.debug(`${files.length} file(s) handed to the page; the prompt goes out while they upload`)
        return
      }
      if (uploads) {
        const done = await uploads.atLeast(files.length, budget)
        const failed = refusedUploads(done, ready)
        if (failed.length) throw uploadRefused(this.id, failed, files.length)
        this.#uploadStamps.uploads_confirmed = Date.now()
        this.log?.debug(`${files.length} upload(s) confirmed on the wire`)
      }
      await this.waitForAttachments(page, files.length)
    } finally {
      if (!handedOver) uploads?.stop()
    }
  }

  /**
   * How long `n` files may take to upload: `uploadPerFileMs` each, at least
   * `uploadFloorMs`, at most `uploadTimeoutMs` (see config.mjs for the
   * measurements behind each).
   */
  #uploadBudget(n) {
    return Math.min(
      this.settings.uploadTimeoutMs,
      Math.max(this.settings.uploadFloorMs ?? 0,
        (this.settings.uploadPerFileMs ?? this.settings.uploadTimeoutMs) * n))
  }

  /** The request is over, one way or another: release its upload watch. */
  #endUploads() {
    this.#uploads?.stop()
    this.#uploads = null
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
    await target.scrollIntoViewIfNeeded().catch(() => {})
    // WAIT FOR THE COMPOSER TO STOP MOVING. The drop happens right after a
    // new conversation is created, which re-renders the input area; a drop
    // dispatched into that render reaches a zone whose handler is not bound
    // yet and is silently discarded. Measured 2026-09-09: from a settled page
    // the first drop landed every time, while in the product - where the
    // composer had just been rebuilt - five attempts in six needed the
    // retry. Two identical geometry readings are enough to say it has
    // settled, and it costs a few hundred milliseconds, not a fixed sleep.
    const box = await waitStable(
      async () => JSON.stringify(await target.boundingBox()),
      { checks: 2, poll: 120, timeout: 8000, accept: (v) => v && v !== 'null', what: 'the drop target to stop moving' }
    ).then(JSON.parse).catch(() => target.boundingBox())
    if (!box) throw new ContractError(this.id, 'dropTarget', this.sel.dropTarget)
    const client = await cdp(page)
    const data = { items: [], files: files.map((f) => resolvePath(f)), dragOperationsMask: 1 }
    // PACE THE SEQUENCE. Fired back to back, the three events can all arrive
    // inside one frame; the app's drop zone is activated by dragenter and its
    // drop handler is bound in the render that follows, so the drop lands on
    // a zone that is not listening yet and NOTHING happens - no chip, no
    // request, no error. Measured 2026-09-08: this dropped roughly one
    // attachment in three on Gemini. The extra dragOver is what a real mouse
    // would produce anyway.
    for (const type of ['dragEnter', 'dragOver', 'dragOver', 'drop']) {
      await client.send('Input.dispatchDragEvent', {
        type,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        data,
      })
      await sleep(80)
    }
  }

  /**
   * Drop the files, and CHECK that the page took them.
   *
   * A dispatched drag is fire-and-forget: nothing in the protocol says the
   * page reacted. Measured on Gemini, roughly one attempt in three left no
   * chip at all, and the request then failed 180s later against a composer
   * that had never seen the file.
   *
   * Only a drop that produced NOTHING is repeated. A partial result is left
   * alone deliberately: re-dropping on top of a chip that did register would
   * attach the same evidence file twice, and a duplicated exhibit in a
   * systematic review is worse than a clean failure.
   */
  async #dropUntilRegistered(page, files, attempts = 3) {
    const chip = this.sel.attachmentChip
    const chips = async () => (chip ? await count(page, chip) : files.length)
    for (let i = 1; i <= attempts; i++) {
      await this.#attachByDrag(page, files)
      if (!chip) return
      const landed = await waitFor(async () => ((await chips()) > 0 ? true : null), {
        timeout: 10000,
        poll: this.settings.pollMs,
        what: 'the dropped file to appear in the composer',
      }).catch(() => false)
      if (landed) return
      if (i < attempts) this.log?.warn(`the drop did not register with the page; dispatching it again (${i}/${attempts})`)
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
   * Wait until the UI has really registered the files - and, unless
   * `uploaded: false`, finished uploading them.
   *
   * Where the upload is not on the wire (Gemini), never key this off the
   * send button: there it is enabled the entire time, so the prompt goes out
   * before the upload lands and the model answers about a file it never
   * received. The chip appearing, and any "uploading" text going away, is
   * the actual signal.
   *
   * `uploaded: false` is the send-during-upload flow (see attach). The chip
   * is still required - a file the page never took is not in flight - but
   * the uploading text is not waited out: the page holds the send itself,
   * and the upload confirmations on the wire, not its text, decide whether
   * the file arrived.
   */
  async waitForAttachments(page, n, { uploaded = true } = {}) {
    const s = this.sel
    if (!s.attachmentChip) return
    const uploading = uploaded && s.uploadingText ? new RegExp(s.uploadingText, 'i') : null
    // SAY WHAT WAS SEEN, NOT JUST THAT TIME RAN OUT. There are two very
    // different failures behind "waiting for 1 attachment(s)": the file never
    // reached the page at all (no chip - the trusted drag did not land), or
    // it reached it and the site is still working (chip present, "Uploading
    // file" still on screen). The first is ours to retry differently; the
    // second is the site being slow. The old message could not tell them
    // apart, and neither could anyone reading the log.
    let chips = 0
    let stillUploading = false
    try {
      await waitFor(
        async () => {
          chips = await count(page, s.attachmentChip)
          if (chips < n) return null
          if (!uploading) return true
          const scope = s.dropTarget ?? 'body'
          const text = await page.locator(scope).first().innerText().catch(() => '')
          stillUploading = uploading.test(text)
          return stillUploading ? null : true
        },
        {
          timeout: this.settings.uploadTimeoutMs,
          poll: this.settings.pollMs,
          what: `${n} attachment(s) to finish uploading`,
        }
      )
    } catch (err) {
      const seen = chips >= n
        ? `the file is attached but the site is still uploading it after ${Math.round(this.settings.uploadTimeoutMs / 1000)}s`
        : `only ${chips} of ${n} attachment(s) ever appeared in the composer - the file never reached the page`
      throw new BridgeError(`${this.id}: ${seen}. Nothing was sent.`, {
        status: 504,
        code: chips >= n ? 'upload_slow' : 'upload_not_registered',
        retryable: true,
        detail: { chips, expected: n, still_uploading: stillUploading },
      })
    }
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
    try {
      return await this.#send(page, prompt, ctx)
    } catch (e) {
      // A request that fails here never reaches awaitCompletion, which is
      // where an upload watch is otherwise released.
      this.#endUploads()
      throw e
    }
  }

  async #send(page, prompt, ctx) {
    const s = this.sel
    const composer = page.locator(s.composer).first()
    // Uploads still in flight, when attach() handed them over (see there).
    const flight = this.#uploads
    ctx.transportTiming ??= {}
    Object.assign(ctx.transportTiming, this.#uploadStamps)

    // ARM THE WIRE BEFORE TYPING. On a wired provider the answer is read
    // from the response the page receives, and a tap armed after the click
    // can only see the next request. It also gives a stronger proof of
    // submission than an emptied composer: the request actually went out.
    if (this.wired) ctx.wire = (await WireTap.attach(page)).expect(s.wire.answer)

    // Same reasoning for a file the answer is about to produce: the app may
    // fetch it while the turn is still rendering, long before anything asks
    // for it. Arming here costs one CDP subscription per tab.
    this.fileBytes(await WireTap.attach(page))

    // A refusal already on the wire ends the request BEFORE the click. The
    // page would not post a prompt whose file it refused, and a send button
    // it re-enables after dropping that file must not be clicked either.
    const refusedBeforeSend = () => {
      const failed = flight?.refused()
      if (failed) throw uploadRefused(this.id, failed, flight.expected)
    }

    const fire = async () => {
      refusedBeforeSend()
      if (s.submitKey) {
        ctx.transportTiming.send_clicked = Date.now()
        return composer.press(s.submitKey)
      }
      await this.requireContract(page, 'sendButton', s.sendButton)
      const send = page.locator(s.sendButton).first()
      // THE APP'S OWN "NOT YET". MEASURED 2026-09-17 on ChatGPT: for a few
      // seconds after an upload is confirmed on the wire the send button
      // carries aria-disabled="true" while the site finishes with the file;
      // Playwright clicks it regardless and the app drops the click. Waiting
      // for the attribute to clear costs those seconds once instead of a
      // wasted attempt plus an 8s confirmation window. Bounded: a site that
      // never clears it is reported by the click path, not waited on.
      //
      // With uploads in flight this is the only upload gate left, and it is
      // the site's own: its code (2026-09-06 capture) keeps the button
      // disabled while a file it cannot send early is still uploading, and
      // enables it at once for PDFs and images, whose send it holds itself.
      // A refusal, or the upload budget running out, ends the wait early -
      // the same budget the waiting flow spent, so a stall costs no more
      // than it did.
      await waitFor(
        async () => (flight?.refused() || flight?.expired() ||
          (await send.getAttribute('aria-disabled').catch(() => null)) !== 'true' ? true : null),
        { timeout: this.settings.uploadTimeoutMs ?? 30000, poll: this.settings.pollMs, what: 'the send button to be enabled' }
      ).catch(() => {})
      refusedBeforeSend()
      if (flight?.expired()) throw this.#uploadsStalled(flight)
      // Through any blocking notice: the rate-limit modal covers the
      // composer too, and a swallowed send presents as "no turn appeared".
      // The send button sits in the sticky composer and is always on
      // screen, so it is never scrolled (see clickThrough).
      ctx.transportTiming.send_clicked = Date.now()
      await this.clickThrough(send, { timeout: 15000, what: 'the send button', scroll: false })
    }

    const confirm = async () => {
      if (flight) return this.#awaitHeldSend(composer, ctx, flight)
      if (ctx.wire) {
        await ctx.wire.request(8000)
        return
      }
      // Submission clears the composer. Seconds, not minutes - if it has
      // not happened by now it is not going to.
      await waitFor(
        async () => {
          const left = ((await readComposer(composer).catch(() => '')) ?? '').trim()
          return left ? null : true
        },
        { timeout: 8000, poll: this.settings.pollMs, what: 'the composer to clear after sending' }
      )
    }

    // Typing starts the moment the files are handed over; with uploads in
    // flight it overlaps them instead of following them.
    ctx.transportTiming.typing = Date.now()
    await fillComposer(composer, prompt)
    if (flight) await this.#awaitUploadsStarted(flight, ctx)

    for (let attempt = 1; attempt <= 2; attempt++) {
      ctx.transportTiming.submit = Date.now()
      await fire()
      try {
        await confirm()
        return
      } catch (e) {
        // What happened to the files is the answer to "why", not a click
        // that did not take - and it must not be retried as one.
        if (/^upload_/.test(e?.code ?? '')) throw e
        const remaining = await readComposer(composer).catch(() => null)
        if (remaining === null || normalizeComposerText(remaining) !== normalizeComposerText(prompt)) {
          throw new BridgeError('Submission could not be confirmed; refusing to resend a possibly accepted prompt', {
            status: 502, code: 'submit_uncertain', retryable: false,
          })
        }
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

  /**
   * Every file has LEFT for the site: one upload request per file has gone
   * out. Checked after typing, so the two overlap.
   *
   * This is the send-during-upload flow's "the page took the file". ChatGPT
   * has no measured composer chip, and before this flow the confirmation
   * wait was the only check that a file reached the site at all; without a
   * replacement, a file input whose change never registered would send the
   * prompt bare. It costs nothing in time-to-answer: the request going out
   * precedes the file being ready, and the page does not post the prompt
   * before that anyway.
   */
  async #awaitUploadsStarted(flight, ctx) {
    const seen = await flight.registered()
    if (seen.refused) throw uploadRefused(this.id, seen.refused, flight.expected)
    if (seen.started >= flight.expected) {
      ctx.transportTiming.uploads_registered = flight.registeredAt ?? Date.now()
      return
    }
    // SAY WHAT WAS SEEN (see waitForAttachments): an upload that started and
    // never finished holds back the ones queued behind it, which is the site
    // being slow; none starting is the file never reaching it.
    const inProgress = seen.started - seen.finished
    throw new BridgeError(
      inProgress
        ? `${this.id}: only ${seen.started} of ${flight.expected} upload(s) started in ${Math.round(flight.budgetMs / 1000)}s, ` +
            `and the site is still processing ${inProgress} of them. Nothing was sent.`
        : `${this.id}: only ${seen.started} of ${flight.expected} attachment(s) ever started uploading - ` +
            'the file never reached the site. Nothing was sent.',
      {
        status: 504,
        code: inProgress ? 'upload_slow' : 'upload_not_registered',
        retryable: true,
        detail: { expected: flight.expected, started: seen.started, finished: seen.finished },
      }
    )
  }

  /**
   * Confirm a send made while uploads were still in flight.
   *
   * The page HOLDS such a prompt until every file is ready, with the prompt
   * still in the composer, so its own conversation request - the proof of
   * submission - can come long after the click. Treating that as "the send
   * did not take" would click again at a composer the page is about to
   * post. So the usual 8 s window runs from the later of the click and the
   * last upload confirmation; a refusal ends the wait, and so does the
   * upload budget (plus that window) running out with files unconfirmed.
   */
  async #awaitHeldSend(composer, ctx, flight) {
    const clicked = Date.now()
    const window = 8000
    const sent = ctx.wire
      ? async () => !!ctx.wire.partial()
      : async () => {
        const left = await readComposer(composer).catch(() => null)
        return left !== null && !left.trim()
      }
    let outcome = null
    await waitFor(
      async () => {
        if (await sent()) return (outcome = 'sent')
        if (flight.refused()) return (outcome = 'refused')
        const all = flight.confirmedAt
        if (all != null && Date.now() - Math.max(all, clicked) > window) return (outcome = 'unsent')
        return null
      },
      {
        timeout: Math.max(0, flight.deadline - clicked) + window,
        poll: this.settings.pollMs,
        what: 'the page to send the prompt once its uploads finish',
      }
    ).catch((e) => {
      if (!(e instanceof TimeoutError)) throw e
    })
    if (outcome === 'sent' || (!outcome && (await sent()))) return
    if (outcome === 'refused') throw uploadRefused(this.id, flight.refused(), flight.expected)
    // Every file was confirmed and still nothing went out: an ordinary send
    // that did not take, handled (and retried once) as one.
    if (outcome === 'unsent') throw new TimeoutError('the page to send the prompt after its uploads were confirmed', window)
    throw this.#uploadsStalled(flight)
  }

  /** The upload budget ran out before every file was confirmed. */
  #uploadsStalled(flight) {
    const finished = flight.finished()
    return new BridgeError(
      `${this.id}: ${flight.expected - finished} of ${flight.expected} upload(s) were still unconfirmed after ` +
        `${Math.round(flight.budgetMs / 1000)}s, and the site does not post a prompt before its files are ready. Nothing was sent.`,
      {
        status: 504,
        code: 'upload_slow',
        retryable: true,
        detail: { expected: flight.expected, started: flight.started(), finished },
      }
    )
  }

  // --- completion ----------------------------------------------------------

  /**
   * Wait for the answer - and, when the prompt went out with its uploads
   * still in flight, keep watching them while it arrives.
   *
   * The page posts such a prompt only once every file is ready (see
   * attach), so on ChatGPT a refusal after the send should not happen. It is
   * watched for anyway, because the one outcome that must never occur is an
   * answer returned as if it were about a file the site refused: a refusal
   * cancels the wait the moment it arrives, and is looked for once more
   * when the answer is complete.
   *
   * A confirmation our tap never saw is not a refusal. The page posted the
   * prompt, and it does that only once its files are ready, so the answer
   * is returned; the warning, and `uploads_confirmed` missing from
   * transport_timing, say what was not observed.
   */
  async awaitCompletion(page, ctx) {
    const flight = this.#uploads
    if (!flight) return this.#awaitAnswer(page, ctx)
    try {
      const refusedAfterSend = (failed) => uploadRefused(this.id, failed, flight.expected, { sent: true })
      await flight.guard(() => this.#awaitAnswer(page, ctx), refusedAfterSend)
      const late = flight.refused()
      if (late) throw refusedAfterSend(late)
      ctx.transportTiming ??= {}
      if (flight.confirmedAt) {
        ctx.transportTiming.uploads_confirmed = flight.confirmedAt
      } else {
        this.log?.warn(
          `the answer arrived with ${flight.expected - flight.finished()} of ${flight.expected} upload(s) never ` +
            'confirmed on the wire; the page posted the prompt, which it does only once its files are ready'
        )
      }
      return ctx
    } finally {
      this.#endUploads()
    }
  }

  /**
   * Done means ALL of: a new turn exists, its text stopped changing, the text
   * is not a placeholder, and the stop control is gone.
   *
   * Each condition alone is insufficient. Text stability alone fires during a
   * pause mid-stream. The stop control alone flickers. Ignoring placeholders
   * returns "Searching the internet" as the model's answer.
   */
  async #awaitAnswer(page, ctx) {
    const s = this.sel
    // The request's own response budget when it declared one (a long,
    // file-producing turn), the provider's otherwise.
    const cfg = { ...this.settings, responseTimeoutMs: ctx.responseTimeoutMs ?? this.settings.responseTimeoutMs }

    if (ctx.wire && (await this.#awaitWire(page, ctx))) {
      // A stream that closed without its finish marker while the page still
      // shows the turn generating is a turn that went on past its first
      // connection: ChatGPT runs its tools (the sandbox that writes a DOCX)
      // across several. The first stream's text is the model's plan, not
      // its answer, and the files are not in it. c1 (2026-09-14) and c2
      // (2026-09-17) each came back that way as "truncated" after 500 s.
      // The page path waits for the generating control to clear and reads
      // the files off the rendered turn; the wire's provenance is kept.
      if (wireContinues(ctx.wireResult?.decoded, await isGenerating(page, s.stopButton))) {
        this.log?.warn('the response stream closed without finishing while the turn is still generating; following it on the page')
        ctx.wireProvenance = { sentAs: ctx.wireResult.sentAs, sentEffort: ctx.wireResult.sentEffort, conversationId: ctx.wireResult.decoded.conversationId ?? null }
        ctx.wireContinued = true
        ctx.wireResult = null
      } else {
        // The answer is in hand, but the page can still be holding the
        // which-answer-do-you-prefer chooser: the turn is uncommitted and
        // the composer will refuse the NEXT prompt on this thread. Clear it
        // now, while this request still owns the tab.
        await this.resolveResponseComparison(page, ctx)
        return ctx
      }
    }

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
    ctx.transportTiming ??= {}
    ctx.transportTiming.turn_appeared ??= Date.now()

    const transient = (s.transientText ?? []).map((t) => new RegExp(t, 'i'))
    const searchRe = s.searchTransient ? new RegExp(s.searchTransient, 'i') : null
    ctx.browsedHint = false

    const usable = (t) => !!t && !(t.trim().length <= 64 && transient.some((re) => re.test(t)))
    try {
      await waitStable(
        async () => {
          const t = await readRenderedText(page, { blocks: s.responseBlocks, text: s.responseText }, ctx.index)
          if (t && !ctx.transportTiming.first_token) ctx.transportTiming.first_token = Date.now()
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
    await this.resolveResponseComparison(page, ctx)
    return ctx
  }

  /**
   * The site asked which of two candidate responses is preferred.
   *
   * This is not a verification challenge and not a notice: it is a product
   * experiment rendered inside the conversation. It matters here because
   * the turn is NOT committed until a choice is made, and the composer
   * refuses the next prompt meanwhile - so left alone it returns the
   * chooser's own words as the model's answer and wedges every later
   * request on the thread at `submit_failed`, with nothing naming why.
   *
   * The controls that choose a candidate have never been measured, so this
   * does not click one. It dumps the page for whoever measures them next,
   * reloads the thread, and READS BACK whether the chooser cleared. A
   * reload that resolved it leaves the committed turn as the last assistant
   * block; one that did not ends the request with a typed error, because
   * one named failure is better than a thread that fails silently from here
   * on.
   */
  async resolveResponseComparison(page, ctx) {
    const s = this.sel
    if (!s.comparisonText) return
    const body = await page.locator('body').innerText().catch(() => '')
    if (!showsResponseComparison(body, s.comparisonText)) return

    const seen = body.match(new RegExp(s.comparisonText, 'i'))?.[0] ?? ''
    this.log?.warn(`the site is asking which of two responses is preferred ("${seen}"); the turn is not committed until it is answered`)
    const dump = await this.captureComparison(page).catch(() => null)

    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await this.requireComposer(page, { timeout: 30000, where: 'after a response comparison' }).catch(() => {})
    const after = await page.locator('body').innerText().catch(() => '')
    if (showsResponseComparison(after, s.comparisonText)) {
      throw new BridgeError(
        `${this.id}: the site is asking which of two responses is preferred and the thread cannot continue until it is answered`,
        { status: 503, code: 'response_comparison', retryable: true,
          detail: { seen, dom_capture: dump, thread_id: ctx.threadId ?? null } }
      )
    }

    ctx.responseComparison = 'resolved_by_reload'

    // The answer was already decoded off the wire: the reload was only ever
    // about unwedging the thread, so an empty page is not a lost answer.
    if (ctx.wireResult?.decoded?.text) {
      this.log?.warn('the comparison cleared on reload; the wire answer stands')
      return
    }

    // Otherwise the committed turn is the last assistant block on the
    // reloaded thread; the index computed before the reload described a DOM
    // that no longer exists.
    const texts = await this.responseTexts(page)
    const last = texts.length - 1
    if (last < 0 || !texts[last]) {
      throw new BridgeError(
        `${this.id}: a response comparison cleared on reload but left no answer on the thread`,
        { status: 503, code: 'response_comparison', retryable: true,
          detail: { seen, dom_capture: dump, thread_id: ctx.threadId ?? null } }
      )
    }
    ctx.index = last
    this.log?.warn('the comparison cleared on reload; taking the committed turn')
  }

  /**
   * Dump the page while a response comparison is up, so its controls can be
   * measured rather than guessed next time. Into a gitignored subfolder:
   * the HTML carries conversation content and must never reach a commit.
   */
  async captureComparison(page) {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const { ROOT } = await import('../core/config.mjs')
    const dir = resolvePath(ROOT, 'testdata', 'capture', `comparison-${stamp}`)
    await mkdir(dir, { recursive: true })
    await writeFile(resolvePath(dir, 'page.html'), await page.content(), 'utf8')
    await page.screenshot({ path: resolvePath(dir, 'page.png'), fullPage: true }).catch(() => {})
    this.log?.warn(`captured the comparison DOM to ${dir} - measure the choose-a-response controls there`)
    return dir
  }

  /**
   * Completion on the wire: the response connection closes.
   *
   * Returns true when a usable answer was decoded, false to let the DOM path
   * take over. A refusal from the site (a 4xx/5xx on the request) is thrown
   * here, because then no message was generated for anyone to read.
   *
   * The stream's end is raced against the page's: see #pageFinishedWithoutWire.
   */
  async #awaitWire(page, ctx) {
    const cfg = { ...this.settings, responseTimeoutMs: ctx.responseTimeoutMs ?? this.settings.responseTimeoutMs }
    let lastProgress = ''
    const done = new AbortController()
    const outer = currentSignal()
    const scope = outer ? AbortSignal.any([outer, done.signal]) : done.signal
    const wire = withCancellation(scope, () => ctx.wire.finished(cfg.responseTimeoutMs, (partial) => {
      // Decoding is only needed for a listener, or to stamp the first token.
      if (!partial?.body || (!ctx.onProgress && ctx.transportTiming?.first_token)) return
      const decoded = decodeDeltaStream(partial.body)
      if (!decoded.text || decoded.text === lastProgress) return
      ctx.transportTiming ??= {}
      ctx.transportTiming.turn_appeared ??= Date.now()
      ctx.transportTiming.first_token ??= Date.now()
      lastProgress = decoded.text
      ctx.onProgress?.(decoded.text)
    }))
    // Given up, the stream's wait is cancelled; nobody is left to hear it end.
    wire.catch(() => {})
    const stalled = this.#pageFinishedWithoutWire(page, ctx, done.signal)
    let res
    try {
      res = await Promise.race([wire, stalled.then((finished) => (finished ? STREAM_UNSEEN : new Promise(() => {})))])
    } finally {
      done.abort()
    }
    if (res === STREAM_UNSEEN) {
      const partial = ctx.wire.partial()
      this.log?.warn(
        `the page finished the turn ${Math.round((cfg.wireStallMs ?? WIRE_STALL_MS) / 1000)}s ago but its answer stream never reported an end ` +
          `(${partial?.bytes ?? 0} bytes seen; a connection lost mid-turn?); reading the page instead`
      )
      ctx.wireStalled = true
      const { sentAs, sentEffort } = await this.#sentModel(ctx)
      ctx.wireProvenance = { sentAs, sentEffort, conversationId: null }
      return false
    }
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
    const { sentAs, sentEffort } = await this.#sentModel(ctx)
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

  /**
   * What the UI put in its own request - the model field it chose from the
   * picker state, and the effort. Independent of the answer and of the
   * picker label, and readable whether or not the answer's stream ended.
   */
  async #sentModel(ctx) {
    try {
      const body = await ctx.wire.sentBody()
      const j = body ? JSON.parse(body) : null
      // Named by the provider contract, because the field is the site's own
      // vocabulary (ChatGPT: thinking_effort = standard | extended).
      const effortField = this.sel.wire.effortField
      return { sentAs: j?.model ?? null, sentEffort: effortField && j ? j[effortField] ?? null : null }
    } catch {
      return { sentAs: null, sentEffort: null }
    }
  }

  /**
   * True once the page has shown the turn finished for `wireStallMs` - a new
   * answer block, no stop control, its text unchanged - while the answer's
   * stream is still open; false when `stop` ends the watch first.
   *
   * MEASURED 2026-09-18 on c12's manuscript turn. The connection was lost
   * while the answer's first stream was open: the page's own record shows
   * that stream ending at 18:54:44 (318 s), then nothing until 19:05:42,
   * when the site reconnected (`conversation/resume`, seven tries), finished
   * the turn and fetched its six files by 19:07. The tap never saw the
   * stream end - none of the four ways out of the stream wait logged - so a
   * finished draft waited out the whole 2,700 s budget and was reported as a
   * timeout. The stream's end is one sign that a turn is over; the page
   * showing it over is another, and the page is where the answer is read
   * from whenever the wire falls short. On a healthy turn the two end
   * together, so the grace costs nothing there.
   */
  async #pageFinishedWithoutWire(page, ctx, stop) {
    const s = this.sel
    const grace = this.settings.wireStallMs ?? WIRE_STALL_MS
    const poll = Math.max(5, Math.min(1000, grace / 4))
    const prior = ctx.responseTextsBefore ?? []
    const where = { blocks: s.responseBlocks, text: s.responseText }
    let last = null
    let quietSince = null
    try {
      while (!stop.aborted) {
        const n = await count(page, s.responseBlocks)
        const text = n ? await readRenderedText(page, where, n - 1) : ''
        const fresh = !!text && (n > prior.length || text !== (prior[n - 1] ?? ''))
        const settled = fresh && text === last && !(await isGenerating(page, s.stopButton))
        quietSince = settled ? (quietSince ?? Date.now()) : null
        if (quietSince !== null && Date.now() - quietSince >= grace) return true
        last = text
        await sleep(poll)
      }
    } catch {
      // A page that cannot be read says nothing about the stream.
    }
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
    const copyDiagnostics = {}
    const copied = await copyMarkdown(page, s, {
      diagnostics: copyDiagnostics,
      scope: page.locator(s.responseBlocks).nth(ctx.index),
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
    const integrity = this.classifyAnswer(text)

    const files = await this.generatedFiles(page, ctx, text)

    const { browsed, searched, sources } = await this.collectSources(page, ctx)

    // THE MODEL THAT ANSWERED, off the page. An answer read here has no slug
    // from the wire, and a strict session refused a complete answer for it:
    // measured 2026-09-18, a 4,000-line answer whose connection was broken
    // mid-stream was followed to its end on the page, then refused as
    // model_unverified. The answer's own message carries the slug the site
    // recorded for it (the attribute the thread export reads).
    const slugAttr = s.thread?.export?.modelAttr
    const blocks = page.locator(s.responseBlocks)
    const modelSlug = slugAttr
      ? await (ctx.index != null ? blocks.nth(ctx.index) : blocks.last()).getAttribute(slugAttr).catch(() => null)
      : null

    return {
      text,
      // Which tier produced this, so a caller can judge the text rather than
      // guess. `markdown` stays for compatibility: true when the text is
      // real markdown, whichever tier built it.
      extraction,
      markdown: extraction !== 'rendered',
      lossy_math: lossyMath,
      extraction_warning: copied ? null : copyDiagnostics,
      // The text is the provider's own error notice rather than an answer.
      // Delivered anyway; the caller decides what that means.
      provider_error: integrity.error,
      // A short answer that OPENS like a first-person failure but matches no
      // measured pattern. Not a verdict - see core/answer-integrity.mjs.
      provider_error_suspected: integrity.suspected,
      provider_error_match: integrity.matched ?? integrity.suspected_by ?? null,
      tables: parseTables(text),
      code_blocks: parseCodeBlocks(text),
      files,
      sources,
      browsed,
      searched,
      truncated: !!ctx.truncated,
      // The turn came out of the site's which-answer-do-you-prefer test and
      // how it was resolved. A label on the answer, not a change to it.
      ...(ctx.responseComparison ? { response_comparison: ctx.responseComparison } : {}),
      // Read off the page after the wire fell short: the stream closed while
      // the turn went on (`wire_continued`), or was never seen to end
      // (`wire_stalled`, #pageFinishedWithoutWire). Labels, like the one above.
      ...(ctx.wireProvenance
        ? { sent_as: ctx.wireProvenance.sentAs, sent_effort: ctx.wireProvenance.sentEffort,
            ...(ctx.wireStalled ? { wire_stalled: true } : { wire_continued: true }) }
        : {}),
      ...(modelSlug ? { model_slug: modelSlug, model_source: 'page' } : {}),
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
      scope: page.locator(s.responseBlocks).nth(ctx.index),
      requestId: ctx.requestId,
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
    const integrity = this.classifyAnswer(text)
    return {
      text,
      extraction: 'wire',
      markdown: true,
      lossy_math: false,
      // The turn came out of the site's which-answer-do-you-prefer test and
      // how it was resolved. A label on the answer, not a change to it.
      ...(ctx.responseComparison ? { response_comparison: ctx.responseComparison } : {}),
      provider_error: integrity.error,
      // A short answer that OPENS like a first-person failure but matches no
      // measured pattern. Not a verdict - see core/answer-integrity.mjs.
      provider_error_suspected: integrity.suspected,
      provider_error_match: integrity.matched ?? integrity.suspected_by ?? null,
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
   * Wait for the composer, and SAY WHAT WENT WRONG if it never comes.
   *
   * `locator.waitFor: Timeout 60000ms exceeded` is a true sentence that
   * names neither the thing being waited for, the page it was waited on, nor
   * the notice that was covering it. Measured 2026-09-09: two live failures
   * reported exactly that and nothing else, and diagnosing them meant
   * reading the source to find out which of several 30s/60s waits had fired.
   *
   * The evidence is gathered only on failure, so the happy path costs
   * nothing.
   */
  async requireComposer(page, { timeout, where }) {
    try {
      await page.locator(this.sel.composer).first().waitFor({ state: 'visible', timeout })
      return
    } catch {
      /* fall through and find out why */
    }
    if (await this.#recoverUnhydrated(page)) return
    const notices = await this.dismissNotices(page).catch(() => [])
    // A notice can be what was covering it. Now that it is dismissed, the
    // composer may simply be there - so ask once more before giving up.
    if (notices.length) {
      const ok = await page.locator(this.sel.composer).first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
      if (ok) {
        this.log?.debug(`the composer was behind the site's "${notices.map((n) => n.name).join(', ')}" notice; continuing`)
        return
      }
    }
    await this.assertNoChallenge(page)
    // page.url() is SYNCHRONOUS and returns a string. Awaiting a .catch on
    // it threw "page.url(...).catch is not a function" - inside the very
    // path that exists to explain a failure, so a clean 504
    // composer_unavailable was replaced by an untyped 500 internal.
    const url = page.url()
    const blocked = notices.map((n) => `${n.kind}: ${n.text}`).join(' | ')
    throw new BridgeError(
      `${this.id}: the composer never became usable ${where} after ${Math.round(timeout / 1000)}s` +
        (blocked ? `. The site is showing - ${blocked}` : '.') +
        ` (page: ${url})`,
      {
        status: 504,
        code: 'composer_unavailable',
        retryable: true,
        detail: { where, url, notices, selector: this.sel.composer },
      }
    )
  }

  /**
   * The app never started. Restart it rather than reporting a timeout.
   *
   * MEASURED on ChatGPT 2026-09-09. A provider can serve a no-JS fallback
   * control that is a perfectly ordinary, visible, typable element - here a
   * `textarea[name=prompt-textarea]` - while the real editor never mounts.
   * Typing into it does nothing: the send button stays disabled, because the
   * application it belongs to is not running. Waiting longer cannot help,
   * and the symptom we reported was a 30-second timeout on a selector.
   *
   * The trigger is a race in the browser launch: with the window parked off
   * the desktop, Chrome sometimes composites no frame, and an editor that
   * mounts from a frame callback never mounts. So the ladder is: reload
   * (cheap, usually enough); then reload with the window briefly on the
   * desktop, which is the condition the app is waiting for. Both are gated
   * on the fallback being visible, so a provider that never drifts this way
   * pays nothing.
   */
  async #recoverUnhydrated(page) {
    const fallback = this.sel.unhydratedComposer
    if (!fallback) return false
    const stuck = async () =>
      (await count(page, fallback)) > 0 && (await count(page, this.sel.composer)) === 0
    if (!(await stuck().catch(() => false))) return false

    const mounted = async (ms) =>
      page.locator(this.sel.composer).first().waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false)

    this.log?.warn(
      `${this.id} served its no-JS fallback composer and never started the app - ` +
        'reloading rather than waiting for an editor that will not appear'
    )
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    if (await mounted(20000)) return true

    this.log?.warn('still not started; bringing the window onto the desktop briefly so the page can render a frame')
    const recovered = await nudgeOnScreen(page, async () => {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      return mounted(30000)
    }).catch(() => false)
    if (recovered) this.log?.info('the app started once the window was on the desktop; the window has been parked again')
    return recovered
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

/**
 * What kind of notice is this text?
 *
 * A spec that names its kind outright (ChatGPT's measured rate-limit modal)
 * keeps it. A structural spec carries `classify` rules instead, and text
 * matching none of them stays `unknown` - which a caller can act on
 * ("something is blocking the UI") without being told a category we made up.
 */
export function classifyNotice(spec, text) {
  if (spec.kind && spec.kind !== 'unknown') return spec.kind
  for (const rule of spec.classify ?? []) {
    if (new RegExp(rule.match, 'i').test(text)) return rule.kind
  }
  return 'unknown'
}
