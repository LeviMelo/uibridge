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
import { Pacer, retry, waitFor, waitStable } from './core/async.mjs'
import { providerClass, providerIds } from './providers/registry.mjs'
import { recordThreadEvent } from './core/ledger.mjs'

export class Session {
  #ctx
  #pool
  #provider
  #settings
  #log
  #pacer
  #continuationPacer

  constructor({ provider, settings, ctx, pool, log }) {
    this.#provider = provider
    this.#settings = settings
    this.#ctx = ctx
    this.#pool = pool
    this.#log = log
    this.#pacer = new Pacer(settings.minIntervalMs ?? 0)
    this.#continuationPacer = new Pacer(settings.continuationIntervalMs ?? 0)
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
      await this.#provider.prepareAuth(page)
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
  async ask({ prompt, files = [], model = null, modes = {}, onProgress = null, threadId = null }) {
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
      () => this.#attempt({ prompt, files: resolved, model, modes, onProgress, threadId, rid, log, started }),
      {
        attempts: 2,
        isRetryable: (e) => RETRYABLE.has(e.code),
        onRetry: (e) => log.warn(`retrying once after ${e.code}`),
      }
    )
  }

  async #attempt({ prompt, files, model, modes, onProgress, threadId, rid, log, started }) {
    const resolved = files
    // Pace BEFORE taking a tab, so a queued request holds nothing while it
    // waits and the spacing applies across the whole provider.
    const pacer = threadId ? this.#continuationPacer : this.#pacer
    const waited = await pacer.wait()
    if (waited > 1000) log.debug(`paced: waited ${(waited / 1000).toFixed(1)}s (minIntervalMs=${this.#pacer.intervalMs})`)
    return this.#pool.withTab(async (page) => {
      const provider = this.#provider
      provider.log = log

      // The state, not a boolean: the caller is told WHAT was observed, which
      // is the difference between an argument and an instruction.
      await provider.prepareAuth(page)
      const session = await provider.sessionState(page)
      if (session.state === 'challenge') throw new ChallengeError(this.id, session.evidence?.challengeText ?? 'a verification challenge')
      if (session.state !== 'in') throw new SignedOutError(this.id, signedOutMessage(this.id, session))
      // Only authenticated sessions are allowed to touch the signed-in UI
      // contract. Anonymous apps often use a different composer entirely.
      await provider.open(page)
      const requestedThread = threadId
      if (requestedThread) {
        // A persistent CLI/API session keeps its pooled tab on the thread.
        // Reloading the same native URL for every follow-up is wasted work
        // and forces long history to hydrate again.
        if ((await provider.currentThread(page).catch(() => null)) !== requestedThread) {
          await provider.resumeThread(page, requestedThread)
          await provider.open(page)
        }
      } else if (this.#settings.newChatPerRequest) {
        await provider.newConversation(page)
      }

      // A blocking notice is a fact to carry, not a reason to stop: on
      // ChatGPT the rate-limit modal locks history, not sending. But it must
      // be CLOSED, because its backdrop swallows every click - including the
      // one that downloads a generated file.
      const notices = (await provider.dismissNotices?.(page).catch(() => [])) ?? []
      const throttled = notices.find((n) => n.kind === 'rate_limit')?.text ?? null

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

