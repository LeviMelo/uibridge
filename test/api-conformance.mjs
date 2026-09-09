// IS THIS ACTUALLY AN OPENAI-COMPATIBLE API?
//
// That claim is the whole product: local programs are supposed to point their
// existing OpenAI client at uibridge and work. Until now it was asserted, not
// tested - what was tested was whether a frontier model could classify
// records, which is that vendor's business, not ours.
//
// Every case here checks OUR contract, against the real server, through the
// official `openai` SDK wherever the SDK is what a caller would use. The
// provider is scripted (src/providers/echo), so nothing is sent to any site,
// the run takes seconds, and a failure means uibridge is wrong rather than
// that a model had an off day.
//
//   node test/api-conformance.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'
import OpenAI from 'openai'
import { startEchoServer } from './support/echo.mjs'

const server = await startEchoServer()
const client = new OpenAI({ apiKey: 'local', baseURL: `${server.base}/v1`, maxRetries: 0, timeout: 30000 })
const post = (path, body, headers = {}) =>
  fetch(`${server.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const MODEL = 'echo-fast'

test.after(() => server.close())

// --- the response object ----------------------------------------------------

test('a completion is a well-formed chat.completion object', async () => {
  const r = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] })

  assert.match(r.id, /^chatcmpl-/, 'OpenAI ids are chatcmpl-prefixed and clients log them')
  assert.equal(r.object, 'chat.completion')
  assert.equal(typeof r.created, 'number')
  assert.ok(r.created > 1600000000 && r.created < 4000000000, 'created is unix SECONDS, not milliseconds')
  assert.equal(r.model, MODEL, 'the model echoed back is the one that was asked for')
  assert.equal(r.choices.length, 1)

  const [choice] = r.choices
  assert.equal(choice.index, 0)
  assert.equal(choice.message.role, 'assistant')
  assert.equal(typeof choice.message.content, 'string')
  assert.equal(choice.finish_reason, 'stop')
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) assert.equal(typeof r.usage[k], 'number')
})

test('the prompt arrives byte for byte, which is the whole job of a bridge', async () => {
  // Unicode, newlines, markdown, and the characters most likely to be eaten
  // by a rich-text composer or a JSON round trip.
  const payload = 'línea 1\n\ttab\n"quotes" & <angle> \\backslash\n| a | b |\nαβγ 中文 🧪 ✓'
  const r = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: payload }] })
  assert.equal(r.choices[0].message.content, payload)
})

test('multi-part content arrays are flattened, not dropped', async () => {
  // The OpenAI vision-style shape. A client library emits this whenever a
  // message is assembled from parts, and silently losing part of a prompt is
  // the worst failure this tool can have.
  const r = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }],
  })
  assert.match(r.choices[0].message.content, /first/)
  assert.match(r.choices[0].message.content, /second/)
})

test('system and prior assistant turns reach the provider', async () => {
  const r = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: 'SYS_MARKER' },
      { role: 'user', content: 'U1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'U2' },
    ],
  })
  const text = r.choices[0].message.content
  for (const marker of ['SYS_MARKER', 'U1', 'A1', 'U2']) assert.match(text, new RegExp(marker), `${marker} survived flattening`)
})

// --- streaming --------------------------------------------------------------

test('streaming is a valid chat.completion.chunk sequence', async () => {
  const stream = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: '@@chunks=4 abcdefgh' }],
    stream: true,
  })
  const chunks = []
  for await (const c of stream) chunks.push(c)

  assert.ok(chunks.length >= 3, 'more than one frame')
  for (const c of chunks) {
    assert.equal(c.object, 'chat.completion.chunk')
    assert.match(c.id, /^chatcmpl-/)
    assert.equal(c.model, MODEL)
  }
  assert.equal(chunks[0].choices[0].delta.role, 'assistant', 'the first frame carries the role, as clients expect')

  const finish = chunks.filter((c) => c.choices[0]?.finish_reason)
  assert.equal(finish.length, 1, 'exactly one frame ends the message')
  assert.equal(finish[0].choices[0].finish_reason, 'stop')

  const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')
  assert.equal(text, 'abcdefgh', 'concatenated deltas equal the full answer')
})

test('every stream id is stable and the SSE framing is correct on the wire', async () => {
  // The SDK hides framing bugs by being tolerant. Read the raw bytes.
  const res = await post('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: '@@chunks=3 xyz' }], stream: true })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const body = await res.text()

  const lines = body.split('\n').filter((l) => l.startsWith('data: '))
  assert.equal(lines.at(-1), 'data: [DONE]', 'the stream terminates with the sentinel every client waits for')
  const frames = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)))
  assert.equal(new Set(frames.map((f) => f.id)).size, 1, 'one id for the whole stream')
  assert.ok(body.includes('\n\n'), 'frames are separated by a blank line')
})

test('a streamed provider failure still ends the stream cleanly', async () => {
  // A client that never sees [DONE] hangs until its own timeout.
  const res = await post('/v1/chat/completions', {
    model: MODEL, stream: true,
    messages: [{ role: 'user', content: '@@throw=ui_contract @@status=502' }],
  })
  const body = await res.text()
  assert.ok(body.includes('data: [DONE]') || /"error"/.test(body), 'the stream is terminated rather than left open')
})

// --- request handling -------------------------------------------------------

test('unknown models are refused, not silently substituted', async () => {
  // Silently answering with a different model is the one failure a research
  // pipeline cannot detect after the fact.
  const res = await post('/v1/chat/completions', { model: 'gpt-4o-does-not-exist', messages: [{ role: 'user', content: 'x' }] })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(typeof body.error.message, 'string')
  assert.match(body.error.message, /model/i)
})

test('malformed requests are rejected with an OpenAI-shaped error', async () => {
  for (const [body, why] of [
    [{ model: MODEL }, 'no messages'],
    [{ model: MODEL, messages: [] }, 'empty messages'],
    [{ model: MODEL, messages: [{ role: 'user', content: '' }] }, 'empty content'],
    [{ messages: [{ role: 'user', content: 'x' }] }, 'no model'],
  ]) {
    const res = await post('/v1/chat/completions', body)
    assert.equal(res.status, 400, why)
    const payload = await res.json()
    assert.ok(payload.error?.message, `${why}: has error.message`)
    assert.ok(payload.error?.type, `${why}: has error.type`)
  }
})

test('invalid JSON is a 400, not a crash', async () => {
  const res = await fetch(`${server.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model": ',
  })
  assert.equal(res.status, 400)
})

