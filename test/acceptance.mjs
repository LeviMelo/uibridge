// Live, ground-truth acceptance through the official OpenAI SDK. Synthetic
// evidence only; no real patient data or unverifiable literature assertions.
// node test/acceptance.mjs gemini-pro [classification|long|stream|attachment|continuation|export|isolation|formatting|artifact|long_classification]
import OpenAI from 'openai'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const model = process.argv[2] ?? 'gemini-pro'
const only = process.argv.slice(3)
const baseURL = process.env.UIBRIDGE_BASE_URL ?? 'http://127.0.0.1:8477/v1'
const client = new OpenAI({ apiKey: 'local', baseURL, maxRetries: 0, timeout: 240000 })
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const dir = resolve('.uibridge', 'acceptance', `${runId}-${model}`)
mkdirSync(dir, { recursive: true })
const results = []
let lastThread = null
const secret = randomUUID()
const input = [
  'S1: Randomized trial. Humans age 4-9. Drug A versus placebo. Delirium measured.',
  'S2: Retrospective cohort. Humans age 4-9. Drug A versus placebo. Delirium measured.',
  'S3: Randomized trial. Humans age 40-69. Drug A versus placebo. Delirium measured.',
  'S4: Randomized trial. Humans age 4-9. Drug A versus placebo. Delirium was NOT measured.',
  'S5: Randomized trial. Rats. Drug A versus placebo. Delirium measured.',
  'S6: Randomized trial. Humans age 4-9. Drug A versus placebo. Outcomes not reported.',
].join('\n')
const labels = { S1: 'include', S2: 'exclude', S3: 'exclude', S4: 'exclude', S5: 'exclude', S6: 'unclear' }
const schema = { type: 'object', properties: Object.fromEntries(Object.keys(labels).map((k) => [k, { enum: ['include', 'exclude', 'unclear'] }])), required: Object.keys(labels), additionalProperties: false }
const format = (schema, name = 'classification') => ({ type: 'json_schema', json_schema: { name, strict: true, schema } })
const rules = 'Classify these fictional records. Include only randomized human pediatric trials (age under 18) that measured delirium. Exclude any explicit failure of a criterion. Use unclear when missing information prevents deciding. Use only the supplied evidence. Return the requested JSON.'