      // A resumed long thread hydrates asynchronously. Taking the baseline
      // while it still has zero responses makes the first old block look
      // like the new answer, so we wait for history before submitting.
      //
      // BUT WAITING IS NOT A PRECONDITION FOR SENDING. Measured on ChatGPT:
      // under the rate-limit lock the site keeps accepting new messages while
      // it stops serving previous conversations - exactly the state in which
      // this wait cannot succeed. Treating it as fatal attached the user's
      // file to the composer and then abandoned the turn unsent. On a
      // wire-reading provider the answer never came from these blocks
      // anyway; on a DOM one the baseline is merely less certain. So: try,
      // then send regardless, and say in the provenance which it was.
      if (requestedThread) {
        try {
          await waitFor(async () => (await provider.responseTexts(page)).length || null, {
            timeout: this.#settings.readyTimeoutMs, poll: this.#settings.pollMs,
            what: 'the existing thread history to load',
          })
          await waitStable(async () => JSON.stringify(await provider.responseTexts(page)), {
            checks: 3, timeout: this.#settings.readyTimeoutMs, poll: this.#settings.pollMs,
            what: 'the existing thread history to settle', accept: (value) => value !== '[]',
          })
          provenance.history = 'loaded'
        } catch (e) {
          provenance.history = 'not_loaded'
          log.warn(
            `the thread's previous messages did not render (${e.message}). Sending anyway - ` +
              (provider.wired
                ? 'the answer is read off the wire, so the baseline is not needed'
                : 'the answer is identified against a baseline that may be incomplete')
          )
        }
      }

      const ctx = {
        responseTextsBefore: await provider.responseTexts(page).catch(() => []),
        turnsBefore: await provider.turnCount?.(page) ?? (await countTurns(page, provider)),
        lastResponseBefore: await provider.lastResponseText(page).catch(() => null),
        threadIdsBefore: await provider.threadIds(page).catch(() => []),
        onProgress,
      }
      await provider.submit(page, prompt, ctx)
      const tSubmit = Date.now()

      await provider.awaitCompletion(page, ctx)
      const result = await provider.extract(page, ctx)

      // DOM transports cannot expose reliable partial markdown, but still
      // participate in the streaming API with one final content update.
      if (onProgress && !ctx.wire) onProgress(result.text)

      const answeredThread = await waitFor(() => provider.currentThread(page, ctx), {
        timeout: 10000,
        poll: this.#settings.pollMs,
        what: 'the provider to expose the answered thread URL',
      }).catch(() => null)
      if (!answeredThread) {
        throw new BridgeError(`${this.id}: the answer arrived but its UI thread could not be identified`, {
          status: 502, code: 'thread_unidentified', retryable: true,
        })
      }
      if (requestedThread && requestedThread !== answeredThread) {
        throw new BridgeError(`${this.id}: requested thread changed while sending; refusing to misattribute the answer`, {
          status: 502, code: 'thread_mismatch', retryable: true,
        })
      }

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

      const completed = {
        ...result,
        thread_id: answeredThread,
        provenance,
        throttle_notice: throttled ?? null,
        notices,
        request_id: rid,
        elapsed_ms: Date.now() - started,
      }
      try {
        const ledger = await recordThreadEvent(this.#settings.ledgerDir, {
          at: new Date().toISOString(), request_id: rid, provider: this.id,
          thread_id: answeredThread, requested_thread_id: requestedThread,
          model, modes, inputs: resolved, outputs: result.files,
          result: { characters: result.text.length, sha256: await textHash(result.text), extraction: result.extraction, truncated: !!result.truncated, provider_error: !!result.provider_error },
        })
        completed.ledger = { path: ledger.path }
      } catch (e) {
        log.warn(`could not write thread ledger: ${e.message}`)
        completed.ledger = { error: e.message }
      }
      return completed
    })
  }

  /** Export the complete active branch of one provider-native thread. */
  async exportThread(threadId) {
    if (!threadId) throw new RequestError('thread id is required')
    return this.#pool.withTab(async (page) => {
      const provider = this.#provider
      await provider.prepareAuth(page)
      const session = await provider.sessionState(page)
      if (session.state === 'challenge') throw new ChallengeError(this.id, session.evidence?.challengeText ?? 'a verification challenge')
      if (session.state !== 'in') throw new SignedOutError(this.id, signedOutMessage(this.id, session))
      await provider.resumeThread(page, threadId)
      await provider.open(page)
      const exported = await provider.exportThread(page, threadId)
      const actual = await provider.currentThread(page)
      if (actual !== threadId) throw new BridgeError(`${this.id}: export navigated away from the requested thread`, { status: 502, code: 'thread_mismatch' })
      return exported
    })
  }

  async close() {
    await this.#pool.close()
  }
}

async function textHash(text) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text).digest('hex')
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