test('unknown routes are 404 and unknown methods are refused', async () => {
  assert.equal((await fetch(`${server.base}/v1/nope`)).status, 404)
  assert.equal((await fetch(`${server.base}/v1/chat/completions`)).status, 404, 'GET on a POST-only route')
})

test('response_format json_object returns parseable JSON', async () => {
  const r = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: '@@json hello' }],
    response_format: { type: 'json_object' },
  })
  const parsed = JSON.parse(r.choices[0].message.content)
  assert.equal(parsed.ok, true)
  assert.deepEqual(r._uibridge.json, parsed, '_uibridge.json is the same object, already parsed')
})

test('a json_schema that the answer violates is an error, not a silent pass', async () => {
  const res = await post('/v1/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: '@@json hello' }],
    response_format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { type: 'object', required: ['absent_field'], properties: { absent_field: { type: 'string' } }, additionalProperties: false } } },
  })
  assert.notEqual(res.status, 200, 'schema violations must not be reported as success')
})

test('parameters we cannot honour are ignored rather than fatal', async () => {
  // A caller's existing code sets temperature and max_tokens. A UI has no
  // such knobs; refusing the request would break every real client, and
  // pretending to apply them would be a lie. Accept and say nothing.
  const r = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: 'ok' }],
    temperature: 0.2, top_p: 0.9, max_tokens: 64, presence_penalty: 0.1, n: 1, user: 'someone',
  })
  assert.equal(r.choices[0].message.content, 'ok')
  // Ignored, but never silently: a run that believed it set temperature=0
  // can find out that it did not.
  assert.deepEqual(
    [...r._uibridge.unsupported_parameters].sort(),
    ['max_tokens', 'presence_penalty', 'temperature', 'top_p', 'user'],
    'every unhonoured control is named back to the caller'
  )
})

