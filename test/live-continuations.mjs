// Reproduce the user's file/clipboard workload, without judging model knowledge.
import OpenAI from 'openai'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { chromium } from 'playwright'
const model = process.argv[2] ?? 'gemini-pro'
const dir = resolve('.uibridge/continuations', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(dir, { recursive: true })
const client = new OpenAI({ apiKey: 'local', baseURL: 'http://127.0.0.1:8477/v1', maxRetries: 0, timeout: 300000 })
const results = []
async function ask(prompt, thread, thinking = false) {
  const key = `continuations-${randomUUID()}`
  const r = await client.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], modes: { thinking }, ...(thread ? { thread_id: thread } : {}) }, { headers: { 'Idempotency-Key': key } })
  results.push({ key, response: r })
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify(results, null, 2))
  assert.equal(r._uibridge.provenance.model.verified, true)
  assert.equal(r._uibridge.extraction, 'copy', JSON.stringify(r._uibridge.extraction_warning))
  assert.equal(r._uibridge.files.filter((f) => f.error).length, 0)
  const ledger = readFileSync(r._uibridge.ledger.path, 'utf8').trim().split(/\r?\n/).map(JSON.parse).at(-1)
  assert.equal(ledger.provenance.model.verified, true)
  assert.equal(ledger.provenance.modes.thinking.verified, true)
  assert.equal(ledger.modes.thinking, thinking)
  console.log(`PASS turn ${results.length}: ${r._uibridge.extraction}; ${r._uibridge.files.length} files; thinking=${thinking}`)
  return r
}
console.log(dir)
const first = await ask('Create an actual downloadable CSV named continuation_trial.csv with exactly these contents: id,n\nA,42\nB,17\n. Use your file generation tool and provide the download link.')
const original = first._uibridge.files.find((f) => f.path)
assert.ok(original, 'initial generated CSV must reach disk')
const hash = () => createHash('sha256').update(readFileSync(original.path)).digest('hex')
const before = hash()
const thread = first._uibridge.thread_id
// A second CDP client recreates the temporary-artifact lifetime risk, and a
// read-only native view exercises focus contention without modifying history.
const auxiliary = await chromium.connectOverCDP('http://127.0.0.1:9333')
const context = auxiliary.contexts()[0]
const nativeUrl = context.pages().find((p) => p.url().includes(thread))?.url()
assert.ok(nativeUrl)
const observer = await context.newPage()
await observer.goto(nativeUrl, { waitUntil: 'domcontentloaded' })
try {
for (const thinking of [false, true, false]) {
  const next = await ask('Using the CSV from our first turn, tell me the value of n for row A in one short sentence. Do not create or attach another file.', thread, thinking)
  assert.equal(next._uibridge.thread_id, thread)
  assert.equal(next._uibridge.files.length, 0, 'no historical download on a prose continuation')
  assert.equal(hash(), before)
}
} finally { await observer.close(); await auxiliary.close() }
const [continued, fresh] = await Promise.all([
  ask('Reply with a short acknowledgement only; do not create a file.', thread),
  ask('Create an actual downloadable CSV named overlapping_trial.csv containing id,n\nC,23\n. Use your file generation tool.'),
])
assert.equal(continued._uibridge.files.length, 0)
assert.ok(fresh._uibridge.files.some((f) => f.path))
assert.equal(hash(), before)
console.log('PASS continuation/file concurrency regression')
