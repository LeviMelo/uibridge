// Tab pool.
//
// One browser tab can serve one request at a time, so concurrency means
// several tabs. The pool exists because the alternative - serialising every
// request behind one tab - wasted most of the benefit of using a fast model:
// six independent prompts took six times as long for no reason.
//
// It is deliberately small and dumb: acquire, release, cap. No pre-warming,
// no idle reaping, no health checks. Tabs are cheap and the failure mode of
// clever pooling (handing out a broken tab) is worse than opening a new one.

import { logger } from './log.mjs'
import { BridgeError, classifyBrowserError } from './errors.mjs'
import { abortable, checkCancelled, currentSignal } from './cancel.mjs'

export class TabPool {
  #ctx
  #max
  #idle = []
  #busy = new Set()
  #waiters = []
  #log
  #opening = new Set()
  #closed = false
  #closing

  constructor(ctx, { max = 2, name = 'pool' } = {}) {
    this.#ctx = ctx
    if (!Number.isInteger(max) || max < 1) throw new RangeError('pool max must be a positive integer')
    this.#max = max
    this.#log = logger(name)
  }

  get stats() {
    return { tabs: this.#idle.length + this.#busy.size, busy: this.#busy.size, waiting: this.#waiters.length }
  }

  async acquire(signal = currentSignal()) {
    checkCancelled(signal)
    if (this.#closed) throw this.#closedError()
    const result = new Promise((resolve, reject) => {
      const waiter = { signal,
        resolve: (page) => { cleanup(); resolve(page) },
        reject: (err) => { cleanup(); reject(err) },
      }
      const cancel = () => {
        const index = this.#waiters.indexOf(waiter)
        if (index !== -1) this.#waiters.splice(index, 1)
        try { checkCancelled(signal) } catch (err) { waiter.reject(err) }
      }
      const cleanup = () => signal?.removeEventListener('abort', cancel)
      signal?.addEventListener('abort', cancel, { once: true })
      this.#waiters.push(waiter)
    })
    this.#pump()
    return result
  }

  /**
   * Return a tab. `discard` closes it instead of recycling it.
   *
   * A request that failed may have left the page mid-dialog, mid-upload or on
   * an error state, and handing that tab to the next caller makes ONE failure
   * become every subsequent failure - with a misleading symptom each time.
   * Tabs are cheap; a poisoned pool is not.
   */
  release(page, { discard = false } = {}) {
    if (!this.#busy.delete(page)) return
    if (discard && !page.isClosed()) {
      this.#log.debug('discarding a tab after a failed request')
      page.close().catch(() => {})
      return this.#pump()
    }
    if (page.isClosed()) return this.#pump()
    this.#idle.push(page)
    this.#pump()
  }

  /**
   * Borrow a tab for `fn`. A tab is always returned; one whose request threw
   * is discarded rather than recycled.
   */
  async withTab(fn, { signal = currentSignal() } = {}) {
    const page = await this.acquire(signal)
    let failed = false
    const cancel = () => { page.close().catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      checkCancelled(signal)
      return await abortable(Promise.resolve().then(() => { checkCancelled(signal); return fn(page) }), signal)
    } catch (e) {
      failed = true
      // FOREIGN ERRORS BECOME OURS HERE. Everything that touches the browser
      // passes through this method, and Playwright reports "the wifi dropped"
      // as an untyped Error, which the API could only render as HTTP 500
      // "internal" - telling the caller that uibridge is broken when the truth
      // is that the network is. Translating once, at the boundary, gives the
      // HTTP layer, the CLI and the durable request layer (which decides
      // whether a retry is even sensible) the same verdict. An unrecognised
      // error is re-thrown untouched: a real bug must stay a 500.
      throw classifyBrowserError(e) ?? e
    } finally {
      signal?.removeEventListener('abort', cancel)
      this.release(page, { discard: failed })
    }
  }

  close() {
    if (this.#closing) return this.#closing
    this.#closed = true
    for (const w of this.#waiters.splice(0)) w.reject(this.#closedError())
    const pages = [...this.#idle, ...this.#busy]
    this.#idle = []
    this.#busy.clear()
    this.#closing = Promise.allSettled([
      ...pages.map((p) => p.close()), ...this.#opening,
    ]).then(() => {})
    return this.#closing
  }

  get #total() {
    return this.#idle.length + this.#busy.size + this.#opening.size
  }

  #closedError() {
    return new BridgeError('Tab pool is closed', { status: 503, code: 'pool_closed' })
  }

  /** A closed tab freed capacity: let a waiter open a fresh one. */
  #pump() {
    if (this.#closed) return
    while (this.#waiters.length) {
      const page = this.#idle.pop()
      if (page) {
        if (page.isClosed()) continue
        this.#busy.add(page)
        this.#waiters.shift().resolve(page)
        continue
      }
      if (this.#total >= this.#max) return
      const next = this.#waiters.shift()
      // Reserve capacity before newPage yields. Deliver ownership before
      // resolving the waiter so another acquire cannot steal its slot.
      const opening = Promise.resolve().then(() => this.#ctx.newPage()).then(async (page) => {
        if (this.#closed || next.signal?.aborted) {
          if (this.#closed) next.reject(this.#closedError())
          await page.close().catch(() => {})
        } else {
          this.#busy.add(page)
          next.resolve(page)
        }
      }, (err) => next.reject(err)).finally(() => {
        this.#opening.delete(opening)
        this.#pump()
      })
      this.#opening.add(opening)
    }
  }
}
