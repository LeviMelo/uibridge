// DOES THE CLI ACTUALLY WORK?
//
// The CLI is the interface a person uses and a script automates, so its
// contract is not just "prints something": it is exit codes, --json documents
// that parse, flags that are honoured or refused rather than ignored, and
// errors that read as instructions instead of stack traces.
//
// None of that involves a chat UI, so none of it is tested against one. The
// scripted provider (src/providers/echo) makes every case deterministic and
// offline; what is exercised is the real bin/uibridge.mjs, in a real child
// process, against a real daemon.
//
//   node --test test/cli.mjs

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const BIN = join(ROOT, 'bin', 'uibridge.mjs')
const PORT = 8500 + (process.pid % 200)
let home

/** Run the CLI exactly as a user would, and report what a shell would see. */
function cli(args, { timeout = 60000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [BIN, ...args], {
      timeout,
      env: { ...process.env, UIBRIDGE_HOME: home, UIBRIDGE_TEST_PROVIDER: '1' },
      cwd: ROOT,
    }, (err, stdout, stderr) => {
      resolvePromise({ code: err?.code ?? 0, stdout, stderr, out: `${stdout}${stderr}` })
    })
  })
}

/** The first JSON value in a stream that may also carry human-readable lines. */
const json = (text) => {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i !== -1)
  if (!starts.length) throw new Error(`no JSON in output: ${JSON.stringify(text.slice(0, 200))}`)
  return JSON.parse(text.slice(Math.min(...starts)))
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'uibridge-cli-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: PORT, defaultProvider: 'echo' }))
})

after(async () => {
  await cli(['stop'])
  rmSync(home, { recursive: true, force: true })
})

// --- the basics -------------------------------------------------------------

test('help is available, exits 0, and lists the commands it accepts', async () => {
  // NOT the empty argument list: bare `uibridge` starts the daemon, which is
  // the documented default and would block here.
  for (const args of [['--help'], ['-h'], ['ask', '--help']]) {
    const r = await cli(args)
    assert.equal(r.code, 0, `${args.join(' ') || '(no args)'} exits 0`)
    for (const cmd of ['serve', 'login', 'ask', 'chat', 'export', 'threads', 'doctor', 'stop', 'paths']) {
      assert.match(r.out, new RegExp(`uibridge ${cmd}`), `${cmd} is documented`)
    }
  }
})

test('an unknown command exits non-zero', async () => {
  const r = await cli(['frobnicate'])
  assert.notEqual(r.code, 0)
})

test('an unknown provider is named, with the known ones, and exits 1', async () => {
  const r = await cli(['ask', 'nosuchprovider', 'hi'])
  assert.equal(r.code, 1)
  assert.match(r.out, /Unknown provider "nosuchprovider"/)
  assert.match(r.out, /echo/, 'and says what IS available')
})

test('unknown flags are refused rather than silently ignored', async () => {
  // `--out` on a command whose flag is `--output=` once wrote to the default
  // path and said nothing; in `ask` an unknown flag was swept into the prompt
  // and sent to the model.
  const r = await cli(['export', 'echo', 'abc', '--out', 'x.json'])
  assert.equal(r.code, 1)
  assert.match(r.out, /unknown option --out/)
  assert.match(r.out, /Did you mean --output\?/, 'and suggests the real one')

  const a = await cli(['ask', 'echo', 'hello', '--temperature=0'])
  assert.equal(a.code, 1)
  assert.match(a.out, /unknown option --temperature/)
})

test('a value flag written with a space is refused, not swept into the prompt', async () => {
  // The other half of the same defect, and the more dangerous half: --model
  // is a KNOWN flag, so name-only validation passed it, and the parsers match
  // only `--model=`. Measured: `ask echo --model echo-fast hello` exited 0
  // having sent the model the literal prompt "--model echo-fast hello" with
  // provenance.model null. It looked exactly like success.
  const m = await cli(['ask', 'echo', '--model', 'echo-fast', 'hello'])
  assert.equal(m.code, 1, 'it must not answer')
  assert.match(m.out, /--model needs its value attached/)

  // Same shape silently wrote exports to the default location.
  const o = await cli(['export', 'echo', 'abc', '--output', 'wanted.json'])
  assert.equal(o.code, 1)
  assert.match(o.out, /--output needs its value attached/)

  // The `=` form still works, and boolean flags are untouched.
  const ok = await cli(['ask', 'echo', 'hello', '--model=echo-fast', '--json'])
  assert.equal(ok.code, 0)
  const doc = json(ok.stdout)
  assert.equal(doc.provenance.model.requested, 'echo-fast', 'the = form still reaches the provider')
  assert.equal(doc.text, 'hello', 'and the flag is not part of the prompt')
})

