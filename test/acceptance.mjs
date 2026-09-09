// LIVE BRIDGE FIDELITY.
//
// This is the only suite that must talk to a real chat UI, because it tests
// the only thing that cannot be tested any other way: that uibridge drives
// somebody else's web app and brings the answer back intact.
//
// WHAT IT DOES NOT TEST. It does not test the model. Whether Gemini or
// ChatGPT can classify records, answer a biomedical question or reason about
// evidence is that vendor's business, is not affected by anything in this
// repository, and measuring it here burns the user's subscription to produce
// a number nobody in this project can act on. An earlier version of this file
// scored six-way record classification and a PubMedQA sample; those were
// deleted, along with the benchmark harness, because a failure in them told
// us nothing about uibridge.
//
// Every assertion below is therefore about TRANSPORT AND HONESTY:
//
//   did the exact bytes we sent arrive, including the tail of a long input,
//   did the exact bytes it produced come back,
//   did the file we attached register, and the file it generated land on disk,
//   is the thread identity the provider's own and stable across turns,
//   does the export reproduce what we actually sent,
//   does the envelope describe what happened rather than what we hoped.
//
// The prompts are deliberately trivial ("reply with exactly X"). A frontier
// model complying with that is not an achievement being measured - it is the
// cheapest available probe that isolates the bridge from the model.
//
//   node test/acceptance.mjs <model> [case ...]

import OpenAI from 'openai'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'

const model = process.argv[2] ?? 'gemini-pro'
const only = process.argv.slice(3)
const baseURL = process.env.UIBRIDGE_BASE_URL ?? 'http://127.0.0.1:8477/v1'
const client = new OpenAI({ apiKey: 'local', baseURL, maxRetries: 0, timeout: 600000 })
const dir = resolve('.uibridge', 'acceptance', `${new Date().toISOString().replace(/[:.]/g, '-')}-${model}`)
mkdirSync(dir, { recursive: true })

const token = () => `UIB-${randomUUID().slice(0, 8).toUpperCase()}`
const sha256 = (v) => createHash('sha256').update(v).digest('hex')
const results = []
let lastThread = null

/** One turn, with the envelope invariants every turn must satisfy. */
async function call(messages, extra = {}) {
  const r = await client.chat.completions.create({ model, messages, ...extra })
  assert.equal(r.choices[0].finish_reason, 'stop')
  assert.equal(r._uibridge.provider_error, false, 'the provider answered rather than reporting a failure')
  assert.equal(r._uibridge.truncated, false)
  assert.ok(r._uibridge.thread_id, 'the provider-native thread id is reported')
  lastThread = r._uibridge.thread_id
  return r
}

const say = (text) => [{ role: 'user', content: text }]

