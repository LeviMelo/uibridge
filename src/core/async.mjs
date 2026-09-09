// Async primitives.
//
// TIMING POLICY, and it is deliberate: nothing in the request path sleeps for
// a fixed period to "let things settle". Every wait is a condition with a
// budget. Padding hides races instead of fixing them, and it taxes every
// single request - which matters here because the whole point of using Flash
// is speed.
//
// `sleep` exists only as the poll interval inside `waitFor`, and in tooling.

import { TimeoutError } from './errors.mjs'
import { abortable, checkCancelled, currentSignal } from './cancel.mjs'
import { setTimeout as delay } from 'node:timers/promises'

export const sleep = async (ms, signal = currentSignal()) => {
  checkCancelled(signal)
  try { await delay(ms, undefined, { signal }) } catch (err) { checkCancelled(signal); throw err }
}

/**
 * Poll `probe` until it returns truthy. Returns that value.
 *
 * A probe that THROWS is treated as "not yet", not as failure: DOM reads race
 * with re-renders constantly, and one detached-node error should not abort a
 * request. The exception is preserved and attached if we do time out, so the
 * cause is not lost.
 */
export async function waitFor(probe, { timeout = 30000, poll = 150, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let lastErr = null
  while (Date.now() < deadline) {
    checkCancelled()
    try {
      const v = await probe()
      if (v) return v
    } catch (e) {
      checkCancelled()
      lastErr = e
    }
    await sleep(poll)
  }
  const err = new TimeoutError(what, timeout)
  if (lastErr) err.detail = lastErr.message.split('\n')[0]
  throw err
}

/**
 * Wait for a value to stop changing.
 *
 * Used as a completion signal only where a provider exposes no explicit
 * "generating" control. `checks` consecutive identical reads means done -
 * that is a measurement of stability, not a delay.
 */
export async function waitStable(read, { checks = 3, timeout = 600000, poll = 150, accept = () => true, what = 'output to settle' } = {}) {
  const deadline = Date.now() + timeout
  let last = null
  let same = 0
  while (Date.now() < deadline) {
    checkCancelled()
    const v = await read().catch(() => last)
    same = v === last ? same + 1 : 0
    last = v
    if (same >= checks && accept(v)) return v
    await sleep(poll)
  }
  throw new TimeoutError(what, timeout)
}

/**
 * A mutual-exclusion lock.
 *
 * Needed for genuinely shared resources. The system clipboard is the live
 * example: it is one buffer for the whole OS, so two tabs copying at once
 * read each other's text - which under concurrency looks exactly like the
 * model answering the wrong question.
 */
export class Mutex {
  #tail = Promise.resolve()

  run(fn, signal = currentSignal()) {
    const invoke = () => { checkCancelled(signal); return fn() }
    const result = this.#tail.then(invoke, invoke)
    // Swallow rejection on the CHAIN only, so one failure does not poison
    // every later waiter, while the caller still sees its own error.
    this.#tail = result.then(
      () => {},
      () => {}
    )
    return abortable(result, signal)
  }
}

/** Run `fn`, retrying only errors it is worth retrying. */
export async function retry(fn, { attempts = 2, isRetryable = (e) => !!e.retryable, onRetry } = {}) {
  let last
  for (let i = 0; i < attempts; i++) {
    checkCancelled()
    try {
      return await fn(i)
    } catch (e) {
      last = e
      if (i === attempts - 1 || !isRetryable(e)) throw e
      onRetry?.(e, i + 1)
    }
  }
  throw last
}

/**
 * Space request STARTS at least `intervalMs` apart, across everything that
 * shares this pacer.
 *
 * This exists because a burst of fresh conversations - a dozen in fifteen
 * minutes, each a full page load - tripped ChatGPT's throttling during
 * calibration. The site's abuse heuristics are not something to probe, and
 * a batch pipeline is exactly the caller that would otherwise fire hundreds
 * of requests back to back. The pacer is provider-wide, not per tab, so
 * concurrency does not defeat it.
 */
export class Pacer {
  #interval
  #next = 0
  #chain = Promise.resolve()

  constructor(intervalMs = 0) {
    this.#interval = Math.max(0, intervalMs)
  }

  get intervalMs() {
    return this.#interval
  }

  /** Resolves when it is this caller's turn; returns the ms it waited. */
  wait(signal = currentSignal()) {
    const turn = this.#chain.then(async () => {
      checkCancelled(signal)
      const now = Date.now()
      const delay = Math.max(0, this.#next - now)
      if (delay) await sleep(delay, signal)
      checkCancelled(signal)
      this.#next = Date.now() + this.#interval
      return delay
    })
    this.#chain = turn.catch(() => {})
    return abortable(turn, signal)
  }
}