test('--thinking means the same thing in every command that takes it', async () => {
  // `ask` validated the value; `chat` used `!== 'off'`, so --thinking=yes
  // silently turned thinking ON. Two contracts for one flag is how a run ends
  // up recorded under settings nobody chose.
  const a = await cli(['ask', 'echo', 'hi', '--thinking=yes'])
  assert.equal(a.code, 1)
  assert.match(a.out, /--thinking must be on or off/)

  const c = await cli(['chat', 'echo', '--thinking=yes', '--jsonl'])
  assert.equal(c.code, 1, 'chat must refuse exactly what ask refuses')
  assert.match(c.out, /--thinking must be on or off/)
})

test('request validates its flags like every other command', async () => {
  const r = await cli(['request', 'status', 'some-key', '--jsn'])
  assert.equal(r.code, 1)
  assert.match(r.out, /unknown option --jsn/)
})

test('paths reports where state lives, as text and as JSON', async () => {
  const text = await cli(['paths'])
  assert.equal(text.code, 0)
  assert.match(text.out, /config|profiles|downloads/i)

  const doc = json((await cli(['paths', '--json'])).stdout)
  assert.equal(typeof doc, 'object')
  assert.ok(Object.values(doc).some((v) => typeof v === 'string' && v.includes(home)), 'the paths are the ones for THIS state directory')
})

test('models lists callable ids, one per line or as a JSON array', async () => {
  const text = await cli(['models'])
  assert.equal(text.code, 0)
  assert.ok(text.stdout.split('\n').includes('echo-fast'))

  const ids = json((await cli(['models', '--json'])).stdout)
  assert.ok(Array.isArray(ids))
  assert.ok(ids.includes('echo-fast'))
})

// --- asking -----------------------------------------------------------------

