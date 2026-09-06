// SESSION: one provider, one browser, one tab pool.
//
// This is the orchestration layer. It owns the request sequence and the
// provenance record, and it is entirely provider-agnostic - it calls the
// contract and nothing else. If a step here mentions a selector, it belongs
// in a provider.

import { existsSync, statSync } from 'node:fs'
import { attachBrowser } from './core/chrome.mjs'
import { TabPool } from './core/pool.mjs'
import { loadConfig, portFor, providerSettings } from './core/config.mjs'
import { logger, requestId } from './core/log.mjs'
import { RequestError, SignedOutError } from './core/errors.mjs'
import { providerClass, providerIds } from './providers/registry.mjs'

export class Session {
  #ctx
  #pool
  #provider
  #settings
  #log

  constructor({ provider, settings, ctx, pool, log }) {
    this.#provider = provider
    this.#settings = settings
    this.#ctx = ctx
    this.#pool = pool
    this.#log = log
  }

  static async open(id, { cfg = loadConfig(), headless } = {}) {
    const Class = providerClass(id)
    if (!Class) throw new RequestError(`Unknown provider "${id}". Known: ${providerIds.join(', ')}`)

    const log = logger(id)
    const settings = providerSettings(cfg, id, Class.defaults)
    const url = Class.selectors.url
    const { ctx } = await attachBrowser({
      port: portFor(cfg, id, providerIds.indexOf(id)),
      userDataDir: settings.profileDir,
      headless: headless ?? cfg.headless,
      // Some providers expose their original markdown only through the
      // message Copy button, which needs clipboard permission.
      clipboardOrigins: [new URL(url).origin],
    })

    const provider = new Class({ selectors: Class.selectors, settings: { ...settings, url }, log })
    const pool = new TabPool(ctx, { max: settings.concurrency, name: `pool:${id}` })
    return new Session({ provider, settings, ctx, pool, log })
  }

  get id() {
    return this.#provider.id
  }

  get capabilities() {
    return this.#provider.capabilities()
  }

  get stats() {
    return this.#pool.stats
  }

  /** Is a human signed in? Cheap enough to call before a batch. */
  async signedIn() {
    return this.#pool.withTab(async (page) => {
      await this.#provider.open(page).catch(() => {})
      return this.#provider.isSignedIn(page)
    })
  }

  /**
   * Can the page reach the system clipboard?
   *
   * Worth checking explicitly: it is a machine-global resource, it can fail
   * independently of this code, and when it does the copy path degrades
   * silently to a lower extraction tier.
   */
  async clipboardHealthy() {
    return this.#pool.withTab(async (page) => {
      await this.#provider.open(page)
      const token = `uibridge-${Date.now()}`
      return page
        .evaluate(async (t) => {
          try {
            await navigator.clipboard.writeText(t)
            return (await navigator.clipboard.readText()) === t
          } catch {
            return false
          }
        }, token)
        .catch(() => false)
    })
  }

  /**
   * Run one prompt.
   *
   * Attachments are validated BEFORE a tab is taken: a typo in a path used to
   * occupy a tab and burn the full upload timeout before failing, so a
   * three-second mistake cost three minutes.
   */
  async ask({ prompt, files = [], model = null, modes = {} }) {
    if (!prompt || !prompt.trim()) throw new RequestError('prompt is empty')

    const resolved = files.map((f) => {
      if (!existsSync(f)) throw new RequestError(`attachment not found: ${f}`)
      if (!statSync(f).isFile()) throw new RequestError(`attachment is not a file: ${f}`)
      return f
    })

    const rid = requestId()
    const log = this.#log.child(rid)
    const started = Date.now()

    return this.#pool.withTab(async (page) => {
      const provider = this.#provider
      provider.log = log

      await provider.open(page)
      if (!(await provider.isSignedIn(page))) throw new SignedOutError(this.id)
      if (this.#settings.newChatPerRequest) await provider.newConversation(page)

      // Model and modes first: on some providers they cannot be changed once
      // a thread has started, and provenance must describe the turn we send.
      const provenance = { model: null, modes: {}, final_state: null }
      if (model) provenance.model = await provider.selectModel(page, model)
      for (const [key, on] of Object.entries(modes)) {
        provenance.modes[key] = await provider.setMode(page, key, on)
      }
      // Read the UI's state ONCE MORE, after everything is applied. The
      // per-step labels are stale by now: on a combined picker the label
      // captured while choosing the model predates any mode toggled after
      // it, which made thinking on/off read exactly backwards.
      if (model || Object.keys(modes).length) {
        provenance.final_state = await provider.readState(page).catch(() => null)
      }

      if (resolved.length) await provider.attach(page, resolved)

      const ctx = { turnsBefore: await provider.turnCount?.(page) ?? (await countTurns(page, provider)) }
      await provider.submit(page, prompt)
      const tSubmit = Date.now()

      await provider.awaitCompletion(page, ctx)
      const result = await provider.extract(page, ctx)

      log.info(
        `${result.text.length} chars in ${((Date.now() - tSubmit) / 1000).toFixed(1)}s ` +
          `(${result.extraction ?? (result.markdown ? 'markdown' : 'rendered')}` +
          `${result.files.length ? `, ${result.files.length} file(s)` : ''}` +
          `${result.sources.length ? `, ${result.sources.length} source(s)` : ''})`
      )

      return { ...result, provenance, request_id: rid, elapsed_ms: Date.now() - started }
    })
  }

  async close() {
    await this.#pool.close()
  }
}

/** Turn count before submitting, so we can identify the new turn. */
async function countTurns(page, provider) {
  const sel = provider.constructor.selectors?.responseBlocks
  if (!sel) return 0
  return page
    .locator(sel)
    .count()
    .catch(() => 0)
}
