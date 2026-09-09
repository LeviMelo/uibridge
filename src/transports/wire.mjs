// WIRE TRANSPORT: read what the page receives, instead of what it renders.
//
// The page is still the thing that sends. Nothing here composes a request,
// forges a header or replays a token - the composer is typed into and the
// send button clicked exactly as before. What changes is where the answer is
// READ from: a CDP tap on the tab watches the response the site streams to
// its own JavaScript, and that body is the model's markdown source, its
// citations with their positions, and the slug of the model that answered.
//
// Why this beats the DOM wherever it is available:
//   - it is indifferent to class names, translations and layout;
//   - it needs no clipboard, so concurrency has nothing to serialise on;
//   - it carries facts the DOM never shows honestly (which model answered);
//   - "done" is the connection closing, not text holding still for a while.
//
// HOW IT IS USED (see DomProvider):
//   const tap = await WireTap.attach(page)
//   const cap = tap.expect(/backend-api\/f\/conversation/)   // BEFORE sending
//   ...type, click send...
//   await cap.request(8000)      // proof the send took: the request went out
//   const res = await cap.finished(timeoutMs)                // the whole body
//
// THE ONE CDP RULE: subscribe with Network.streamResourceContent at
// responseReceived. A streamed body is not retained, so asking for it after
// the fact returns nothing for precisely the response worth having.
//
// BYTES, NOT STRINGS. Chunks arrive base64-encoded and can split a multibyte
// character - a pt-BR accent, or one of the private-use citation sentinels.
// Decoding chunk by chunk corrupts exactly those, so buffers are joined
// first and decoded once.

import { TimeoutError } from '../core/errors.mjs'
import { checkCancelled, currentSignal } from '../core/cancel.mjs'

const taps = new WeakMap()

export class WireTap {
  #client
  #watchers = new Set()
  #requests = new Map()
  #recent = []

  /** One tap per tab, attached lazily and kept for the tab's lifetime. */
  static async attach(page) {
    if (taps.has(page)) return taps.get(page)
    const client = await page.context().newCDPSession(page)
    const tap = new WireTap(client)
    await tap.#enable()
    taps.set(page, tap)
    page.once('close', () => {
      taps.delete(page)
      client.detach().catch(() => {})
    })
    return tap
  }

  constructor(client) {
    this.#client = client
  }

  /** A tap over any CDP-shaped client ({ send, on }); what the tests use. */
  static async fromClient(client) {
    const tap = new WireTap(client)
    await tap.#enable()
    return tap
  }

  async #enable() {
    const client = this.#client
    await client.send('Network.enable', {
      maxResourceBufferSize: 64 * 1024 * 1024,
      maxTotalBufferSize: 256 * 1024 * 1024,
    })

    client.on('Network.requestWillBeSent', (e) => {
      // A REDIRECT REUSES THE REQUEST ID. Chrome re-fires this event with a
      // redirectResponse, and treating it as a new request loses the
      // watchers attached to the original: the capture then waits forever
      // for a response that already arrived under a URL it stopped
      // following. Keep the record, move it to the new URL.
      const prior = this.#requests.get(e.requestId)
      if (e.redirectResponse && prior) {
        prior.redirects = (prior.redirects ?? 0) + 1
        prior.url = e.request.url
        prior.chunks = []
        return
      }
      // Path only: a signed download URL carries a credential in its query,
      // and this list is written to logs.
      try {
        this.#recent.push(new URL(e.request.url).pathname)
        if (this.#recent.length > 40) this.#recent.shift()
      } catch {
        /* not a parseable URL; nothing to record */
      }
      const rec = {
        id: e.requestId,
        url: e.request.url,
        method: e.request.method,
        // The page's own request body - what the UI actually asked for. Small
        // bodies ride along with the event; larger ones are fetched on demand
        // in postData() and can be evicted, so it is best-effort.
        postData: e.request.postData ?? null,
        hasPostData: !!e.request.hasPostData,
        status: null,
        mime: null,
        chunks: [],
        done: false,
        error: null,
        watchers: [],
      }
      for (const w of this.#watchers) {
        if (w.matches(rec)) {
          rec.watchers.push(w)
          w.onRequest(rec)
        }
      }
      // Only requests someone is waiting for are kept; the rest of the
      // page's traffic is not this module's business.
      if (rec.watchers.length) this.#requests.set(rec.id, rec)
    })
    this.postData = async (rec) => {
      if (rec.postData != null || !rec.hasPostData) return rec.postData
      try {
        rec.postData = (await client.send('Network.getRequestPostData', { requestId: rec.id })).postData
      } catch {
        rec.postData = null
      }
      return rec.postData
    }

    client.on('Network.responseReceived', async (e) => {
      const rec = this.#requests.get(e.requestId)
      if (!rec) return
      rec.status = e.response.status
      rec.mime = e.response.mimeType
      // AN ALLOWLIST, not the header bag. Response headers can carry
      // set-cookie and other credentials, and a snapshot ends up in logs and
      // error bodies. Only the three that describe the payload are kept -
      // content-disposition is how a generated file learns its real name.
      const h = e.response.headers ?? {}
      rec.headers = {}
      for (const [k, v] of Object.entries(h)) {
        if (/^content-(type|disposition|length)$/i.test(k)) rec.headers[k.toLowerCase()] = v
      }
      try {
        const s = await client.send('Network.streamResourceContent', { requestId: e.requestId })
        if (s.bufferedData) rec.chunks.push(Buffer.from(s.bufferedData, 'base64'))
      } catch {
        // Not streamable (already complete, or a non-body response): fetched
        // whole at loadingFinished instead.
        rec.unstreamed = true
      }
    })

    client.on('Network.dataReceived', (e) => {
      const rec = this.#requests.get(e.requestId)
      if (rec && e.data) rec.chunks.push(Buffer.from(e.data, 'base64'))
    })

    const finish = async (requestId, error) => {
      const rec = this.#requests.get(requestId)
      if (!rec) return
      // ASK FOR THE BODY IF STREAMING GAVE US NOTHING. A subscription can
      // succeed and still deliver no data events - measured on the file
      // download endpoints, which answered 200 with the right
      // content-disposition and zero bytes in the stream, so a real CSV
      // arrived as an empty file. Emptiness, not the subscription's return
      // value, is the condition worth testing.
      const empty = !rec.chunks.length || !Buffer.concat(rec.chunks).length
      if (empty && !error) {
        try {
          const got = await client.send('Network.getResponseBody', { requestId })
          rec.chunks = [Buffer.from(got.body, got.base64Encoded ? 'base64' : 'utf8')]
        } catch {
          /* nothing retained; the caller sees zero bytes and says so */
        }
      }
      rec.done = true
      rec.error = error ?? null
      this.#requests.delete(requestId)
      for (const w of rec.watchers) w.onFinish(rec)
    }
    client.on('Network.loadingFinished', (e) => finish(e.requestId, null))
    client.on('Network.loadingFailed', (e) => finish(e.requestId, e.errorText || 'loading failed'))
  }

