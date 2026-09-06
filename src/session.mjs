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
import { BridgeError, ChallengeError, RequestError, SignedOutError } from './core/errors.mjs'
import { signedOutMessage } from './core/auth.mjs'
import { Pacer, retry } from './core/async.mjs'
import { providerClass, providerIds } from './providers/registry.mjs'

export class Session {
  #ctx
  #pool
  #provider
  #settings
  #log
  #pacer

  constructor({ provider, settings, ctx, pool, log }) {
    this.#provider = provider
    this.#settings = settings
    this.#ctx = ctx
    this.#pool = pool
    this.#log = log
    this.#pacer = new Pacer(settings.minIntervalMs ?? 0)
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

  /**
   * The session verdict WITH its evidence.
   *
   * Returns the state rather than a boolean because "not signed in" is not
   * actionable on its own - what makes it actionable is naming what was
   * observed and what to type next.
   */
  async sessionState() {
    return this.#pool.withTab(async (page) => {
      await this.#provider.open(page).catch(() => {})
      return this.#provider.sessionState(page)
    })
  }

  async signedIn() {
    return (await this.sessionState()).state === 'in'
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

    // Retry only failures a second attempt can genuinely fix, and only once:
    //   compose_failed  the prompt never reached the composer
    //   submit_failed   it was typed but the send did not take
    // Both mean the turn never happened, so retrying costs nothing and can
    // only help. Timeouts are NOT retried - the model was working, and
    // repeating a ten-minute wait costs the caller far more than it can
    // recover. Nor is a "something went wrong" turn: that is a message the
    // UI produced and we retrieved, so it is delivered with
    // `provider_error: true` and the caller decides. Each attempt gets a
    // fresh tab, because withTab discards a failed one.
    const RETRYABLE = new Set(['compose_failed', 'submit_failed'])
    return retry(
      () => this.#attempt({ prompt, files: resolved, model, modes, rid, log, started }),
      {
        attempts: 2,
        isRetryable: (e) => RETRYABLE.has(e.code),
        onRetry: (e) => log.warn(`retrying once after ${e.code}`),
      }
    )
  }

  async #attempt({ prompt, files, model, modes, rid, log, started }) {
    const resolved = files
    // Pace BEFORE taking a tab, so a queued request holds nothing while it
    // waits and the spacing applies across the whole provider.
    const waited = await this.#pacer.wait()
    if (waited > 1000) log.debug(`paced: waited ${(waited / 1000).toFixed(1)}s (minIntervalMs=${this.#pacer.intervalMs})`)
    return this.#pool.withTab(async (page) => {
      const provider = this.#provider
      provider.log = log

      await provider.open(page)
      // The state, not a boolean: the caller is told WHAT was observed, which
      // is the difference between an argument and an instruction.
      const session = await provider.sessionState(page)
      if (session.state === 'challenge') throw new ChallengeError(this.id, session.evidence?.challengeText ?? 'a verification challenge')
      if (session.state !== 'in') throw new SignedOutError(this.id, signedOutMessage(this.id, session))
      if (this.#settings.newChatPerRequest) await provider.newConversation(page)

      // A rate-limit notice is a fact to carry, not a reason to stop: on
      // ChatGPT new chats still answer while it shows. It is logged and
      // returned so a batch can slow down, and so that nobody reads the
      // symptom as a login or selector problem.
      const throttled = await provider.throttleNotice?.(page).catch(() => null)
      if (throttled) log.warn(`the site is rate-limiting this account: "${throttled}" - continuing, but slow down`)

      // Model and modes first: on some providers they cannot be changed once
      // a thread has started, and provenance must describe the turn we send.
      const provenance = { model: null, modes: {}, final_state: null }
      if (model) {
        provenance.model = await provider.selectModel(page, model)
        if (this.#settings.strictModel && provenance.model.verified === false) {
          throw new BridgeError(
            `${this.id}: asked for "${model}" but the UI reports ` +
              `"${provenance.model.applied ?? 'unknown'}". Refusing rather than answering ` +
              'with a model the caller did not request (strictModel is on).',
            { status: 502, code: 'model_not_applied', retryable: true }
          )
        }
      }
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
      await provider.submit(page, prompt, ctx)
      const tSubmit = Date.now()

      await provider.awaitCompletion(page, ctx)
      const result = await provider.extract(page, ctx)

      // THE MODEL THAT ANSWERED, when the transport can see it. A wire
      // transport reads the server's own slug off the response; that is the
      // fact a methods section needs, and it outranks any picker label.
      if (result.sent_as) provenance.sent_as = result.sent_as
      if (result.sent_effort !== undefined) provenance.sent_effort = result.sent_effort ?? null
      if (result.model_slug) {
        provenance.answered_by = result.model_slug
        const expected = provenance.model?.expected_slug
        if (expected) {
          const slugOk = new RegExp(expected).test(result.model_slug)
          // Two efforts can share a slug (ChatGPT sends gpt-5-6-thinking for
          // both Média and Alta); the request's own effort field tells them
          // apart, so it is part of the verification when the model asks.
          const wantEffort = provenance.model.expected_effort
          const effortOk = wantEffort === undefined || (wantEffort ?? null) === (result.sent_effort ?? null)
          const hit = slugOk && effortOk
          provenance.model.verified = hit
          const sentDesc = `${result.model_slug}${result.sent_effort ? ` at ${result.sent_effort} effort` : ''}`
          provenance.model.note = hit
            ? `the server confirms ${sentDesc} answered`
            : `asked for ${model} but the page sent ${sentDesc}`
          if (!hit) log.warn(provenance.model.note)
          if (!hit && this.#settings.strictModel) {
            throw new BridgeError(`${this.id}: ${provenance.model.note} (strictModel is on)`, {
              status: 502,
              code: 'model_not_applied',
              retryable: true,
            })
          }
        }
      }

      log.info(
        `${result.text.length} chars in ${((Date.now() - tSubmit) / 1000).toFixed(1)}s ` +
          `(${result.extraction ?? (result.markdown ? 'markdown' : 'rendered')}` +
          `${result.files.length ? `, ${result.files.length} file(s)` : ''}` +
          `${result.sources.length ? `, ${result.sources.length} source(s)` : ''})`
      )

      return { ...result, provenance, throttle_notice: throttled ?? null, request_id: rid, elapsed_ms: Date.now() - started }
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