test('ask prints the answer and exits 0', async () => {
  const r = await cli(['ask', 'echo', 'round trip'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /round trip/)
})

test('ask --json emits one parseable document with the audit fields', async () => {
  const r = await cli(['ask', 'echo', 'as json', '--json'])
  assert.equal(r.code, 0)
  const doc = json(r.stdout)
  assert.equal(doc.text, 'as json')
  assert.ok(doc.thread_id, 'the native thread is reported so a follow-up can name it')
  assert.equal(doc.provider, 'echo')
  // --json is a machine interface: informational logging must not be in it.
  assert.doesNotMatch(r.stdout, /\[cli\]/, 'no log lines in the document')
})

test('--model is applied and reported', async () => {
  const doc = json((await cli(['ask', 'echo', 'pick', '--model=echo-slow', '--json'])).stdout)
  assert.equal(doc.provenance.model.requested, 'echo-slow')
  assert.equal(doc.provenance.model.verified, true)
})

test('a model the UI refuses is an error, not a quietly different answer', async () => {
  const r = await cli(['ask', 'echo', 'x', '--model=echo-refuses'])
  assert.equal(r.code, 1)
  assert.match(r.out, /echo-refuses/)
  assert.doesNotMatch(r.out, /at process\.|node:internal/, 'an expected condition prints no stack trace')
})

test('--thread continues the same conversation', async () => {
  const first = json((await cli(['ask', 'echo', 'one', '--json'])).stdout)
  const second = json((await cli(['ask', 'echo', 'two', `--thread=${first.thread_id}`, '--json'])).stdout)
  assert.equal(second.thread_id, first.thread_id)
})

test('--file attaches a real file and rejects one that is not there', async () => {
  const path = join(home, 'evidence.txt')
  writeFileSync(path, 'ACCESSION=CLI-1\n')
  const ok = await cli(['ask', 'echo', 'read it', `--file=${path}`])
  assert.equal(ok.code, 0)

  const missing = await cli(['ask', 'echo', 'read it', `--file=${join(home, 'nope.txt')}`])
  assert.equal(missing.code, 1)
  assert.match(missing.out, /not found/i)
})

test('--thinking is validated at the boundary', async () => {
  const bad = await cli(['ask', 'echo', 'x', '--thinking=maybe'])
  assert.equal(bad.code, 1)
  assert.match(bad.out, /--thinking must be on or off/)

  const good = await cli(['ask', 'echo', 'x', '--thinking=on', '--json'])
  assert.equal(good.code, 0)
  assert.equal(json(good.stdout).provenance.modes.thinking.applied, true)
})

test('a provider failure exits 1 with the reason, not a stack trace', async () => {
  const r = await cli(['ask', 'echo', '@@throw=ui_contract @@status=502'])
  assert.equal(r.code, 1)
  assert.match(r.out, /simulated ui_contract/)
  assert.doesNotMatch(r.out, /node:internal|at async/, 'expected conditions are not crashes')
})

test('--json reports a failure as a document too', async () => {
  const r = await cli(['ask', 'echo', '@@throw=rate_limited @@status=429 @@retryable=true', '--json'])
  assert.equal(r.code, 1)
  const doc = json(r.stderr)
  assert.equal(doc.error.type, 'rate_limited')
  assert.equal(doc.error.retryable, true, 'a pipeline can tell "wait" from "give up"')
})

// --- durable requests -------------------------------------------------------

test('--key makes a request recoverable, and replaying it does not re-ask', async () => {
  const key = `cli-${Date.now()}`
  const first = json((await cli(['ask', 'echo', 'durable', `--key=${key}`, '--json'])).stdout)
  const replay = json((await cli(['ask', 'echo', 'durable', `--key=${key}`, '--json'])).stdout)
  assert.equal(replay.thread_id, first.thread_id, 'the same key returns the same turn')

  const recovered = json((await cli(['request', 'recover', key, '--json'])).stdout)
  assert.equal(recovered.text, first.text)

  const status = json((await cli(['request', 'status', key, '--json'])).stdout)
  assert.ok(status.state)
})

test('request commands validate their arguments', async () => {
  const r = await cli(['request', 'bogus', 'key'])
  assert.equal(r.code, 1)
  assert.match(r.out, /Usage: uibridge request/)
})

// --- threads and export -----------------------------------------------------

test('threads lists what this machine recorded', async () => {
  const made = json((await cli(['ask', 'echo', 'ledgered', '--json'])).stdout)
  const rows = json((await cli(['threads', 'echo', '--json'])).stdout)
  assert.ok(Array.isArray(rows))
  assert.ok(rows.some((r) => r.thread_id === made.thread_id), 'the thread just created is listed')
})

test('thread shows the turn ledger, and a miss is an error not an empty success', async () => {
  const made = json((await cli(['ask', 'echo', 'audited', '--json'])).stdout)
  const found = await cli(['thread', 'echo', made.thread_id])
  assert.equal(found.code, 0)
  assert.match(found.out, new RegExp(made.thread_id))

  const miss = await cli(['thread', 'echo', 'no-such-thread-id'])
  assert.equal(miss.code, 1, 'a lookup miss must not look like a hit')
  assert.match(miss.out, /No local ledger/)
})

test('export writes a file and reports where, honouring --output', async () => {
  const made = json((await cli(['ask', 'echo', 'exportable', '--json'])).stdout)
  const out = join(home, 'exported.json')
  const r = await cli(['export', 'echo', made.thread_id, `--output=${out}`])
  assert.equal(r.code, 0)
  assert.ok(existsSync(out), '--output is honoured')
  assert.match(r.stdout, /2 messages/)

  const doc = json((await cli(['export', 'echo', made.thread_id, '--json'])).stdout)
  assert.equal(doc.messages.length, 2)
  assert.equal(doc.complete, true)
})

// --- the daemon -------------------------------------------------------------

test('status reports a provider, as text and JSON', async () => {
  // Scoped to the scripted provider on purpose. Bare `status` inspects EVERY
  // configured provider, which means launching a real Chrome per real
  // provider - slow, and dependent on whether this machine happens to be
  // signed in. That is a live concern, not a CLI-contract one.
  const doc = json((await cli(['status', 'echo', '--json'])).stdout)
  assert.equal(doc.echo.state, 'in')
  assert.equal(doc.echo.authenticated, true)

  const text = await cli(['status', 'echo'])
  assert.equal(text.code, 0)
  assert.match(text.out, /echo/)
})

test('browser-touching commands go through the daemon, not their own browser', async () => {
  // THE ARCHITECTURAL INVARIANT. Only one process may drive a Chrome profile,
  // so any command needing a browser must ask the running service rather than
  // opening its own. `status` used to call Session.open() in the CLI process;
  // the leftover Chrome from one such run held the debugging port and broke
  // every later request with a 45s launch timeout.
  //
  // Proved by consequence, not by reading the source: after `status`, the
  // DAEMON is the process holding a session for that provider.
  await cli(['stop'])
  const before = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json()).catch(() => null)
  assert.equal(before, null, 'no daemon to begin with')

  const r = await cli(['status', 'echo', '--json'])
  assert.equal(r.code, 0)
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((res) => res.json())
  assert.ok(health.sessions.echo, 'the daemon is the one holding the provider session')
})

