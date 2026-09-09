// Public biomedical benchmark, not a clinical validation or private held-out set.
// node test/scientific.mjs MODEL [custom-corpus.jsonl]
// Custom rows: {id, question, contexts: [string], label: 'yes'|'no'|'maybe'}.
import OpenAI from 'openai'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { scoreBiomedical } from './support/biomedical.mjs'

const model = process.argv[2] ?? 'gemini-pro'
const revision = '1cbae8e92f72f20c8d3747cbb3bf5bc53554d997'
const source = `https://raw.githubusercontent.com/pubmedqa/pubmedqa/${revision}`
const sha256 = (v) => createHash('sha256').update(v).digest('hex')
const client = new OpenAI({ apiKey: 'local', baseURL: process.env.UIBRIDGE_BASE_URL ?? 'http://127.0.0.1:8477/v1', maxRetries: 0, timeout: 600000 })
const run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${model}`
const dir = resolve('.uibridge/scientific', run)
await mkdir(dir, { recursive: true })
let rows, datasetHash
if (process.argv[3]) {
  const text = await readFile(process.argv[3], 'utf8')
  datasetHash = sha256(text)
  rows = text.trim().split(/\r?\n/).map(JSON.parse)
} else {
  const cache = resolve('.uibridge/datasets/pubmedqa', revision)
  await mkdir(cache, { recursive: true })
  const path = resolve(cache, 'ori_pqal.json')
  let text
  try { text = await readFile(path, 'utf8') } catch (err) {
    if (err.code !== 'ENOENT') throw err
    const data = await fetch(`${source}/data/ori_pqal.json`)
    if (!data.ok) throw new Error(`Dataset download: ${data.status}`)
    text = await data.text(); await writeFile(path, text)
    const license = await fetch(`${source}/LICENSE`)
    if (!license.ok) throw new Error(`License download: ${license.status}`)
    await writeFile(resolve(cache, 'LICENSE'), await license.text())
  }
  datasetHash = sha256(text)
  rows = Object.entries(JSON.parse(text)).map(([id, value]) => ({ id, question: value.QUESTION, contexts: value.CONTEXTS, label: value.final_decision }))
}
for (const row of rows) {
  if (typeof row.id !== 'string' || typeof row.question !== 'string' || !Array.isArray(row.contexts) || !row.contexts.length || !row.contexts.every((s) => typeof s === 'string') || !['yes', 'no', 'maybe'].includes(row.label)) throw new Error('Invalid benchmark row')
}
if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('Duplicate corpus IDs')
const ordered = [...rows].sort((a, b) => sha256(`uibridge-biomedical-v1:${a.id}`).localeCompare(sha256(`uibridge-biomedical-v1:${b.id}`)))
const selected = process.argv[3] ? ordered : ['yes', 'no', 'maybe'].flatMap((label) => ordered.filter((r) => r.label === label).slice(0, 4))
const targets = selected.map((row, i) => ({ ...row, key: `C${String(i + 1).padStart(2, '0')}` }))
const selectedIds = new Set(targets.map((r) => r.id))
const distractors = ordered.filter((r) => !selectedIds.has(r.id))
const manifest = { model, run, dataset: process.argv[3] ?? 'PubMedQA PQA-L', revision: process.argv[3] ? null : revision,
  dataset_sha256: datasetHash, sampling: 'SHA256(uibridge-biomedical-v1:ID), 4 per class for default dataset; not official test split',
  reference: targets.map(({ id, key, label }) => ({ id, key, label })), results: [] }
await writeFile(resolve(dir, 'results.json'), JSON.stringify(manifest, null, 2))
const schema = { type: 'object', properties: Object.fromEntries(targets.map((r) => [r.key, {
  type: 'object', properties: { label: { enum: ['yes', 'no', 'maybe'] }, quote: { type: 'string', minLength: 12, maxLength: 240 } },
  required: ['label', 'quote'], additionalProperties: false,
}])), required: targets.map((r) => r.key), additionalProperties: false }
const serialize = (r, id) => `RECORD ${id}\nQUESTION: ${r.question}\nEVIDENCE:\n${r.contexts.join('\n')}\nEND RECORD ${id}`
const instructions = `Answer each target biomedical research question using only that record's evidence. yes = the evidence supports an affirmative answer; no = it supports a negative answer; maybe = inconclusive, mixed or insufficient evidence. Interpret the actual question direction carefully. Do not use outside knowledge or look up the paper. For every target return a label and one exact contiguous quote (12–240 characters) from its evidence that supports your decision or shows the uncertainty. Never borrow evidence from another record. Distractor records are unrelated and require no answer. Target IDs: ${targets.map((r) => r.key).join(', ')}. Return only the requested JSON.`

console.log(`Scientific benchmark ${model}; ${targets.length} records; ${dir}`)
for (const variant of ['short', 'long']) {
  let blocks = targets.map((r) => serialize(r, r.key))
  if (variant === 'long') {
    const noise = []
    let characters = 0
    for (const r of distractors) {
      const text = serialize(r, `DISTRACTOR_${noise.length + 1}`)
      noise.push(text); characters += text.length
      if (characters >= 120000) break
    }
    // Distribute target evidence through the file; reverse its order to expose
    // position sensitivity. The answer key is never included in either prompt.
    const reversed = [...blocks].reverse()
    blocks = []
    for (let i = 0; i < reversed.length; i++) {
      blocks.push(reversed[i], ...noise.slice(Math.floor(i * noise.length / reversed.length), Math.floor((i + 1) * noise.length / reversed.length)))
    }
  }
  const input = `${instructions}\n\n${blocks.join('\n\n')}`
  const key = `scientific-${run}-${variant}-${randomUUID()}`
  await writeFile(resolve(dir, `${variant}-input.txt`), input)
  const started = Date.now()
  try {
    const response = await client.chat.completions.create({ model, messages: [{ role: 'user', content: input }],
      response_format: { type: 'json_schema', json_schema: { name: 'biomedical', strict: true, schema } } }, { headers: { 'Idempotency-Key': key } })
    await writeFile(resolve(dir, `${variant}-response.json`), JSON.stringify(response, null, 2))
    if (!response._uibridge?.provenance?.model?.verified || response.choices[0].finish_reason !== 'stop') throw new Error('Unverified model or incomplete result')
    const scored = scoreBiomedical(targets, JSON.parse(response.choices[0].message.content))
    manifest.results.push({ variant, key, ms: Date.now() - started, input_characters: input.length, input_sha256: sha256(input),
      transport: response._uibridge.input, thread_id: response._uibridge.thread_id, ...scored })
    console.log(`${variant}: ${scored.correct}/${scored.total} labels; ${scored.grounded}/${scored.total} exact evidence quotes; ${Date.now() - started}ms`)
  } catch (err) {
    manifest.results.push({ variant, key, ms: Date.now() - started, error: String(err.message).slice(0, 1000), status: err.status })
    process.exitCode = 1
    console.log(`${variant}: ERROR ${err.status ?? ''} ${String(err.message).slice(0, 200)}`)
    if ([401, 429, 503].includes(err.status)) break
  } finally { await writeFile(resolve(dir, 'results.json'), JSON.stringify(manifest, null, 2)) }
}
if (manifest.results.length === 2 && manifest.results.every((r) => r.predictions)) {
  manifest.consistency = { total: targets.length, same_labels: targets.filter((r) => manifest.results[0].predictions[r.key]?.label === manifest.results[1].predictions[r.key]?.label).length }
  await writeFile(resolve(dir, 'results.json'), JSON.stringify(manifest, null, 2))
}