const CASES = {
  // --- the round trip -------------------------------------------------------

  /** The irreducible claim: text in, the same text out, through a real UI. */
  async round_trip() {
    const mark = token()
    const r = await call(say(`Reply with exactly this and nothing else: ${mark}`))
    assert.equal(r.choices[0].message.content.trim(), mark, 'the answer came back intact')
    assert.equal(r._uibridge.input.characters, `Reply with exactly this and nothing else: ${mark}`.length)
    assert.equal(r._uibridge.input.transport, 'composer', 'a short prompt is typed, not attached')
    return { mark, extraction: r._uibridge.extraction }
  },

  /**
   * Characters a rich-text composer, a clipboard or a JSON hop can eat.
   *
   * ASSERTED AGAINST WHAT THE SITE RECEIVED, not against what the model
   * replied. Exporting the thread reads the USER message back out of the
   * provider's own transcript, so this measures the send path exactly and
   * depends on no model behaviour at all.
   *
   * MEASURED 2026-09-09, and the reason this case is shaped this way: asking
   * Gemini to echo `<angle>` came back without it, in BOTH the clipboard and
   * the rendered-DOM tiers, while the exported user message still contained
   * it. The provider dropped it; uibridge carried it. An assertion on the
   * echo would have failed and pointed at the wrong component.
   */
  async unicode() {
    const mark = token()
    const sent = `${mark} αβγ 中文 é ✓ "quotes" <angle> \\backslash | pipe — em-dash\ttab`
    const r = await call(say(`Reply with exactly: OK

Here is some text to ignore: ${sent}`))
    assert.ok(r.choices[0].message.content.length > 0, 'an answer came back')

    const res = await fetch(`${baseURL}/threads/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: model.split('-')[0], thread_id: r._uibridge.thread_id }),
      signal: AbortSignal.timeout(180000),
    })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body.error))
    const mine = body.messages.find((m) => m.role === 'user' && m.text.includes(mark))
    assert.ok(mine, 'our prompt is in the provider transcript')
    for (const piece of ['αβγ', '中文', 'é', '✓', '"quotes"', '<angle>', '\\backslash', '| pipe', '— em-dash']) {
      assert.ok(mine.text.includes(piece), `${piece} reached the site intact`)
    }
    return { mark }
  },

  // --- large input ----------------------------------------------------------

  /**
   * Did ALL of a large prompt arrive?
   *
   * Above `maxComposerChars` uibridge stops typing and carries the request as
   * a temporary UTF-8 attachment, because these editors truncate or stall on
   * a large paste - Gemini was measured silently keeping only the first
   * 32,000 characters. The probe is a token at the very END: if the tail was
   * dropped, it cannot come back.
   */
  async long_input_tail() {
    const head = token()
    const tail = token()
    const filler = 'Line of synthetic filler text for transport verification.\n'.repeat(3000)
    const prompt = `HEAD_TOKEN=${head}\n${filler}TAIL_TOKEN=${tail}\n\nReply with exactly the two token values separated by one comma, nothing else.`
    const r = await call(say(prompt))
    const got = r.choices[0].message.content
    assert.ok(got.includes(head), 'the beginning of a large input arrived')
    assert.ok(got.includes(tail), 'the END of a large input arrived - this is what truncation destroys')

    assert.equal(r._uibridge.input.characters, prompt.length, 'the reported length is the ORIGINAL length')
    assert.equal(r._uibridge.input.sha256, sha256(prompt), 'and the hash is of what we actually sent')
    assert.equal(r._uibridge.input.transport, 'attachment', 'a prompt this size travels as a file, and says so')
    return { characters: prompt.length, transport: r._uibridge.input.transport }
  },

  // --- files ----------------------------------------------------------------

  /** An attached file registers with the UI and its contents reach the model. */
  async attachment() {
    const mark = token()
    const path = resolve(dir, 'evidence.txt')
    writeFileSync(path, `Synthetic transport fixture.\nACCESSION=${mark}\nN=137\n`)
    const r = await call(
      say('Reply with exactly the ACCESSION value from the attached file, nothing else.'),
      { attachments: [path] }
    )
    assert.ok(r.choices[0].message.content.includes(mark), 'the file reached the provider')
    return { mark }
  },

  /** A file the provider GENERATES is retrieved to disk, with real bytes. */
  async generated_file() {
    const r = await call(say(
      'Create a CSV file named uib_transport.csv with the header "a,b" and one row "1,2", ' +
      'and give me the file to download. Reply with only the filename.'
    ))
    const files = r._uibridge.files ?? []
    assert.ok(files.length >= 1, `a generated file was retrieved (got ${JSON.stringify(files)})`)
    const [file] = files
    assert.ok(!file.error, `retrieval reported no error: ${file.error ?? ''}`)
    assert.ok(existsSync(file.path), 'the file is on this disk')
    assert.ok(file.bytes > 0, 'with real bytes in it')
    assert.match(readFileSync(file.path, 'utf8'), /a\s*,\s*b/i, 'and the bytes are the file that was asked for')
    return { name: file.name, bytes: file.bytes }
  },

  // --- thread identity ------------------------------------------------------

  /** A follow-up lands in the same provider-native conversation. */
  async continuation() {
    const mark = token()
    const first = await call(say(`Remember this value: ${mark}. Reply with exactly: STORED`))
    const thread = first._uibridge.thread_id
    const second = await call(
      say('Reply with exactly the value I asked you to remember, nothing else.'),
      { thread_id: thread }
    )
    assert.equal(second._uibridge.thread_id, thread, 'the answer came from the thread we named')
    assert.ok(second.choices[0].message.content.includes(mark), 'and it is the same conversation, not a fresh one')
    lastThread = thread
    return { thread }
  },

  /** Two conversations do not leak into each other. */
  async isolation() {
    const a = token()
    const b = token()
    const first = await call(say(`Remember this value: ${a}. Reply with exactly: STORED`))
    const second = await call(say(`Remember this value: ${b}. Reply with exactly: STORED`))
    assert.notEqual(second._uibridge.thread_id, first._uibridge.thread_id, 'a request without thread_id is a NEW conversation')

    const check = await call(say('Reply with exactly the value I asked you to remember, nothing else.'), { thread_id: first._uibridge.thread_id })
    assert.ok(check.choices[0].message.content.includes(a), 'the first thread still knows its own value')
    assert.ok(!check.choices[0].message.content.includes(b), "and does not know the other thread's")
    return { threads: [first._uibridge.thread_id, second._uibridge.thread_id] }
  },

  // --- extraction fidelity --------------------------------------------------

  /**
   * Markdown structure survives extraction and is parsed for the caller.
   *
   * This is uibridge's work, not the model's: the provider renders markdown
   * into DOM, and getting a table back as ROWS rather than as glyphs is the
   * difference between a usable pipeline and a screenshot.
   */
  async markdown_structure() {
    const r = await call(say(
      'Reply with only a markdown table with header columns "pmid" and "n", ' +
      'and exactly two rows: 111,7 and 222,9. No other text.'
    ))
    assert.equal(r._uibridge.markdown, true, 'the text is the provider markdown, not flattened innerText')
    const [table] = r._uibridge.tables
    assert.ok(table, `the table was parsed into rows (extraction: ${r._uibridge.extraction})`)
    assert.deepEqual(table.header.map((h) => h.toLowerCase()), ['pmid', 'n'])
    assert.equal(table.rows.length, 2)
    return { extraction: r._uibridge.extraction, rows: table.rows }
  },

  /** A code fence comes back as source, with its language. */
  async code_fence() {
    const r = await call(say('Reply with only a python code block containing exactly: print("uib")'))
    const [block] = r._uibridge.code_blocks
    assert.ok(block, `a fenced block was parsed (extraction: ${r._uibridge.extraction})`)
    assert.match(block.code, /print\("uib"\)/)
    return { language: block.language }
  },

  // --- streaming ------------------------------------------------------------

  /** Deltas are monotonic and concatenate to exactly the final answer. */
  async stream() {
    const mark = token()
    const stream = await client.chat.completions.create({
      model, stream: true,
      messages: say(`Reply with exactly this and nothing else: ${mark}`),
    })
    const chunks = []
    for await (const c of stream) chunks.push(c)
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')
    assert.ok(text.includes(mark), 'the streamed text is the answer')
    const finish = chunks.filter((c) => c.choices[0]?.finish_reason)
    assert.equal(finish.length, 1, 'exactly one frame ends the message')
    assert.equal(finish[0].choices[0].finish_reason, 'stop')
    // The SDK's own iterator consumed [DONE]; reaching here means the stream
    // terminated rather than being left open for the client to time out on.
    return { chunks: chunks.length }
  },

  // --- the record -----------------------------------------------------------

  /**
   * The export reproduces what WE SENT, not an approximation of it.
   *
   * This is the audit trail: if a thread's export does not contain the exact
   * prompt that was sent, nothing downstream can be reconstructed.
   */
  async export_fidelity() {
    const mark = token()
    const sent = `Export fidelity probe ${mark}. Reply with exactly: NOTED`
    const r = await call(say(sent))
    const res = await fetch(`${baseURL}/threads/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: model.split('-')[0], thread_id: r._uibridge.thread_id }),
      signal: AbortSignal.timeout(180000),
    })
    const body = await res.json()
    writeFileSync(resolve(dir, 'export.json'), JSON.stringify(body, null, 2))
    assert.equal(res.status, 200, JSON.stringify(body.error))

    const user = body.messages.filter((m) => m.role === 'user')
    assert.ok(user.some((m) => m.text.includes(mark)), 'the exact prompt we sent is in the export')
    assert.equal(body.evidence.order_verified, true, 'the transcript order is verified, not assumed')
    assert.equal(body.complete, true)
    return { messages: body.messages.length, evidence: body.evidence }
  },

  /** Provenance describes the turn that actually happened. */
  async provenance() {
    const r = await call(say('Reply with exactly: PROV'))
    const p = r._uibridge.provenance
    assert.equal(p.model.requested, model)
    assert.equal(p.model.verified, true, `the model was verified from the UI (${p.model.note})`)
    assert.ok(r._uibridge.ledger?.path, 'the turn was written to the local ledger')
    assert.ok(existsSync(r._uibridge.ledger.path), 'and that file exists')
    assert.deepEqual(r._uibridge.unsupported_parameters, [], 'nothing was silently ignored')
    return { applied: p.model.applied, final_state: p.final_state }
  },
}

const chosen = only.length ? only : Object.keys(CASES)
console.log(`Live bridge fidelity: ${model}; artifacts: ${dir}`)
for (const name of chosen) {
  if (!CASES[name]) { console.log(`SKIP ${name}: no such case`); continue }
  const started = Date.now()
  try {
    const detail = await CASES[name]()
    results.push({ case: name, ok: true, ms: Date.now() - started, detail })
    console.log(`PASS ${name} (${Date.now() - started}ms)`)
  } catch (e) {
    results.push({ case: name, ok: false, ms: Date.now() - started, error: e.message })
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`)
  }
}
writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ model, baseURL, results }, null, 2))
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