// --- /v1/models -------------------------------------------------------------

test('/v1/models is a valid list and every id it advertises is callable', async () => {
  const list = await client.models.list()
  assert.ok(list.data.length > 0)
  for (const m of list.data) {
    assert.equal(m.object, 'model')
    assert.equal(typeof m.id, 'string')
    assert.equal(typeof m.owned_by, 'string')
  }
  // The catalogue is a promise. An id listed here that 400s is a broken one.
  const echoIds = list.data.map((m) => m.id).filter((id) => id.startsWith('echo'))
  assert.ok(echoIds.length >= 2)
  for (const id of echoIds) {
    if (id === 'echo-refuses') continue // deliberately unverifiable; covered below
    const r = await client.chat.completions.create({ model: id, messages: [{ role: 'user', content: 'ping' }] })
    assert.equal(r.model, id)
  }
})

// --- provenance and honesty -------------------------------------------------

test('a model the UI refused to apply is an error under strictModel', async () => {
  const res = await post('/v1/chat/completions', { model: 'echo-refuses', messages: [{ role: 'user', content: 'x' }] })
  assert.equal(res.status, 502)
  const body = await res.json()
  assert.equal(body.error.type, 'model_not_applied')
})

test("a provider's own failure message is reported, not returned as an answer", async () => {
  const res = await post('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: '@@error' }] })
  assert.equal(res.status, 502, 'a recognised provider failure is not a 200')
})

test('a suspected failure is flagged but still returned', async () => {
  const r = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: '@@suspect' }] })
  assert.equal(r._uibridge.provider_error, false)
  assert.equal(r._uibridge.provider_error_suspected, true, 'the caller can quarantine it')
})

test('a truncated answer says so', async () => {
  const r = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: '@@truncated partial' }] })
  assert.equal(r._uibridge.truncated, true)
})

test('typed errors carry status, type and retryability', async () => {
  const cases = [
    ['@@throw=thread_unavailable @@status=503 @@retryable=true', 503, 'thread_unavailable', true],
    ['@@throw=ui_contract @@status=502', 502, 'ui_contract', false],
    ['@@throw=rate_limited @@status=429 @@retryable=true', 429, 'rate_limited', true],
  ]
  for (const [content, status, type, retryable] of cases) {
    const res = await post('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content }] })
    assert.equal(res.status, status, content)
    const body = await res.json()
    assert.equal(body.error.type, type)
    assert.equal(body.error.retryable, retryable, `${type} declares whether retrying could help`)
  }
})

// --- threads ----------------------------------------------------------------

test('thread_id round-trips and continues the same conversation', async () => {
  const first = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: 'one' }] })
  const thread = first._uibridge.thread_id
  assert.ok(thread, 'a new conversation reports its native id')

  const second = await post('/v1/chat/completions', { model: MODEL, thread_id: thread, messages: [{ role: 'user', content: 'two' }] })
  const body = await second.json()
  assert.equal(body._uibridge.thread_id, thread, 'the answer came from the thread we asked for')

  const third = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: 'three' }] })
  assert.notEqual(third._uibridge.thread_id, thread, 'omitting thread_id gives a fresh, isolated conversation')
})

test('a thread that will not open is a typed 503, and nothing is sent', async () => {
  const res = await post('/v1/chat/completions', { model: MODEL, thread_id: 'missing', messages: [{ role: 'user', content: 'x' }] })
  assert.equal(res.status, 503)
  assert.equal((await res.json()).error.type, 'thread_unavailable')
})

