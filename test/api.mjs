import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/api/server.mjs'
import { BridgeError } from '../src/core/errors.mjs'
import { flattenMessages } from '../src/api/openai.mjs'
import { fillComposer } from '../src/core/composer.mjs'

const request = { model: 'gemini', messages: [{ role: 'user', content: 'Classify the record.' }] }
const result = (text = 'answer') => ({ text, request_id: 'test', thread_id: 'thread1', files: [], sources: [], provenance: {} })
async function appFor(t, ask, open) {
  const app = createApp({ defaultProvider: 'gemini' }, { openSession: open ?? (async () => ({ ask, close: async () => {} })) })
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r))
  t.after(() => app.close())
  return (body = request) => fetch(`http://127.0.0.1:${app.server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

test('API rejects unsupported controls and lost input before session creation', async (t) => {
  let opened = 0
  const post = await appFor(t, null, async () => { opened++; throw new Error('must not open') })
  for (const extra of [{ temperature: 0 }, { tools: [] }, { n: 2 }, { stream: 'false' },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] },
    { attachments: ['C:/does-not-exist-uibridge.pdf'] }, { modes: { thinking: 'false' } },
    { modes: { imaginary: true } }, { thread_id: '../foreign' },
    { response_format: { type: 'json_schema', json_schema: { name: 'broken', schema: { type: 'bogus' } } } }]) {
    const res = await post({ ...request, ...extra })
    assert.equal(res.status, 400, JSON.stringify(extra))
  }
  assert.equal(opened, 0)
})

test('message labels and complete long Unicode inputs survive flattening', () => {
  const long = 'αβ ciência\n'.repeat(20000) + 'TAIL_9e730'
  assert.equal(flattenMessages([{ role: 'user', content: long }]), long)
  assert.equal(flattenMessages([{ role: 'system', content: 'Policy' }]), '[system]\nPolicy')
  assert.match(flattenMessages([{ role: 'developer', content: 'Policy' }, { role: 'user', content: long }]), /\[user\]\nαβ/)
})

test('composer replaces stale input and refuses partial long prompts', async () => {
  let value = 'old draft'
  const composer = { fill: async (text) => { value = text }, evaluate: async () => value }
  const long = 'Evidence α\n'.repeat(20000) + 'TAIL'
  await fillComposer(composer, long)
  assert.equal(value, long)
  composer.fill = async (text) => { value = text.slice(0, -4) }
  await assert.rejects(fillComposer(composer, long), { code: 'compose_failed' })
})

test('provider failures and empty answers cannot masquerade as successful inference', async (t) => {
  for (const value of [result(''), { ...result('Sorry'), provider_error: true }]) {
    const post = await appFor(t, async () => value)
    assert.equal((await post()).status, 502)
  }
})

test('structured outputs validate actual content without coercion or repairs', async (t) => {
  let text = '{"label":"include","n":42}'
  const post = await appFor(t, async ({ prompt }) => {
    assert.match(prompt, /JSON schema/)
    return result(text)
  })
  const body = { ...request, response_format: { type: 'json_schema', json_schema: {
    name: 'classification', strict: true, schema: { type: 'object', properties: {
      label: { enum: ['include', 'exclude'] }, n: { type: 'integer' },
    }, required: ['label', 'n'], additionalProperties: false },
  } } }
  assert.equal((await post(body)).status, 200)
  for (const bad of ['{"label":"invented","n":42}', '{"label":"include","n":"42"}', '```json\n{}\n```', '{}']) {
    text = bad
    const res = await post(body)
    assert.equal(res.status, 502)
    assert.equal((await res.json()).error.type, 'invalid_response_format')
  }
})

test('invalid structured streaming responses fail before SSE headers or content', async (t) => {
  const post = await appFor(t, async ({ onProgress }) => {
    assert.equal(onProgress, null)
    return result('not JSON')
  })
  const res = await post({ ...request, stream: true, response_format: { type: 'json_object' } })
  assert.equal(res.status, 502)
  assert.match(res.headers.get('content-type'), /application\/json/)
})

test('SSE preserves Unicode, stable identity, finish reason and requested usage chunk', async (t) => {
  const post = await appFor(t, async ({ onProgress }) => {
    onProgress('ciência ')
    onProgress('ciência αβ')
    return result('ciência αβ')
  })
  const res = await post({ ...request, stream: true, stream_options: { include_usage: true } })
  assert.equal(res.status, 200)
  const events = (await res.text()).split('\n\n').filter(Boolean).map((s) => s.slice(6))
  assert.equal(events.pop(), '[DONE]')
  const chunks = events.map(JSON.parse)
  assert.equal(new Set(chunks.map((x) => x.id)).size, 1)
  assert.equal(new Set(chunks.map((x) => x.created)).size, 1)
  assert.equal(chunks.map((x) => x.choices[0]?.delta?.content ?? '').join(''), 'ciência αβ')
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop')
  assert.deepEqual(chunks.at(-1).choices, [])
  assert.equal(chunks.at(-1).usage.total_tokens, 0)
})

test('upstream failure after partial SSE ends with an error, not a successful finish', async (t) => {
  const post = await appFor(t, async ({ onProgress }) => {
    onProgress('partial')
    throw new BridgeError('upstream failed', { code: 'upstream_refused', status: 502 })
  })
  const text = await (await post({ ...request, stream: true })).text()
  assert.match(text, /upstream_refused/)
  assert.doesNotMatch(text, /"finish_reason":"stop"/)
  assert.ok(text.endsWith('data: [DONE]\n\n'))
})

test('concurrent first requests share one session and a failed open can recover', async (t) => {
  let openings = 0
  const post = await appFor(t, null, async () => {
    openings++
    await new Promise((r) => setTimeout(r, 10))
    if (openings === 1) throw new BridgeError('temporarily unavailable', { status: 503 })
    return { ask: async () => result(), close: async () => {} }
  })
  assert.equal((await post()).status, 503)
  const responses = await Promise.all(Array.from({ length: 5 }, () => post()))
  assert.ok(responses.every((r) => r.status === 200))
  assert.equal(openings, 2)
})

test('a browser closed while idle is replaced before the next inference', async (t) => {
  let opened = 0
  let current
  const post = await appFor(t, null, async () => {
    opened++
    current = { available: true, ask: async () => result(), close: async () => {} }
    return current
  })
  assert.equal((await post()).status, 200)
  current.available = false
  assert.equal((await post()).status, 200)
  assert.equal(opened, 2)
})

test('close waits for a pending session and closes it without dispatching inference', async () => {
  let release
  let closed = 0
  let asked = 0
  let started
  const opening = new Promise((r) => { started = r })
  const app = createApp({ defaultProvider: 'gemini' }, { openSession: () => {
    started()
    return new Promise((r) => { release = () => r({ ask: async () => { asked++; return result() }, close: async () => { closed++ } }) })
  } })
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r))
  const response = fetch(`http://127.0.0.1:${app.server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  })
  await opening
  const closing = app.close()
  release()
  assert.equal((await response).status, 503)
  await closing
  assert.equal(closed, 1)
  assert.equal(asked, 0)
})