test('the daemon is the authority for what is callable', async () => {
  // A running daemon keeps serving the code it started with, so the CLI must
  // report ITS catalogue rather than the checkout's.
  await cli(['ask', 'echo', 'warm the daemon'])
  const ids = json((await cli(['models', '--json'])).stdout)
  const served = await fetch(`http://127.0.0.1:${PORT}/v1/models`).then((r) => r.json())
  assert.deepEqual(ids, served.data.map((m) => m.id), 'uibridge models is /v1/models')
})

test('the ledger commands read what the API reads', async () => {
  const made = json((await cli(['ask', 'echo', 'ledger parity', '--json'])).stdout)
  const rows = json((await cli(['threads', 'echo', '--json'])).stdout)
  const served = await fetch(`http://127.0.0.1:${PORT}/v1/threads`).then((r) => r.json())
  assert.ok(rows.some((t) => t.thread_id === made.thread_id))
  assert.ok(served.threads.some((t) => t.thread_id === made.thread_id), 'and HTTP sees the same thread')

  // A miss is a 404 on both surfaces, not an empty success on either.
  const miss = await cli(['thread', 'echo', 'no-such-thread'])
  assert.equal(miss.code, 1)
  const httpMiss = await fetch(`http://127.0.0.1:${PORT}/v1/threads/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'echo', thread_id: 'no-such-thread' }),
  })
  assert.equal(httpMiss.status, 404)
  assert.equal((await httpMiss.json()).error.type, 'thread_unknown')
})

test('the daemon is reused, and stop actually stops it', async () => {
  await cli(['ask', 'echo', 'warm'])
  const up = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())
  assert.equal(up.service, 'uibridge')
  assert.equal(up.home, home, 'it is serving THIS state directory')

  const stopped = await cli(['stop'])
  assert.equal(stopped.code, 0)
  const gone = await fetch(`http://127.0.0.1:${PORT}/health`).then(() => true).catch(() => false)
  assert.equal(gone, false, 'the port is free again')
})

test('--local answers without a daemon, and refuses what needs one', async () => {
  // --local is the one path that bypasses the daemon and drives the provider
  // in the CLI process itself. It had no test at all, so nothing caught a
  // change that made it start a daemon anyway - which is the whole point of
  // the flag, and also the one-process-per-profile rule.
  await cli(['stop'])
  const r = await cli(['ask', 'echo', 'local please', '--local', '--json'])
  assert.equal(r.code, 0)
  const doc = json(r.stdout)
  assert.equal(typeof doc.thread_id, 'string', 'it still records a native thread id')
  const started = await fetch(`http://127.0.0.1:${PORT}/health`).then(() => true).catch(() => false)
  assert.equal(started, false, 'and no daemon was started behind our back')

  // A durable key needs the daemon that owns the record, so asking for both
  // is a contradiction and must be refused rather than silently downgraded.
  const both = await cli(['ask', 'echo', 'x', '--local', '--key=k1'])
  assert.equal(both.code, 1)
  assert.match(both.out, /--key requires the daemon/)
})

test('a daemon serving a different state directory is refused, not used', async () => {
  // Otherwise a command run with a test configuration is silently answered by
  // yesterday's daemon, with yesterday's config, logins and ledger.
  const other = mkdtempSync(join(tmpdir(), 'uibridge-other-'))
  writeFileSync(join(other, 'config.json'), JSON.stringify({ port: PORT, defaultProvider: 'echo' }))
  const start = execFile(process.execPath, [BIN, 'serve'], {
    env: { ...process.env, UIBRIDGE_HOME: other, UIBRIDGE_TEST_PROVIDER: '1' }, cwd: ROOT,
  })
  try {
    for (let i = 0; i < 40; i++) {
      if (await fetch(`http://127.0.0.1:${PORT}/health`).then(() => true).catch(() => false)) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const r = await cli(['ask', 'echo', 'whose daemon is this'])
    assert.equal(r.code, 1)
    assert.match(r.out, /different state directory/)
    assert.match(r.out, /uibridge stop/, 'and says what to do about it')

    // The LEDGER commands used to skip this check entirely: they asked only
    // "is a uibridge listening", so they answered from the other home's
    // ledger, printed its file paths, and exited 0. Reading someone else's
    // history and presenting it as yours is the quiet kind of wrong.
    for (const argv of [['threads', '--json'], ['thread', 'echo', 'whatever'], ['models']]) {
      const l = await cli(argv)
      assert.equal(l.code, 1, `${argv[0]} must refuse a daemon serving another home`)
      assert.match(l.out, /different state directory/, `${argv[0]} must say why`)
    }
  } finally {
    // WAIT FOR THE PORT, not just for kill() to return. The signal is
    // asynchronous, and a later test that starts its own daemon would
    // otherwise race this one out of the port - which showed up once as an
    // unrelated chat test failing with no output at all.
    start.kill()
    for (let i = 0; i < 60; i++) {
      const held = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json()).catch(() => null)
      if (!held || held.home === home) break
      await new Promise((r) => setTimeout(r, 250))
    }
    rmSync(other, { recursive: true, force: true })
  }
})

/** Run `chat` the way a script does: prompts on stdin, one per line. */
function chatWith(args, input, { timeout = 60000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = execFile(process.execPath, [BIN, 'chat', ...args], {
      timeout,
      env: { ...process.env, UIBRIDGE_HOME: home, UIBRIDGE_TEST_PROVIDER: '1' },
      cwd: ROOT,
    }, (err, stdout, stderr) => {
      resolvePromise({ code: err?.code ?? 0, stdout, stderr, out: `${stdout}${stderr}` })
    })
    child.stdin.end(input)
  })
}