  /**
   * The paths of recent requests, for when a capture times out.
   *
   * "Nothing matched" is not a diagnosis; "here is what the page did ask
   * for" is. Paths only - a signed URL's query string is a credential.
   */
  seen() {
    return [...this.#recent]
  }

  /**
   * Wait for ONE request whose URL matches, sent after this call.
   *
   * Arm it before the action that triggers the request - a capture armed
   * afterwards can only ever see the next one.
   */
  expect(pattern) {
    const cap = new Capture(pattern, { many: false, tap: this })
    this.#watchers.add(cap)
    cap.release = () => this.#watchers.delete(cap)
    return cap
  }

  /**
   * Collect EVERY matching request from now on, e.g. one upload per file.
   *
   * `keep` bounds retention. A standing collector lives as long as its tab,
   * and a daemon's tab lives as long as the daemon, so an unbounded queue of
   * file bodies is a memory leak measured in megabytes per download.
   */
  collect(pattern, { keep = 24 } = {}) {
    const cap = new Capture(pattern, { many: true, tap: this, keep })
    this.#watchers.add(cap)
    cap.release = () => this.#watchers.delete(cap)
    return cap
  }
}

/**
 * The cheap half of a snapshot: everything except the bytes.
 *
 * Selecting a record must not cost a Buffer.concat per candidate - the
 * candidates are file bodies.
 */
function descriptor(rec) {
  return { url: rec.url, method: rec.method, status: rec.status, mime: rec.mime, headers: rec.headers ?? {} }
}

/** Plain data about one captured response. */
function snapshot(rec) {
  // BYTES FIRST. Chunks are joined as buffers and decoded once: decoding
  // each chunk would corrupt any multibyte character split across a chunk
  // boundary, and `buffer` is the only honest form for a generated .xlsx or
  // .pdf, where a utf8 round-trip destroys the payload.
  const buffer = Buffer.concat(rec.chunks)
  const body = buffer.toString('utf8')
  return {
    url: rec.url,
    method: rec.method,
    status: rec.status,
    mime: rec.mime,
    headers: rec.headers ?? {},
    buffer,
    ok: rec.status != null && rec.status >= 200 && rec.status < 300 && !rec.error,
    error: rec.error,
    done: rec.done,
    // The BUFFER's length, not the decoded string's: they differ for any
    // non-ASCII or binary body, and this field describes what arrived on
    // the wire rather than what it decoded to.
    bytes: buffer.length,
    body,
  }
}

class Capture {
  #pattern
  #many
  #tap
  #keep
  #records = []
  #waiters = []

  constructor(pattern, { many, tap = null, keep = Infinity }) {
    this.#pattern = pattern instanceof RegExp ? pattern : new RegExp(pattern)
    this.#many = many
    this.#tap = tap
    this.#keep = keep
    this.release = () => {}
  }

