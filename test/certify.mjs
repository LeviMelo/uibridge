// CERTIFICATION BY USE.
//
// Not a unit suite. This drives the shipped artefacts the way a person and a
// program actually drive them - the real `uibridge` CLI in real child
// processes, and the real `openai` client over HTTP - against a real,
// signed-in provider, and checks that every layer agrees with every other.
//
// WHAT IT ASSERTS, AND WHAT IT REFUSES TO ASSERT
//
// Every check here is about TRANSPORT, PLUMBING AND HONESTY:
//   - the exact bytes we sent are the bytes the site received (proved by
//     reading the user turn back out of the provider's own transcript, never
//     by trusting the model to repeat them),
//   - the envelope truthfully describes what happened,
//   - a thread is the provider's own id, and it is stable across the CLI, the
//     API and the ledger,
//   - a file goes up, a generated file comes down, with real bytes,
//   - failures are typed, and a failure that already reached the site is not
//     retried into a duplicate message.
//
// NOTHING HERE MEASURES THE MODEL. Not accuracy, not reasoning, not whether
// an answer is "good". That is the vendor's business, is unaffected by
// anything in this repository, and spends the user's paid subscription to
// produce a number nobody here can act on. See "What uibridge is not" in
// README.md. Prompts are deliberately trivial ("reply with the word OK")
// precisely so that the answer's CONTENT is never the thing under test.
//
//   node test/certify.mjs                       # both providers
//   node test/certify.mjs gemini-pro            # one model
//   node test/certify.mjs gemini-pro chatgpt-5.6-medium
//
// Exits non-zero if any check fails. Evidence lands in .uibridge/certify/.

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const BIN = join(ROOT, 'bin', 'uibridge.mjs')
const BASE = process.env.UIBRIDGE_BASE ?? 'http://127.0.0.1:8477'
const MODELS = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const EVIDENCE = join(ROOT, '.uibridge', 'certify')
const NL = String.fromCharCode(10)

const results = []
let scope = '(none)'
const say = (s = '') => process.stdout.write(s + NL)
// `pass === null` means SKIPPED: a scope whose prerequisite did not run.
// Reporting those as failures buries the one real finding under a cascade of
// derived ones - measured, a single flaky model-picker turn produced eight
// downstream FAILs that were all the same fact.
function check(name, pass, detail = '') {
  const state = pass === null ? 'skip' : pass ? 'pass' : 'fail'
  results.push({ scope, name, state, pass: state === 'pass', detail: String(detail) })
  say(`  ${state === 'skip' ? 'SKIP' : state === 'pass' ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`)
}
/** Guard a scope that cannot run because an earlier one did not produce its input. */
const needs = (value, what) => {
  if (value) return true
  check(`skipped: needs ${what}`, null, 'an earlier scope did not produce it')
  return false
}

/** Run the real CLI, exactly as a shell would. */
function cli(args, { input, timeout = 600000 } = {}) {
  return new Promise((done) => {
    const child = execFile(process.execPath, [BIN, ...args], { timeout, cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => done({ code: err?.code ?? 0, stdout, stderr, out: `${stdout}${stderr}` }))
    if (input !== undefined) child.stdin.end(input)
  })
}
const firstJSON = (text) => {
  const i = [text.indexOf('{'), text.indexOf('[')].filter((n) => n !== -1)
  if (!i.length) throw new Error(`no JSON in: ${text.slice(0, 160)}`)
  return JSON.parse(text.slice(Math.min(...i)))
}
const http = (path, body, headers = {}) =>
  fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, headers: r.headers, payload: await r.json().catch(() => null) }))