test('thread export returns the messages with completeness evidence', async () => {
  const r = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: 'exported turn' }] })
  const res = await post('/v1/threads/export', { provider: 'echo', thread_id: r._uibridge.thread_id })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.messages.length, 2)
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(body.complete, true)
  for (const k of ['reached_top', 'reached_bottom', 'message_count', 'ordered_count', 'order_verified']) {
    assert.ok(k in body.evidence, `evidence.${k} is reported`)
  }
})

// --- durability -------------------------------------------------------------

test('the same Idempotency-Key returns the same answer without asking again', async () => {
  const key = `conformance-${Date.now()}`
  const body = { model: MODEL, messages: [{ role: 'user', content: 'durable' }] }
  const a = await (await post('/v1/chat/completions', body, { 'Idempotency-Key': key })).json()
  const b = await (await post('/v1/chat/completions', body, { 'Idempotency-Key': key })).json()
  assert.equal(a.id, b.id, 'the replay is the same completion, not a second turn')
  assert.equal(b._uibridge.thread_id, a._uibridge.thread_id)
})

test('reusing a key for a different request is a conflict, not a wrong answer', async () => {
  const key = `conflict-${Date.now()}`
  await post('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'first' }] }, { 'Idempotency-Key': key })
  const res = await post('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'DIFFERENT' }] }, { 'Idempotency-Key': key })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error.type, 'idempotency_conflict')
})

test('a durable result can be recovered after the fact', async () => {
  const key = `recover-${Date.now()}`
  const sent = await (await post('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'recover me' }] }, { 'Idempotency-Key': key })).json()
  const got = await (await fetch(`${server.base}/v1/requests/result`, { headers: { 'Idempotency-Key': key } })).json()
  assert.equal(got.choices[0].message.content, sent.choices[0].message.content)
  const status = await (await fetch(`${server.base}/v1/requests/status`, { headers: { 'Idempotency-Key': key } })).json()
  assert.ok(status.state, 'status reports a state')
})

// --- service ----------------------------------------------------------------

test('/health identifies the service, its build and its state directory', async () => {
  const h = await (await fetch(`${server.base}/health`)).json()
  assert.equal(h.service, 'uibridge')
  assert.equal(typeof h.protocol, 'number')
  assert.equal(h.status, 'ok')
  assert.match(h.version, /^\d+\.\d+\.\d+$/)
  assert.equal(h.home, server.home, 'a client can tell WHICH uibridge answered')
  assert.ok(Array.isArray(h.providers))
})

test('/v1/capabilities describes what this build can actually do', async () => {
  const c = await (await fetch(`${server.base}/v1/capabilities`)).json()
  assert.ok(c.providers.includes('echo'), 'the providers this build can serve are listed')
  assert.equal(c.api.endpoint, '/v1/chat/completions')
  // These are promises about behaviour, and a caller reads them to decide
  // what it may rely on.
  for (const k of ['roles', 'response_formats', 'token_usage', 'idempotency', 'cancellation', 'sampling_controls']) {
    assert.ok(k in c.api, `api.${k} is declared`)
  }
})

test('a streamed response reports ignored parameters too', async () => {
  // The final frame carries the same _uibridge payload as a non-streamed
  // answer. A caller that only streams must not lose the honesty fields.
  const res = await post('/v1/chat/completions', {
    model: MODEL, stream: true, temperature: 0.7,
    messages: [{ role: 'user', content: 'streamed' }],
  })
  const frames = (await res.text()).split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)))
  const final = frames.find((f) => f._uibridge)
  assert.ok(final, 'the closing frame carries the bridge payload')
  assert.deepEqual(final._uibridge.unsupported_parameters, ['temperature'])
})

// --- retrying is the caller's cost, and ours ---------------------------------

test('a failure the bridge calls final is not retried by the official client', async () => {
  // BOTH OFFICIAL SDKs RETRY EVERY 5xx TWICE BY DEFAULT. Against a hosted API
  // that is free caution. Against this one every retry drives a browser, and
  // if the prompt already reached the site the retry types it into the user's
  // conversation a second and third time. Measured 2026-09-09: one
  // create() call arrived here three times, for an error whose own body
  // said retryable:false. Both SDKs honour `x-should-retry`.
  const retrying = new OpenAI({ apiKey: 'local', baseURL: `${server.base}/v1`, maxRetries: 2, timeout: 30000 })
  server.resetHits()
  await assert.rejects(
    retrying.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: '@@throw=ui_contract @@status=502 x' }] }),
    (e) => e.status === 502
  )
  assert.equal(server.hits(), 1, 'a final failure is delivered once')
})