  /** The body the page sent with the (first) captured request, if retained. */
  async sentBody() {
    const rec = this.#records[0]
    if (!rec) return null
    return this.#tap ? this.#tap.postData(rec) : rec.postData
  }

  matches(rec) {
    if (!this.#many && this.#records.length) return false
    return this.#pattern.test(rec.url)
  }

  onRequest(rec) {
    this.#records.push(rec)
    // Evict oldest-first, and only records that are finished and claimed or
    // simply old: an in-flight record is still being written to.
    while (this.#records.length > this.#keep) {
      const i = this.#records.findIndex((r) => r.done)
      if (i === -1) break
      this.#records.splice(i, 1)
    }
    this.#notify()
  }

  onFinish() {
    this.#notify()
    if (!this.#many) this.release()
  }

  #notify() {
    for (const w of this.#waiters.splice(0)) w()
  }

  async #until(test, timeout, what) {
    const deadline = Date.now() + timeout
    while (true) {
      checkCancelled()
      const v = test()
      if (v) return v
      const left = deadline - Date.now()
      if (left <= 0) throw new TimeoutError(what, timeout)
      await new Promise((resolve, reject) => {
        const signal = currentSignal()
        const cleanup = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
          const index = this.#waiters.indexOf(wake)
          if (index !== -1) this.#waiters.splice(index, 1)
        }
        const wake = () => { cleanup(); resolve() }
        const cancel = () => { cleanup(); try { checkCancelled(signal) } catch (err) { reject(err) } }
        const timer = setTimeout(wake, Math.min(left, 500))
        this.#waiters.push(wake)
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) cancel()
      })
    }
  }

  /** The request has gone out. Proof that a send actually happened. */
  request(timeout = 8000) {
    return this.#until(() => (this.#records[0] ? snapshot(this.#records[0]) : null), timeout, `the ${this.#pattern} request to be sent`)
  }

  /** What has arrived so far, without waiting. */
  partial() {
    return this.#records[0] ? snapshot(this.#records[0]) : null
  }

  /** The response is complete: the connection closed or failed. */
  finished(timeout = 600000, onProgress = null) {
    return this.#until(
      () => {
        const rec = this.#records[0]
        if (!rec) return null
        // The same retained bytes used for the final answer are also safe to
        // inspect while the connection is open. The decoder deliberately
        // accepts an incomplete final SSE frame.
        if (onProgress) onProgress(snapshot(rec))
        return rec.done ? snapshot(rec) : null
      },
      timeout,
      `the ${this.#pattern} response to finish`
    )
  }

  /** many-mode: every matching request that has completed. */
  completed() {
    return this.#records.filter((r) => r.done).map(snapshot)
  }

  /**
   * many-mode: a completed record nobody has taken yet, matching `wanted`.
   *
   * WHY TAKING MATTERS. A standing collector may hold bytes that crossed the
   * wire before anyone asked for them - measured on ChatGPT, opening a
   * conversation pre-fetches its generated artifact during page load, so the
   * file is already captured by the time a caller clicks "download" and no
   * new request will EVER follow that click. Consuming records one at a time
   * lets a caller use those bytes, while two files on one turn still get one
   * body each instead of both getting the first.
   *
   * WHY `wanted` IS NOT OPTIONAL IN PRACTICE. A tab is long-lived and the
   * collector is standing, so its queue mixes unrelated bodies that share an
   * endpoint. MEASURED 2026-09-08: on a re-run against the same thread, the
   * FIRST unclaimed body on ChatGPT's estuary/content collector was the
   * user's own uploaded `_input.csv`, not the requested `audit_totals.csv` -
   * a blind FIFO take returned the wrong file and reported success. In a
   * literature pipeline that is a wrong table with a plausible name on it.
   * Callers therefore pass a predicate and get nothing rather than
   * something.
   */
  take(wanted = null) {
    const rec = this.#records.find((r) => r.done && !r.taken && (!wanted || wanted(descriptor(r))))
    if (!rec) return null
    rec.taken = true
    const out = snapshot(rec)
    // The snapshot owns its own Buffer, so the retained chunks are dead
    // weight from here on.
    rec.chunks = []
    return out
  }

  /** many-mode: how many completed, unclaimed records match. */
  available(wanted = null) {
    return this.#records.filter((r) => r.done && !r.taken && (!wanted || wanted(descriptor(r)))).length
  }

  /** many-mode: wait for the next unclaimed matching record, then take it. */
  takeNext(timeout = 60000, wanted = null) {
    return this.#until(() => this.take(wanted), timeout, `an unclaimed ${this.#pattern} response`)
  }

  /** many-mode: wait until at least `n` matching requests have completed. */
  atLeast(n, timeout = 180000) {
    return this.#until(
      () => {
        const c = this.completed()
        return c.length >= n ? c : null
      },
      timeout,
      `${n} ${this.#pattern} request(s) to complete`
    )
  }

  stop() {
    this.release()
  }
}
