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

const taps = new WeakMap()

export class WireTap {
  #client
  #watchers = new Set()
  #requests = new Map()

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
      if (rec.unstreamed && !error) {
        try {
          const got = await client.send('Network.getResponseBody', { requestId })
          rec.chunks = [Buffer.from(got.body, got.base64Encoded ? 'base64' : 'utf8')]
        } catch {
          /* nothing retained */
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

  /** Collect EVERY matching request from now on, e.g. one upload per file. */
  collect(pattern) {
    const cap = new Capture(pattern, { many: true, tap: this })
    this.#watchers.add(cap)
    cap.release = () => this.#watchers.delete(cap)
    return cap
  }
}

/** Plain data about one captured response. */
function snapshot(rec) {
  const body = Buffer.concat(rec.chunks).toString('utf8')
  return {
    url: rec.url,
    method: rec.method,
    status: rec.status,
    mime: rec.mime,
    ok: rec.status != null && rec.status >= 200 && rec.status < 300 && !rec.error,
    error: rec.error,
    done: rec.done,
    bytes: Buffer.byteLength(body),
    body,
  }
}

class Capture {
  #pattern
  #many
  #tap
  #records = []
  #waiters = []

  constructor(pattern, { many, tap = null }) {
    this.#pattern = pattern instanceof RegExp ? pattern : new RegExp(pattern)
    this.#many = many
    this.#tap = tap
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
      const v = test()
      if (v) return v
      const left = deadline - Date.now()
      if (left <= 0) throw new TimeoutError(what, timeout)
      await new Promise((r) => {
        const t = setTimeout(r, Math.min(left, 500))
        this.#waiters.push(() => {
          clearTimeout(t)
          r()
        })
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
  finished(timeout = 600000) {
    return this.#until(
      () => (this.#records[0]?.done ? snapshot(this.#records[0]) : null),
      timeout,
      `the ${this.#pattern} response to finish`
    )
  }

  /** many-mode: every matching request that has completed. */
  completed() {
    return this.#records.filter((r) => r.done).map(snapshot)
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