test('a failure the bridge calls retryable still gets the client its retries', async () => {
  const retrying = new OpenAI({ apiKey: 'local', baseURL: `${server.base}/v1`, maxRetries: 2, timeout: 30000 })
  server.resetHits()
  await assert.rejects(
    retrying.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: '@@throw=ui_busy @@status=503 @@retryable=true x' }] }),
    (e) => e.status === 503
  )
  assert.equal(server.hits(), 3, 'the original plus two retries')
})

test('the retry verdict is on the wire, matching the body', async () => {
  for (const [prompt, expected] of [
    ['@@throw=ui_contract @@status=502 x', 'false'],
    ['@@throw=ui_busy @@status=503 @@retryable=true x', 'true'],
  ]) {
    const res = await post('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: prompt }] })
    assert.equal(res.headers.get('x-should-retry'), expected)
    assert.equal(String((await res.json()).error.retryable), expected, 'header and body agree')
  }
})

// --- one model, addressed singly ---------------------------------------------

test('models.retrieve() answers, because the official client has that call', async () => {
  const m = await client.models.retrieve(MODEL)
  assert.equal(m.id, MODEL)
  assert.equal(m.object, 'model')
  assert.equal(m.owned_by, 'echo')
})

test('models.retrieve() of a model we do not serve is a typed 404', async () => {
  const res = await fetch(`${server.base}/v1/models/not-a-real-model`)
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.error.type, 'model_not_found')
  assert.match(body.error.message, /Known:/, 'it says what it does serve')
})

// --- the daemon has to survive whatever is pointed at it ---------------------

test('a malformed model id is a 404, not a dead daemon', async () => {
  // `decodeURIComponent` throws URIError on a bad escape. That call used to
  // sit in the ROUTER, outside the dispatcher's try, so `GET /v1/models/%zz`
  // answered nothing and killed the process - one malformed URL from any
  // local program and the daemon was gone mid-conversation.
  const res = await fetch(`${server.base}/v1/models/%zz`)
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.error.type, 'model_not_found')

  // Still serving, which is the actual point of this test.
  const after = await fetch(`${server.base}/health`)
  assert.equal(after.status, 200)
})

test('every error response carries retryable and x-should-retry, including the ones nothing routes to', async () => {
  // README promises both on EVERY error. The route-miss 404 and the
  // unclassified 500 were the two that quietly did not, and the 500 is the
  // load-bearing one: without the header both official SDKs retry it twice,
  // and each retry is another real turn typed into the user's own thread.
  const res = await fetch(`${server.base}/v1/nope`)
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('x-should-retry'), 'false')
  const body = await res.json()
  assert.equal(body.error.type, 'not_found')
  assert.equal(body.error.retryable, false)
})

test('a request carrying a foreign Origin is refused before it can spend anything', async () => {
  // Binding to 127.0.0.1 does not keep out the browser the user already has
  // open: POST /v1/chat/completions is a CORS-simple request, so any page
  // could send one with no preflight. Measured before this check existed: a
  // request with `origin: https://evil.example` ran a real turn, and one to
  // /admin/shutdown stopped the daemon. The attacker cannot read the reply -
  // the cost is the side effect.
  const res = await post('/v1/chat/completions',
    { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
    { origin: 'https://evil.example' })
  assert.equal(res.status, 403)
  const body = await res.json()
  assert.equal(body.error.type, 'cross_origin_refused')
  assert.equal(res.headers.get('x-should-retry'), 'false')
})

test('a lookalike loopback origin does not get in', async () => {
  const res = await post('/v1/chat/completions',
    { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
    { origin: 'http://127.0.0.1.evil.example' })
  assert.equal(res.status, 403)
})

test('a genuinely local page is still served, and so is a caller that sends no Origin at all', async () => {
  // curl, the CLI and both official SDKs send no Origin. A local tool served
  // from another loopback port is as local as uibridge itself.
  const local = await post('/v1/chat/completions',
    { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
    { origin: 'http://localhost:3000' })
  assert.equal(local.status, 200)

  const bare = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] })
  assert.equal(bare.object, 'chat.completion')
})

