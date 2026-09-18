// UPLOADS IN FLIGHT: attachments the prompt is sent alongside, not after.
//
// Where a provider's upload is visible on the network (selectors.json
// `wire.upload`), each file ends in one confirmation request whose body says
// whether the site accepted it. The original flow waited for every one of
// them before typing a word. With `sendDuringUpload` the prompt is typed and
// sent while they are still running, and this object keeps watching them for
// the rest of the request, so that a file the site REFUSED still ends the
// request as `upload_failed` - before the send when the refusal is already
// in, after it when it is not - instead of returning an answer about a file
// the model never received.
//
// It owns the collector from the moment attach() hands it over and releases
// it when a verdict is in, when the upload budget runs out, or when the
// request ends (stop()). Nothing here sleeps: every wait is woken by the
// collector's own events.

import { BridgeError } from '../core/errors.mjs'
import { currentSignal, withCancellation } from '../core/cancel.mjs'

/** Refused: a non-2xx or failed load, or a body without the ready marker. */
export function refusedUploads(done, ready = null) {
  return done.filter((u) => !u.ok || (ready && !ready.test(u.body)))
}

/**
 * The error a refused upload becomes. One shape whether or not the prompt
 * had gone out; `prompt_sent` says which, because on a continued thread a
 * retry after a send types the same prompt into the thread a second time.
 */
export function uploadRefused(provider, failed, expected, { sent = false } = {}) {
  return new BridgeError(
    `${provider}: ${failed.length} of ${expected} upload(s) were refused by the site ` +
      `(HTTP ${failed.map((u) => u.status ?? u.error).join(', ')})` +
      (sent
        ? '. The prompt had already been sent, so its answer is not returned: it would be about a file the model never received.'
        : ''),
    { status: 502, code: 'upload_failed', retryable: true, detail: { refused: failed.length, expected, prompt_sent: sent } }
  )
}

/** A signal that fires when the request is cancelled OR when `own` does. */
const joined = (own) => {
  const request = currentSignal()
  return request ? AbortSignal.any([request, own]) : own
}

export class UploadWatch {
  #capture
  #ready
  #stop = new AbortController()
  #listeners = new Set()

  /**
   * `capture` is a many-mode collector armed BEFORE the files were handed to
   * the page. `budgetMs` is the same per-file upload budget the waiting flow
   * uses, counted from `now`; `ready` is the provider's `uploadReady` marker.
   */
  constructor(capture, { expected, budgetMs, ready = null, now = Date.now() }) {
    this.#capture = capture
    this.#ready = ready
    this.expected = expected
    this.budgetMs = budgetMs
    this.deadline = now + budgetMs
    // When the last upload request went out, and when the last confirmation
    // arrived; null until every file has got that far.
    this.registeredAt = null
    this.confirmedAt = null
    withCancellation(joined(this.#stop.signal), () =>
      capture.until(() => this.#verdict(), budgetMs, `${expected} upload(s) to be confirmed`))
      .then((v) => {
        if (v.refused) for (const fn of this.#listeners) fn(v.refused)
        else this.confirmedAt = Date.now()
      }, () => {
        // The budget ran out or the request ended. Nothing is lost: every
        // question below is answered from the records, not from this watch.
      })
      .finally(() => capture.stop())
  }

  // Re-read on every upload request and response, so the stamps are the
  // moments those events arrived, not the moments someone asked.
  #verdict() {
    if (this.registeredAt == null && this.started() >= this.expected) this.registeredAt = Date.now()
    const done = this.#capture.completed()
    const refused = refusedUploads(done, this.#ready)
    if (refused.length) return { refused }
    return done.length >= this.expected ? { confirmed: done.length } : null
  }

  /** Upload requests the page has sent, finished or not. */
  started() {
    return this.#capture.requestCount()
  }

  /** Uploads the site has finished answering, accepted or not. */
  finished() {
    return this.#capture.completed().length
  }

  /** The refusals seen so far, or null. */
  refused() {
    const r = refusedUploads(this.#capture.completed(), this.#ready)
    return r.length ? r : null
  }

  /** The budget has run out and not every file was confirmed. */
  expired(now = Date.now()) {
    return this.confirmedAt == null && now > this.deadline
  }

  /**
   * Wait until every upload request has gone out, or one was refused, or
   * the budget is spent. Returns what was seen, never throws on a timeout:
   * the caller names the failure, because only it knows what was sent.
   */
  async registered() {
    const left = Math.max(0, this.deadline - Date.now())
    try {
      await withCancellation(joined(this.#stop.signal), () =>
        this.#capture.until(() => this.started() >= this.expected || this.refused(), left, `${this.expected} upload(s) to start`))
    } catch (e) {
      if (e?.code !== 'timeout') throw e
    }
    return { started: this.started(), finished: this.finished(), refused: this.refused() }
  }

  /**
   * Run `work`; the moment a refusal arrives, cancel it with the error
   * `errorFor(refused)` builds. Every wait in the request path checks the
   * current signal, so the answer wait ends on the refusal itself rather
   * than on its own timeout.
   */
  async guard(work, errorFor) {
    const own = new AbortController()
    const refuse = (failed) => own.abort(errorFor(failed))
    this.#listeners.add(refuse)
    const already = this.refused()
    if (already) refuse(already)
    try {
      return await withCancellation(joined(own.signal), work)
    } finally {
      this.#listeners.delete(refuse)
    }
  }

  /** Stop watching; the collector is released. Idempotent. */
  stop() {
    this.#stop.abort()
    this.#capture.stop()
  }
}