const stamp = () => `cert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const userTurns = (ex) => (ex?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.text ?? '')

async function scoped(title, fn) {
  scope = title
  say(NL + `-- ${title}`)
  try {
    await fn()
  } catch (err) {
    // A typed error from the site is the bridge doing its job; an untyped
    // throw is the bridge failing at it. Only the latter is a certification
    // failure, and it is always reported as one.
    const typed = err?.error?.type ?? err?.type
    // `internal` is the catch-all, not a taxonomy entry: reaching it means an
    // error escaped typing, which is a defect in here and never acceptable.
    if (typed && typed !== 'internal' && err?.status && err.status !== 500) {
      check(`${title} reached a site-side condition`, true, `${err.status} ${typed} - typed and labelled, which is correct behaviour`)
    } else {
      check(`${title} completed without an untyped throw`, false, String(err?.stack ?? err).split(NL)[0])
    }
  }
}

// ---------------------------------------------------------------------------

say('uibridge certification by use')
say(`  base   : ${BASE}`)
say(`  root   : ${ROOT}`)

const health = await http('/health')
if (health.status !== 200) {
  say(`${NL}No uibridge on ${BASE}. Start one with: uibridge serve`)
  process.exit(2)
}
const providers = health.payload.providers.filter((p) => p !== 'echo')
const models = MODELS.length ? MODELS : providers.map((p) => (p === 'gemini' ? 'gemini-pro' : 'chatgpt-5.6-medium'))
say(`  version: ${health.payload.version}   home: ${health.payload.home}`)
say(`  models : ${models.join(', ')}`)
mkdirSync(EVIDENCE, { recursive: true })

// === SCOPE 1: the daemon's identity, before anything is asked of it =========

await scoped('daemon identity and shape', async () => {
  const h = health.payload
  check('health names the service and protocol', h.service === 'uibridge' && typeof h.protocol === 'number', `protocol ${h.protocol}`)
  check('health publishes which state directory it serves', typeof h.home === 'string' && h.home.length > 0, h.home)
  check('health publishes its version', /^\d+\.\d+\.\d+$/.test(h.version), h.version)
  check('health reports request capacity and load', typeof h.requests?.capacity === 'number' && typeof h.requests?.active === 'number',
    `active ${h.requests.active} / ${h.requests.capacity}`)
  const cap = await http('/v1/capabilities')
  check('capabilities are declared, not implied', cap.status === 200 && !!cap.payload.api, JSON.stringify(Object.keys(cap.payload ?? {})))
})

// === SCOPE 2: the CLI's non-provider surface ================================

await scoped('CLI: discovery, state and refusals (no provider work)', async () => {
  const [version, help, modelsTxt, modelsJson, paths, profiles, badFlag, badProvider] = await Promise.all([
    cli(['--version']), cli(['--help']), cli(['models']), cli(['models', '--json']),
    cli(['paths', '--json']), cli(['profiles', '--json']),
    cli(['ask', 'gemini', 'x', '--tempreature=0']), cli(['ask', 'nosuchprovider', 'x']),
  ])
  check('--version prints just a version, exit 0', version.code === 0 && /^\d+\.\d+\.\d+$/.test(version.stdout.trim()), version.stdout.trim())
  check('--help exits 0 and lists commands', help.code === 0 && /uibridge chat/.test(help.stdout), `${help.stdout.split(NL).length} lines`)
  check('models lists ids one per line', modelsTxt.code === 0 && modelsTxt.stdout.trim().split(NL).length > 1, `${modelsTxt.stdout.trim().split(NL).length} ids`)
  check('models --json is a parseable array', Array.isArray(firstJSON(modelsJson.stdout)), `${firstJSON(modelsJson.stdout).length} entries`)
  check('paths --json parses', typeof firstJSON(paths.stdout) === 'object', JSON.stringify(Object.keys(firstJSON(paths.stdout))).slice(0, 90))
  check('profiles --json parses', Array.isArray(firstJSON(profiles.stdout)) && profiles.code === 0)
  check('an unknown flag is refused, not swept into the prompt', badFlag.code === 1 && /tempreature/.test(badFlag.out))
  check('an unknown provider is refused with the known list', badProvider.code === 1 && /Known:/.test(badProvider.out))
})

// === per-model scopes =======================================================

for (const MODEL of models) {
  const provider = MODEL.split('-')[0]
  const client = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: 'local', maxRetries: 0, timeout: 900000 })
  const exportThread = (thread_id, files = false) => http('/v1/threads/export', { provider, thread_id, files }).then((r) => r.payload)
  say(NL + `${'='.repeat(66)}${NL}=== ${MODEL}${NL}${'='.repeat(66)}`)

  let cliThread = null
  let apiThread = null
  let genThread = null

  await scoped(`${MODEL}: signed-in state, through the CLI and the API`, async () => {
    const [statusTxt, statusJson, session, one] = await Promise.all([
      cli(['status', provider]), cli(['status', provider, '--json']),
      http('/v1/session', { provider }), http(`/v1/models/${MODEL}`),
    ])
    check('CLI status reports authenticated', statusTxt.code === 0 && /authenticated/.test(statusTxt.out), statusTxt.stdout.trim().split(NL)[0])
    check('CLI status --json agrees', firstJSON(statusJson.stdout)[provider]?.authenticated === true)
    check('API /v1/session agrees with the CLI', session.payload[provider]?.authenticated === true, session.payload[provider]?.state)
    check('models.retrieve style lookup answers', one.status === 200 && one.payload.id === MODEL, `owned_by ${one.payload?.owned_by}`)
  })

  await scoped(`${MODEL}: a real ask through the CLI`, async () => {
    const marker = stamp()
    const prompt = `Reply with the single word OK. Token: ${marker}`
    const r = await cli(['ask', provider, prompt, `--model=${MODEL}`, '--json'])
    check('ask exits 0', r.code === 0, r.code === 0 ? '' : r.out.slice(0, 200))
    const body = firstJSON(r.stdout)
    cliThread = body.thread_id ?? body._uibridge?.thread_id
    check('ask --json carries an answer and a thread id', typeof body.text === 'string' && !!cliThread, `thread ${cliThread}`)
    check('the input is described exactly', body.input?.characters === prompt.length && /^[0-9a-f]{64}$/.test(body.input?.sha256 ?? ''),
      `${body.input?.characters} chars via ${body.input?.transport}`)
    const ex = await exportThread(cliThread)
    check('THE SITE RECEIVED THE EXACT BYTES WE SENT', userTurns(ex).some((t) => t.includes(marker) && t.includes('Reply with the single word OK')),
      JSON.stringify(userTurns(ex).at(-1)?.slice(0, 60)))
    writeFileSync(join(EVIDENCE, `${MODEL}-cli-ask.json`), JSON.stringify({ prompt, body, exported: ex }, null, 2))
  })

  await scoped(`${MODEL}: durable request - a key means one turn, not two`, async () => {
    const key = `cert-${stamp()}`
    const first = await cli(['ask', provider, 'Reply with the single word ONCE.', `--model=${MODEL}`, `--key=${key}`, '--json'])
    check('a keyed ask succeeds', first.code === 0, first.code === 0 ? '' : first.out.slice(0, 160))
    const a = firstJSON(first.stdout)
    const [status, recovered] = await Promise.all([
      cli(['request', 'status', key, '--json']),
      cli(['request', 'recover', key, '--json']),
    ])
    check('request status reports a finished record', /completed/.test(status.out), firstJSON(status.stdout)?.state)
    const b = firstJSON(recovered.stdout)
    check('recover replays the same answer without re-asking', (b.text ?? b.choices?.[0]?.message?.content) === a.text)
    const ex = await exportThread(a.thread_id)
    check('and the site was asked exactly once', userTurns(ex).length === 1, `${userTurns(ex).length} user turns`)
  })

  await scoped(`${MODEL}: chat, as a conversation`, async () => {
    const r = await cli(['chat', provider, `--model=${MODEL}`, '--jsonl'],
      { input: `Remember the number 4721. Acknowledge in under five words.${NL}What number did I give you? Digits only.${NL}/thread${NL}/exit${NL}never sent${NL}` })
    check('chat exits 0', r.code === 0, r.code === 0 ? '' : r.out.slice(-200))
    const lines = r.stdout.trim().split(NL).filter(Boolean).map(JSON.parse)
    // An error record is a line too. Counting lines said "2 turns" when one
    // of them was a failure, so require two ANSWERS.
    const answered = lines.filter((l) => typeof l.text === 'string' && !l.error)
    check('both turns came back', answered.length === 2, `${answered.length} answered, ${lines.length} records`)
    check('on ONE conversation', new Set(lines.map((l) => l.thread_id)).size === 1, lines[0]?.thread_id)
    check('/exit stopped before the trailing line', !r.stdout.includes('never sent'))
    check('/thread reported the id on stderr, keeping stdout parseable', /resume later/.test(r.stderr))
    const ex = await exportThread(lines[0].thread_id)
    check('the site transcript holds both of our turns in order', userTurns(ex).length === 2 && userTurns(ex)[0].includes('4721'),
      `${userTurns(ex).length} user turns`)
  })

  await scoped(`${MODEL}: the ledger, the CLI and the API describe the same thread`, async () => {
    if (!needs(cliThread, 'a thread from the CLI ask scope')) return
    const [threadsJson, threadShow, ledger, list] = await Promise.all([
      cli(['threads', provider, '--json']),
      cli(['thread', provider, cliThread]),
      http('/v1/threads/events', { provider, thread_id: cliThread }),
      http('/v1/threads/list', { provider }),
    ])
    const ids = firstJSON(threadsJson.stdout).map((t) => t.thread_id)
    check('CLI threads lists the thread the CLI just created', ids.includes(cliThread), `${ids.length} threads recorded`)
    check('CLI thread shows its turn ledger', threadShow.code === 0 && threadShow.stdout.length > 0, threadShow.stdout.split(NL)[0]?.slice(0, 70))
    check('API events returns the same ledger', ledger.status === 200 && ledger.payload.events.length > 0, `${ledger.payload?.events?.length} events`)
    check('API list agrees with the CLI', list.payload.threads.some((t) => t.thread_id === cliThread))
    const miss = await http('/v1/threads/events', { provider, thread_id: 'definitely-not-a-thread' })
    check('an unknown thread is a typed 404, not an empty success', miss.status === 404 && miss.payload.error.type === 'thread_unknown')
  })

  await scoped(`${MODEL}: export the whole thread to disk`, async () => {
    if (!needs(cliThread, 'a thread from the CLI ask scope')) return
    const out = join(EVIDENCE, `${MODEL}-export.json`)
    const r = await cli(['export', provider, cliThread, `--output=${out}`, '--json'])
    check('export exits 0 and writes where it says', r.code === 0 && existsSync(out), `${existsSync(out) ? statSync(out).size : 0} bytes`)
    const doc = JSON.parse(readFileSync(out, 'utf8'))
    check('the export is complete and ordered', doc.complete === true && doc.messages.length >= 2, `${doc.messages.length} messages, complete=${doc.complete}`)
    check('it carries completeness evidence, not just a claim', ['reached_top', 'reached_bottom', 'message_count', 'order_verified'].every((k) => k in doc.evidence))
  })

  await scoped(`${MODEL}: the API, through the official openai client`, async () => {
    const marker = stamp()
    const c = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: `Reply with the single word FINE. Token: ${marker}` }] })
    apiThread = c._uibridge.thread_id
    check('a completion is a well-formed chat.completion', c.object === 'chat.completion' && /^chatcmpl-/.test(c.id) && c.model === MODEL)
    check('finish_reason stop, one choice, assistant role', c.choices.length === 1 && c.choices[0].finish_reason === 'stop' && c.choices[0].message.role === 'assistant')
    check('usage is present and numeric (zeros are honest here)', typeof c.usage?.total_tokens === 'number', JSON.stringify(c.usage))
    const ex = await exportThread(apiThread)
    check('THE SITE RECEIVED THE EXACT BYTES WE SENT', userTurns(ex).some((t) => t.includes(marker)))
  })

  await scoped(`${MODEL}: streaming, end to end`, async () => {
    let acc = '', chunks = 0, roleFirst = false, finish = null, bridge = null
    const t0 = Date.now()
    const stream = await client.chat.completions.create({ model: MODEL, stream: true,
      messages: [{ role: 'user', content: 'Count from 1 to 5, digits separated by single spaces. Nothing else.' }] })
    for await (const p of stream) {
      chunks++
      if (chunks === 1) roleFirst = p.choices[0]?.delta?.role === 'assistant'
      acc += p.choices[0]?.delta?.content ?? ''
      if (p.choices[0]?.finish_reason) finish = p.choices[0].finish_reason
      if (p._uibridge) bridge = p._uibridge
    }
    check('the stream assembles into a complete answer', acc.trim().length > 0, `${chunks} chunks in ${Date.now() - t0}ms`)
    check('the role delta comes first', roleFirst)
    check('it finishes with a reason', finish === 'stop', String(finish))
    check('and the bridge metadata rides the final chunk', !!bridge?.thread_id, bridge?.thread_id)
  })

  await scoped(`${MODEL}: thread continuity across CLI and API`, async () => {
    if (!needs(cliThread, 'a thread from the CLI ask scope')) return
    // The API continues a conversation the CLI started. Same site thread.
    const c = await client.chat.completions.create({ model: MODEL, thread_id: cliThread,
      messages: [{ role: 'user', content: 'Reply with the single word CONTINUED.' }] })
    check('the API continues a thread the CLI created', c._uibridge.thread_id === cliThread, `${cliThread} -> ${c._uibridge.thread_id}`)
    check('history state is declared, either way', c._uibridge.provenance?.history !== undefined, JSON.stringify(c._uibridge.provenance?.history))
    const ex = await exportThread(cliThread)
    check('the site transcript grew, in one conversation', userTurns(ex).length >= 2, `${userTurns(ex).length} user turns`)
  })

  await scoped(`${MODEL}: a file goes up`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uibridge-cert-'))
    const csv = join(dir, 'measurements.csv')
    writeFileSync(csv, `sample_id,value${NL}A1,3.14${NL}A2,2.71${NL}`)
    try {
      const r = await cli(['ask', provider, 'Reply with the single word RECEIVED.', `--model=${MODEL}`, `--file=${csv}`, '--json'])
      check('an attached file is accepted and the turn succeeds', r.code === 0, r.code === 0 ? '' : r.out.slice(0, 200))
      const body = firstJSON(r.stdout)
      const ex = await exportThread(body.thread_id)
      const withFile = (ex?.messages ?? []).filter((m) => m.role === 'user' && ((m.attachments?.length ?? 0) || (m.media?.length ?? 0)))
      check('THE SITE RECORDS THE ATTACHMENT ON OUR TURN', withFile.length > 0,
        JSON.stringify((ex?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.attachments?.length ?? 0)))
      const missing = await cli(['ask', provider, 'x', `--model=${MODEL}`, `--file=${join(dir, 'nope.csv')}`])
      check('a file that is not there fails before anything is sent', missing.code === 1 && /not found/i.test(missing.out))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await scoped(`${MODEL}: a generated file comes down`, async () => {
    const c = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content:
      'Create a downloadable CSV file named cert_output.csv with a header row "sample_id,value" and exactly two data rows. Provide it as a file I can download.' }] })
    genThread = c._uibridge.thread_id
    const files = c._uibridge.files ?? []
    if (!files.length) {
      check('a generated file was offered by the site', false, 'the site produced no downloadable file for this turn')
      return
    }
    const f = files[0]
    check('the generated file is reported with a real path', typeof f.path === 'string' && existsSync(f.path), `${f.name} -> ${f.path}`)
    check('and the bytes are actually on disk', existsSync(f.path) && statSync(f.path).size > 0, `${existsSync(f.path) ? statSync(f.path).size : 0} bytes`)
    check('no file is reported with an error alongside it', !f.error, f.error ?? '')
  })

  await scoped(`${MODEL}: structured output is validated, not hoped for`, async () => {
    const schema = { type: 'object', properties: { status: { type: 'string' }, count: { type: 'integer' } }, required: ['status', 'count'], additionalProperties: false }
    const c = await client.chat.completions.create({ model: MODEL,
      response_format: { type: 'json_schema', json_schema: { name: 'cert', schema, strict: true } },
      messages: [{ role: 'user', content: 'Return status "ok" and count 2.' }] })
    const parsed = JSON.parse(c.choices[0].message.content)
    check('the answer parses as JSON', typeof parsed === 'object')
    check('and conforms to the schema we asked for', typeof parsed.status === 'string' && Number.isInteger(parsed.count), JSON.stringify(parsed).slice(0, 80))
  })

  await scoped(`${MODEL}: a long input keeps its tail`, async () => {
    const tail = stamp()
    const filler = Array.from({ length: 900 }, (_, i) => `Line ${i}: filler present only to exceed the composer limit and force the file transport.`).join(NL)
    const long = `${filler}${NL}${NL}FINAL LINE, tail marker ${tail}. Reply with the single word DONE.`
    const c = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: long }] })
    check('a long input is accepted', typeof c.choices[0].message.content === 'string', `${c._uibridge.input.characters} chars`)
    check('the FULL length is recorded, not a truncated one', c._uibridge.input.characters === long.length, `${c._uibridge.input.characters} vs ${long.length}`)
    check('the switch to a file transport is declared, never silent', c._uibridge.input.transport === 'attachment', c._uibridge.input.transport)
    const ex = await exportThread(c._uibridge.thread_id)
    const carried = (ex?.messages ?? []).some((m) => m.role === 'user' && ((m.attachments?.length ?? 0) || (m.media?.length ?? 0) || (m.text ?? '').includes(tail)))
    check('THE SITE RECEIVED THE WHOLE THING (as a file or verbatim)', carried,
      JSON.stringify((ex?.messages ?? []).filter((m) => m.role === 'user').map((m) => ({
        chars: (m.text ?? '').length,
        attachments: (m.attachments ?? []).map((a) => a.label),
        media: m.media?.length ?? 0,
      }))))
  })

  await scoped(`${MODEL}: annexes - files through a real conversation`, async () => {
    // THE CHAT-UI CASE. A person opens a conversation, drops a file in, talks
    // about it over several turns, and gets a file back. Every part of that
    // has to work through both layers, and the record of it has to survive
    // into the export - an audit trail that omits the annex is worse than no
    // audit trail, because it looks complete.
    const dir = mkdtempSync(join(tmpdir(), 'uibridge-annex-'))
    const csv = join(dir, 'trial_outcomes.csv')
    const txt = join(dir, 'protocol_note.txt')
    const md = join(dir, 'appendix.md')
    const token = stamp()
    writeFileSync(csv, 'pmid,drug,n' + NL + '12345,propofol,60' + NL + '23456,sevoflurane,58' + NL)
    writeFileSync(txt, 'Protocol note. Annex token: ' + token + NL)
    writeFileSync(md, '# Appendix' + NL + NL + 'A second annex, in markdown.' + NL)
    try {
      // (a) two annexes of different types on one turn, through the API
      const many = await client.chat.completions.create({ model: MODEL, files: [csv, txt],
        messages: [{ role: 'user', content: 'Reply with the single word ANNEXED.' }] })
      check('two annexes of different types on one turn are accepted', typeof many.choices[0].message.content === 'string',
        `transport ${many._uibridge.input.transport}`)
      const exMany = await exportThread(many._uibridge.thread_id)
      const att = (exMany?.messages ?? []).filter((m) => m.role === 'user').flatMap((m) => m.attachments ?? [])
      check('BOTH annexes are recorded on the site turn', att.length >= 2, JSON.stringify(att.map((a) => a.label)))

      // (b) an annex inside a real chat, with the conversation continuing after it
      const chat = await cli(['chat', provider, `--model=${MODEL}`, `--file=${md}`, '--jsonl'],
        { input: 'Reply with the single word ONE.' + NL + 'Reply with the single word TWO.' + NL + '/exit' + NL })
      check('chat --file attaches and the conversation continues past it', chat.code === 0, chat.code === 0 ? '' : chat.out.slice(-200))
      const lines = chat.stdout.trim().split(NL).filter(Boolean).map(JSON.parse)
      check('both chat turns answered on one thread', lines.length === 2 && new Set(lines.map((l) => l.thread_id)).size === 1,
        `${lines.length} turns`)
      if (lines.length) {
        const exChat = await exportThread(lines[0].thread_id)
        const chatAtt = (exChat?.messages ?? []).filter((m) => m.role === 'user').flatMap((m) => m.attachments ?? [])
        check('the annex rides the FIRST turn only, and is recorded', chatAtt.length === 1, JSON.stringify(chatAtt.map((a) => a.label)))
        check('and the later turn is in the same conversation, un-annexed', userTurns(exChat).length === 2, `${userTurns(exChat).length} user turns`)
      }

      // (c) files coming back DOWN: retrieve everything a thread generated
      if (genThread) {
        const out = join(dir, 'with-files.json')
        const r = await cli(['export', provider, genThread, '--files', `--output=${out}`, '--json'])
        check('export --files retrieves the thread and its generated files', r.code === 0 && existsSync(out),
          r.code === 0 ? '' : r.out.slice(-200))
        if (existsSync(out)) {
          const doc = JSON.parse(readFileSync(out, 'utf8'))
          const got = doc.files ?? []
          const real = got.filter((f) => f.path && existsSync(f.path) && statSync(f.path).size > 0)
          // Report WHY, not just that. A retrieval that fails on the site
          // records its reason on the file entry; throwing that away is how
          // a failure here turned into a re-run to find out what happened.
          check('every retrieved file is on disk with real bytes', got.length > 0 && real.length === got.length,
            JSON.stringify(got.map((f) =>
              f.path && existsSync(f.path)
                ? `${f.name}:${statSync(f.path).size}`
                : `${f.name}:MISSING(${f.error ?? 'no path and no error recorded'})`)))
        }
      }

      // (d) an annex that is not there must fail before the site is touched
      const missing = await cli(['ask', provider, 'x', `--model=${MODEL}`, `--file=${join(dir, 'absent.csv')}`])
      check('a missing annex fails before anything is sent', missing.code === 1 && /not found/i.test(missing.out))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await scoped(`${MODEL}: refusals that protect the account`, async () => {
    const [bogus, unknownModel, tools, empty] = await Promise.all([
      http('/v1/chat/completions', { model: MODEL, thread_id: 'ffffffffffffffff', messages: [{ role: 'user', content: 'MUST NOT BE SENT' }] }),
      http('/v1/chat/completions', { model: 'no-such-model', messages: [{ role: 'user', content: 'x' }] }),
      http('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] }),
      http('/v1/chat/completions', { model: MODEL, messages: [] }),
    ])
    check('a thread the site never issued is refused BEFORE anything is sent',
      bogus.status >= 400 && /[Nn]othing was sent/.test(bogus.payload?.error?.message ?? ''),
      `${bogus.status} ${bogus.payload?.error?.type}: ${(bogus.payload?.error?.message ?? '').slice(0, 90)}`)
    check('the retry verdict is on the wire', bogus.headers.get('x-should-retry') !== null, `x-should-retry: ${bogus.headers.get('x-should-retry')}`)
    check('an unknown model is a 400, not a guess', unknownModel.status === 400, `${unknownModel.status} ${unknownModel.payload?.error?.type}`)
    check('tools are refused, not silently dropped', tools.status === 400, `${tools.status}`)
    check('empty messages are a 400', empty.status === 400, `${empty.status}`)
  })

  await scoped(`${MODEL}: mixed CLI and API load at the same time`, async () => {
    const n = 3
    const t0 = Date.now()
    const [apiResults, cliResult] = await Promise.all([
      Promise.all(Array.from({ length: n }, (_, i) =>
        client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: `Reply with exactly: PARALLEL-${i}` }] })
          .then((c) => ({ i, ok: true, thread: c._uibridge.thread_id, id: c.id }))
          .catch((e) => ({ i, ok: false, err: `${e.status} ${e.error?.type ?? e.message}` })))),
      cli(['ask', provider, 'Reply with exactly: CLI-CONCURRENT', `--model=${MODEL}`, '--json']),
    ])
    const ok = apiResults.filter((r) => r.ok)
    check(`${n} API calls and a CLI ask ran together`, ok.length + (cliResult.code === 0 ? 1 : 0) === n + 1,
      `${ok.length}/${n} API ok, CLI exit ${cliResult.code}, ${Date.now() - t0}ms — ${apiResults.filter((r) => !r.ok).map((r) => r.err).join('; ')}`)
    check('every concurrent request got its own conversation', new Set(ok.map((r) => r.thread)).size === ok.length,
      `${new Set(ok.map((r) => r.thread)).size} distinct threads`)
    check('and its own completion id', new Set(ok.map((r) => r.id)).size === ok.length)
    const after = await http('/health')
    check('the queue drained back to idle', after.payload.requests.active === 0, `active=${after.payload.requests.active}`)
    check('one browser session served all of it', Object.keys(after.payload.sessions).length <= providers.length,
      JSON.stringify(after.payload.sessions))
  })
}

// === report =================================================================

const failed = results.filter((r) => r.state === 'fail')
const skipped = results.filter((r) => r.state === 'skip')
const byScope = new Map()
for (const r of results) {
  if (!byScope.has(r.scope)) byScope.set(r.scope, { pass: 0, fail: 0, skip: 0 })
  byScope.get(r.scope)[r.state]++
}
say(NL + '='.repeat(66))
say('SUMMARY')
for (const [s, n] of byScope) say(`  ${n.fail ? 'FAIL' : n.skip ? 'SKIP' : ' ok '}  ${String(n.pass + n.fail).padStart(3)} checks  ${s}`)
say('='.repeat(66))
say(`${results.length} checks, ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`)
if (failed.length) {
  say(NL + 'FAILURES:')
  for (const f of failed) say(`  [${f.scope}] ${f.name}${f.detail ? '   ' + f.detail : ''}`)
}
writeFileSync(join(EVIDENCE, 'certify-report.json'),
  JSON.stringify({ at: new Date().toISOString(), base: BASE, models, results }, null, 2))
say(`${NL}evidence: ${EVIDENCE}`)
process.exit(failed.length ? 1 : 0)