async function call(messages, extra = {}) {
  const response = await client.chat.completions.create({ model, messages, ...extra })
  assert.equal(response.choices[0].finish_reason, 'stop')
  assert.equal(response._uibridge.provider_error, false)
  assert.equal(response._uibridge.truncated, false)
  assert.ok(response._uibridge.thread_id)
  lastThread = response._uibridge.thread_id
  return response
}
function evidence(response) {
  return { thread_id: response._uibridge?.thread_id, provenance: response._uibridge?.provenance,
    extraction: response._uibridge?.extraction, elapsed_ms: response._uibridge?.elapsed_ms,
    content: response.choices?.[0]?.message?.content }
}
const tests = {
  async durable_attachment() {
    const original = `ACCESSION=${secret}\nN_RANDOMIZED=137\n`
    const path = resolve(dir, 'durable-evidence.txt')
    writeFileSync(path, original)
    const key = `attachment-${randomUUID()}`
    const body = { model, messages: [{ role: 'user', content: 'Read the attachment. Return a JSON object with accession containing only the exact ACCESSION identifier.' }], attachments: [path],
      response_format: format({ type: 'object', properties: { accession: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }, required: ['accession'], additionalProperties: false }, 'accession') }
    // Observe rejection immediately while waiting for a browser to become active.
    const pending = client.chat.completions.create(body, { headers: { 'Idempotency-Key': key } }).then((r) => ({ r }), (err) => ({ err }))
    try {
      const deadline = Date.now() + 90000
      let active = false
      while (Date.now() < deadline) {
        const health = await (await fetch(`${baseURL.replace(/\/v1$/, '')}/health`)).json()
        if (health.sessions?.[model.split('-')[0]]?.busy) { active = true; break }
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.equal(active, true)
      writeFileSync(path, 'ACCESSION=MODIFIED_AFTER_QUEUEING\n')
      const { r, err } = await pending
      if (err) throw err
      writeFileSync(resolve(dir, 'durable-attachment.json'), JSON.stringify({ key, body, response: r }, null, 2))
      assert.deepEqual(JSON.parse(r.choices[0].message.content), { accession: secret })
      assert.equal(r._uibridge.provenance.model.verified, true)
      await assert.rejects(client.chat.completions.create(body, { headers: { 'Idempotency-Key': key } }), { status: 409 })
      writeFileSync(path, original)
      const replay = await client.chat.completions.create(body, { headers: { 'Idempotency-Key': key } })
      assert.deepEqual(replay, r)
      return { ...evidence(r), key, source_mutation_isolated: true }
    } finally { writeFileSync(path, original) }
  },
  async classification() {
    const r = await call([{ role: 'system', content: rules }, { role: 'user', content: input }], { response_format: format(schema) })
    writeFileSync(resolve(dir, 'classification.json'), JSON.stringify(r, null, 2))
    assert.deepEqual(JSON.parse(r.choices[0].message.content), labels)
    assert.equal(r._uibridge.provenance.model?.verified, true, 'requested model must be verified')
    return evidence(r)
  },
  async long() {
    const tokens = [randomUUID(), randomUUID(), randomUUID()]
    const filler = Array.from({ length: 700 }, (_, i) => `Background record ${i}: observational description only; no target code here. Evidence is insufficient to infer a randomized pediatric trial.\n`).join('')
    const text = `BEGIN_CODE=${tokens[0]}\n${filler}\nMIDDLE_CODE=${tokens[1]}\n${filler}\nEND_CODE=${tokens[2]}`
    const r = await call([{ role: 'system', content: 'Extract the exact BEGIN_CODE, MIDDLE_CODE and END_CODE strings from the evidence. JSON object with keys begin, middle, end. Do not infer or shorten.' },
      { role: 'user', content: text }], { response_format: { type: 'json_object' } })
    writeFileSync(resolve(dir, 'long.json'), JSON.stringify(r, null, 2))
    assert.deepEqual(JSON.parse(r.choices[0].message.content), { begin: tokens[0], middle: tokens[1], end: tokens[2] })
    return { ...evidence(r), input_characters: text.length, input_bytes: Buffer.byteLength(text) }
  },
  async stream() {
    const stream = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Return only this exact text: ciência αβ 42' }],
      stream: true, stream_options: { include_usage: true } })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    writeFileSync(resolve(dir, 'stream.json'), JSON.stringify(chunks, null, 2))
    assert.ok(chunks.length >= 3)
    assert.equal(new Set(chunks.map((c) => c.id)).size, 1)
    assert.equal(new Set(chunks.map((c) => c.created)).size, 1)
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')
    assert.equal(text.trim(), 'ciência αβ 42')
    assert.ok(chunks.some((c) => c.choices[0]?.finish_reason === 'stop'))
    assert.deepEqual(chunks.at(-1).choices, [])
    return { chunks: chunks.length, text }
  },
  async attachment() {
    const path = resolve(dir, 'evidence.txt')
    writeFileSync(path, `Synthetic evidence for transport verification.\nACCESSION=${secret}\nN_RANDOMIZED=137\nN_ANALYZED=129\n`)
    const r = await call([{ role: 'user', content: 'Read the attached evidence. Return JSON with accession (exact string), randomized (integer), analyzed (integer). Only use the file.' }],
      { attachments: [path], response_format: { type: 'json_object' } })
    writeFileSync(resolve(dir, 'attachment.json'), JSON.stringify(r, null, 2))
    assert.deepEqual(JSON.parse(r.choices[0].message.content), { accession: secret, randomized: 137, analyzed: 129 })
    return evidence(r)
  },
  async continuation() {
    if (!lastThread) throw new Error('Run attachment before continuation')
    const thread = lastThread
    const r = await call([{ role: 'user', content: 'Using the attached evidence from the preceding turn, what was ACCESSION? Return only the exact accession string.' }], { thread_id: thread })
    writeFileSync(resolve(dir, 'continuation.json'), JSON.stringify(r, null, 2))
    assert.equal(r._uibridge.thread_id, thread)
    assert.equal(r.choices[0].message.content.trim(), secret)
    return evidence(r)
  },
  async export() {
    if (!lastThread) throw new Error('Run a preceding case to create a thread')
    const response = await fetch(`${baseURL}/threads/export`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: model.split('-')[0], thread_id: lastThread }), signal: AbortSignal.timeout(180000) })
    const body = await response.json()
    writeFileSync(resolve(dir, 'export.json'), JSON.stringify(body, null, 2))
    assert.equal(response.status, 200, JSON.stringify(body.error))
    assert.ok(JSON.stringify(body).includes(secret), 'export must contain the known evidence accession')
    return { status: response.status, completeness: body.completeness ?? null }
  },
  async isolation() {
    const secrets = [randomUUID(), randomUUID()]
    const replies = await Promise.all(secrets.map((s) => call([{ role: 'user', content: `Return only this exact identifier: ${s}` }])))
    writeFileSync(resolve(dir, 'isolation.json'), JSON.stringify(replies, null, 2))
    assert.notEqual(replies[0]._uibridge.thread_id, replies[1]._uibridge.thread_id)
    replies.forEach((r, i) => assert.equal(r.choices[0].message.content.trim(), secrets[i]))
    return replies.map(evidence)
  },
  async formatting() {
    const r = await call([{ role: 'user', content: 'Use these fictional records: trial A has 3 events among 20 participants; B has 5 among 30; C has 7 among 40. Return a markdown table with columns trial, events, n and exactly those three rows. Then a fenced python code block defining a function total_events() that returns their total. End with the exact line END_FORMAT_CHECK.' }])
    writeFileSync(resolve(dir, 'formatting.json'), JSON.stringify(r, null, 2))
    assert.equal(r._uibridge.tables[0]?.rows.length, 3)
    assert.ok(r._uibridge.code_blocks.some((b) => b.lang === 'python' && b.code.includes('def total_events')))
    assert.ok(r.choices[0].message.content.trim().endsWith('END_FORMAT_CHECK'))
    return evidence(r)
  },
  async artifact() {
    const marker = randomUUID()
    const r = await call([{ role: 'user', content: `Create an actual downloadable text file named uibridge_artifact.txt containing exactly the following identifier and nothing else: ${marker}. Use your file-generation tool, and provide the download link. Do not just display the file contents in a code block.` }])
    writeFileSync(resolve(dir, 'artifact.json'), JSON.stringify(r, null, 2))
    const file = r._uibridge.files.find((f) => f.path && !f.error)
    assert.ok(file, 'a generated file must reach disk')
    assert.equal(readFileSync(file.path, 'utf8').trim(), marker)
    return { ...evidence(r), file: { path: file.path, bytes: file.bytes } }
  },
  async long_classification() {
    const expected = {}
    const filler = 'Background methods appendix: this paragraph gives no additional eligibility evidence for any of the numbered records. '.repeat(15)
    const records = Array.from({ length: 60 }, (_, i) => {
      const id = `R${i + 1}`
      expected[id] = Object.values(labels)[i % 6]
      return input.split('\n')[i % 6].replace(/^S\d+:/, `${id}:`) + '\n' + filler
    }).join('\n\n')
    const longSchema = { type: 'object', properties: Object.fromEntries(Object.keys(expected).map((k) => [k, { enum: ['include', 'exclude', 'unclear'] }])), required: Object.keys(expected), additionalProperties: false }
    const r = await call([{ role: 'system', content: rules }, { role: 'user', content: records }], { response_format: format(longSchema) })
    writeFileSync(resolve(dir, 'long-classification.json'), JSON.stringify(r, null, 2))
    const actual = JSON.parse(r.choices[0].message.content)
    const correct = Object.keys(expected).filter((key) => actual[key] === expected[key]).length
    assert.equal(correct, 60, `${correct}/60 classification labels correct`)
    assert.equal(r._uibridge.provenance.model?.verified, true)
    return { ...evidence(r), records: 60, correct, input_characters: records.length }
  },
}

console.log(`Live acceptance: ${model}; artifacts: ${dir}`)
for (const [name, run] of Object.entries(tests)) {
  if (only.length && !only.includes(name)) continue
  const started = Date.now()
  try {
    const detail = await run()
    results.push({ name, pass: true, elapsed_ms: Date.now() - started, detail })
    console.log(`PASS ${name} (${Date.now() - started}ms)`)
  } catch (err) {
    results.push({ name, pass: false, elapsed_ms: Date.now() - started, error: err.message.slice(0, 2000), status: err.status ?? null })
    console.log(`FAIL ${name}: ${err.message.split('\n')[0]}`)
    if ([401, 429, 503].includes(err.status)) break
  }
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ model, runId, results }, null, 2))
}
writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ model, runId, results }, null, 2))
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`)
process.exitCode = results.some((r) => !r.pass) ? 1 : 0