// --- chat: a conversation, not a single shot --------------------------------

test('chat keeps every turn on one thread', async () => {
  const r = await chatWith(['echo', '--jsonl'], 'one\ntwo\nthree\n')
  assert.equal(r.code, 0)
  const turns = r.stdout.trim().split('\n').map(JSON.parse)
  assert.equal(turns.length, 3, 'every line sent produced an answer')
  assert.deepEqual(turns.map((t) => t.text), ['one', 'two', 'three'])
  assert.equal(new Set(turns.map((t) => t.thread_id)).size, 1, 'on a single conversation')
})

test('a failed turn does not end the conversation', async () => {
  // The point of a chat is the accumulated context. Measured 2026-09-09: one
  // 502 mid-session aborted the loop and everything after it went unsent, so
  // a transient provider hiccup silently truncated the user's session.
  const r = await chatWith(['echo', '--jsonl'], ['before', '@@throw=ui_contract @@status=502', 'after'].join('\n') + '\n')
  const records = r.stdout.trim().split('\n').map(JSON.parse)
  assert.equal(records.length, 3, 'the turn after the failure was still sent')
  assert.equal(records[0].text, 'before')
  assert.equal(records[1].error.type, 'ui_contract', 'and the failure is reported, not swallowed')
  assert.equal(records[2].text, 'after')
  assert.equal(records[2].thread_id, records[0].thread_id, 'on the same conversation')
  assert.equal(r.code, 1, 'while the exit code still says a turn failed')
})

test('chat resumes a thread given with --thread', async () => {
  const first = await chatWith(['echo', '--jsonl'], 'start' + '\n')
  const id = JSON.parse(first.stdout.trim().split('\n')[0]).thread_id
  const again = await chatWith(['echo', '--jsonl', `--thread=${id}`], 'continue' + '\n')
  assert.equal(again.code, 0)
  assert.equal(JSON.parse(again.stdout.trim().split('\n')[0]).thread_id, id)
})

test('chat refuses a flag it does not implement instead of sending it', async () => {
  const r = await chatWith(['echo', '--tempreature=0'], 'hello' + '\n')
  assert.equal(r.code, 1)
  assert.match(r.out, /tempreature/)
})

test('slash commands steer the conversation instead of being sent as prompts', async () => {
  const r = await chatWith(['echo', '--jsonl'], ['alpha', '/thread', '/new', 'beta', '/exit', 'never sent'].join('\n') + '\n')
  assert.equal(r.code, 0)
  const records = r.stdout.trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map((t) => t.text), ['alpha', 'beta'], '/exit stopped before the last line')
  assert.notEqual(records[1].thread_id, records[0].thread_id, '/new started a fresh conversation')
  assert.match(r.stderr, /resume later/, '/thread reported the id')
})

test('--jsonl keeps stdout parseable line by line', async () => {
  // A caller pipes this into a reader. One sentence of prose on stdout - a
  // /new acknowledgement, a thread id - and that reader throws.
  const r = await chatWith(['echo', '--jsonl'], ['one', '/thread', '/help', 'two'].join('\n') + '\n')
  for (const line of r.stdout.trim().split('\n')) JSON.parse(line)
})

test('--version prints the version and nothing else', async () => {
  const r = await cli(['--version'])
  assert.equal(r.code, 0)
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/)
})
