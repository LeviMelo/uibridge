// A paced live soak with duplicate protection and explicit active cancellation.
import OpenAI from 'openai'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const model = process.argv[2] ?? 'gemini-pro'
const baseURL = process.env.UIBRIDGE_BASE_URL ?? 'http://127.0.0.1:8477/v1'
const client = new OpenAI({ apiKey: 'local', baseURL, maxRetries: 0, timeout: 240000 })
const dir = resolve('.uibridge/reliability', `${new Date().toISOString().replace(/[:.]/g, '-')}-${model}`)
await mkdir(dir, { recursive: true })
const results = []
async function record(name, fn) {
  const started = Date.now()
  try { const detail = await fn(); results.push({ name, pass: true, ms: Date.now() - started, detail }); console.log(`PASS ${name}`) }
  catch (err) { results.push({ name, pass: false, ms: Date.now() - started, error: err.message.slice(0, 1000) }); throw err }
  finally { await writeFile(resolve(dir, 'results.json'), JSON.stringify({ model, results }, null, 2)) }
}
console.log(dir)
await record('active cancellation', async () => {
  const key = `cancel-${randomUUID()}`
  const pending = client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Return the exact string CANCEL_PROBE.' }] }, { headers: { 'Idempotency-Key': key } }).then((r) => ({ result: r }), (e) => ({ error: e }))
  const deadline = Date.now() + 90000
  let busy = false
  while (Date.now() < deadline) {
    const health = await (await fetch(`${baseURL.replace(/\/v1$/, '')}/health`)).json()
    if (health.sessions?.[model.split('-')[0]]?.busy) { busy = true; break }
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.equal(busy, true, 'dedicated tab should become active')
  const cancelled = await fetch(`${baseURL}/requests/cancel`, { method: 'POST', headers: { 'Idempotency-Key': key } })
  assert.equal(cancelled.status, 200)
  const response = await pending
  assert.equal(response.error?.status, 499, 'active request should cancel')
  return { key, status: response.error.status }
})
const threads = new Set()
for (let i = 0; i < 4; i++) await record(`paced inference ${i + 1} and duplicate replay`, async () => {
  const marker = randomUUID(), key = `soak-${randomUUID()}`
  const body = { model, messages: [{ role: 'user', content: `Return only this exact identifier: ${marker}` }] }
  const options = { headers: { 'Idempotency-Key': key } }
  const [first, duplicate] = await Promise.all([client.chat.completions.create(body, options), client.chat.completions.create(body, options)])
  assert.deepEqual(first, duplicate)
  assert.equal(first.choices[0].message.content.trim(), marker)
  assert.equal(first._uibridge.provenance.model.verified, true)
  assert.equal(threads.has(first._uibridge.thread_id), false)
  threads.add(first._uibridge.thread_id)
  const replay = await client.chat.completions.create(body, options)
  assert.deepEqual(first, replay)
  await writeFile(resolve(dir, `request-${i}.json`), JSON.stringify({ body, key, response: first }, null, 2))
  return { key, id: first.id, thread_id: first._uibridge.thread_id }
})