// --- a stream that fails after it has already said something -----------------

test('a mid-stream failure is reported in the stream, not papered over', async () => {
  // Once the first byte is out the status line is already 200, so the only
  // honest way left to report a failure is an error frame. The alternative -
  // ending the stream cleanly - hands the caller a truncated answer that
  // looks complete.
  const res = await post('/v1/chat/completions', {
    model: MODEL, stream: true,
    messages: [{ role: 'user', content: '@@chunks=8 @@throw_at=3 an answer cut off partway' }],
  })
  assert.equal(res.status, 200, 'headers went out before the failure')
  const frames = (await res.text()).split('\n\n').filter(Boolean)
    .map((f) => f.replace(/^data: /, '')).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d))

  assert.ok(frames.some((f) => f.error), 'the failure is in the stream')
  assert.equal(frames.find((f) => f.error).error.type, 'ui_contract')
  assert.ok(!frames.some((f) => f.choices?.[0]?.finish_reason === 'stop'), 'nothing claims a clean finish')
})

test('the official client raises on a mid-stream failure', async () => {
  await assert.rejects(async () => {
    const stream = await client.chat.completions.create({
      model: MODEL, stream: true,
      messages: [{ role: 'user', content: '@@chunks=8 @@throw_at=3 an answer cut off partway' }],
    })
    for await (const _ of stream) { /* drain */ }
  }, (e) => /simulated/.test(e.message))
})

// --- a conversation that does not exist --------------------------------------

test('a thread the site never issued is refused, not silently replaced', async () => {
  // Answering 200 on a brand-new thread would tell the caller it had continued
  // a conversation that does not exist.
  const res = await post('/v1/chat/completions', {
    model: MODEL, thread_id: 'echo-never-issued-this', messages: [{ role: 'user', content: 'x' }],
  })
  assert.equal(res.status, 503)
  assert.equal((await res.json()).error.type, 'thread_unavailable')
})

// --- a thread that is not there --------------------------------------------

test('a thread with no history at all is refused BEFORE anything is sent', async () => {
  // Measured 2026-09-09 on the live site: navigating to a Gemini thread id
  // that was never issued does not fail and does not redirect. The URL keeps
  // the made-up id and the conversation is simply empty, so the prompt was
  // typed into a BRAND NEW conversation in the user's account, answered
  // there, and the answer then discarded downstream as thread_mismatch - a
  // spent turn, an orphan chat, and an error. A `ghost-` id reproduces
  // exactly that shape: the provider accepts it, and nothing is behind it.
  const before = server.hits()
  const res = await post('/v1/chat/completions', {
    model: MODEL, thread_id: 'ghost-never-issued',
    messages: [{ role: 'user', content: 'this must never reach a site' }],
  })
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.error.type, 'thread_unavailable')
  assert.match(body.error.message, /[Nn]othing was sent/)
  assert.equal(res.headers.get('x-should-retry'), 'true', 'a retry is free - nothing went out')
  assert.equal(server.hits(), before + 1, 'and it was one request, not a retry storm')
})

test('a thread that does have history still sends normally', async () => {
  // The guard above must not refuse real conversations.
  const first = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: 'open a thread' }] })
  const again = await client.chat.completions.create({
    model: MODEL, thread_id: first._uibridge.thread_id,
    messages: [{ role: 'user', content: 'continue it' }],
  })
  assert.equal(again._uibridge.thread_id, first._uibridge.thread_id)
  assert.equal(again.choices[0].message.content, 'continue it')
  assert.equal(again._uibridge.provenance.history, 'loaded')
})
