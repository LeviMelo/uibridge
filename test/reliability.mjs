import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createApp } from '../src/api/server.mjs'
import { IdempotencyStore, requestFingerprint } from '../src/api/idempotency.mjs'
import { TabPool } from '../src/core/pool.mjs'
import { Mutex, Pacer, sleep, waitFor } from '../src/core/async.mjs'
import { withCancellation } from '../src/core/cancel.mjs'
import { BridgeError } from '../src/core/errors.mjs'
import { WireTap } from '../src/transports/wire.mjs'

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const request = { model: 'gemini', messages: [{ role: 'user', content: 'Evidence α' }] }
const result = (text = 'answer') => ({ text, thread_id: 't', request_id: 'r', files: [], sources: [], provenance: {} })
const tick = () => new Promise((r) => setImmediate(r))
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'uibridge-reliability-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir }
async function http(t, ask, cfg = {}) {
  const dir = cfg.requestDir ?? await directory(t)
  // `home` is what this server tells clients it serves. A CLI child launched
  // below runs with UIBRIDGE_HOME=dir, and a mismatch is (correctly) refused.
  const app = createApp({ defaultProvider: 'gemini', requestDir: dir, home: dir, ...cfg }, { openSession: async () => ({ ask, close: async () => {} }) })
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r))
  t.after(() => app.close())
  const url = `http://127.0.0.1:${app.server.address().port}`
  const post = (body = request, key, signal) => fetch(`${url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body), signal,
    headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } })
  return { app, post, url, dir }
}

test('aborted pacing and mutex waiters never run later or consume a pacing slot', async () => {
  const held = deferred()
  const lock = new Mutex()
  const first = lock.run(() => held.promise)
  const controller = new AbortController()
  let invoked = false
  const second = lock.run(() => { invoked = true }, controller.signal)
  controller.abort()
  await assert.rejects(second, { code: 'request_cancelled' })
  held.resolve(); await first; await tick()
  assert.equal(invoked, false)
  const pacer = new Pacer(10000)
  await pacer.wait()
  const cancelled = new AbortController()
  const paced = pacer.wait(cancelled.signal)
  cancelled.abort()
  await assert.rejects(paced, { code: 'request_cancelled' })
})

test('cancellation interrupts polling even when the probe swallows closed-page errors', async () => {
  const controller = new AbortController()
  const began = deferred()
  const work = withCancellation(controller.signal, () => waitFor(() => { began.resolve(); throw new Error('closed') }, { timeout: 60000, poll: 5000 }))
  await began.promise; controller.abort()
  await assert.rejects(work, { code: 'request_cancelled' })
})

test('wire capture cancellation interrupts an otherwise silent ten-minute response', async () => {
  const tap = await WireTap.fromClient({ send: async () => ({}), on() {} })
  const cap = tap.expect(/answer/)
  const controller = new AbortController()
  const waiting = withCancellation(controller.signal, () => cap.finished(600000))
  controller.abort()
  await assert.rejects(waiting, { code: 'request_cancelled' })
  cap.stop()
})

test('cancelled queued and opening tabs release capacity without delivering ownership', async () => {
  const opening = deferred()
  let closed = false
  const p = { isClosed: () => closed, close: async () => { closed = true } }
  const pool = new TabPool({ newPage: () => opening.promise }, { max: 1 })
  const a = new AbortController(), b = new AbortController()
  const first = pool.acquire(a.signal), second = pool.acquire(b.signal)
  a.abort(); b.abort()
  await Promise.all([assert.rejects(first, { code: 'request_cancelled' }), assert.rejects(second, { code: 'request_cancelled' })])
  assert.equal(pool.stats.waiting, 0)
  opening.resolve(p)
  await tick()
  assert.equal(closed, true)
  assert.equal(pool.stats.busy, 0)
  await pool.close()
})

test('cancelling an active tab closes only that tab and the pool can serve again', async () => {
  let opened = 0
  const pool = new TabPool({ newPage: async () => { opened++; let closed = false; return { isClosed: () => closed, close: async () => { closed = true } } } }, { max: 1 })
  const controller = new AbortController(), began = deferred(), finished = deferred()
  let page
  const work = pool.withTab(async (p) => { page = p; began.resolve(); await finished.promise }, { signal: controller.signal })
  await began.promise; controller.abort()
  await assert.rejects(work, { code: 'request_cancelled' })
  assert.equal(page.isClosed(), true)
  await pool.withTab(async (p) => assert.notEqual(p, page))
  assert.equal(opened, 2)
  finished.resolve(); await pool.close()
})

test('plain HTTP disconnect propagates cancellation to inference', async (t) => {
  const started = deferred(), aborted = deferred()
  const { post } = await http(t, async ({ signal }) => {
    started.resolve()
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    await sleep(60000, signal)
  })
  const controller = new AbortController()
  const response = post(request, null, controller.signal)
  await started.promise; controller.abort()
  await assert.rejects(response)
  await aborted.promise
})

test('SSE reader cancellation aborts the unfinished inference', async (t) => {
  const aborted = deferred()
  const { post } = await http(t, async ({ signal, onProgress }) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    onProgress('partial')
    await sleep(60000, signal)
  })
  const response = await post({ ...request, stream: true })
  const reader = response.body.getReader()
  await reader.read(); await reader.cancel()
  await aborted.promise
})

test('durable duplicates share one execution, survive disconnect and replay after restart', async (t) => {
  const started = deferred(), finish = deferred()
  let calls = 0
  const { post, app, dir } = await http(t, async ({ signal }) => {
    calls++; started.resolve(); await finish.promise
    assert.equal(signal.aborted, false)
    return result('same answer')
  })
  const controller = new AbortController()
  const first = post(request, 'same-key', controller.signal)
  await started.promise
  const second = post(request, 'same-key')
  controller.abort(); await assert.rejects(first)
  finish.resolve()
  const answer = await (await second).json()
  assert.equal(calls, 1)
  assert.deepEqual(await (await post(request, 'same-key')).json(), answer)
  assert.equal((await post({ ...request, messages: [{ role: 'user', content: 'different' }] }, 'same-key')).status, 409)
  await app.close()
  const restarted = await http(t, async () => { throw new Error('must replay') }, { requestDir: dir })
  assert.deepEqual(await (await restarted.post(request, 'same-key')).json(), answer)
  const recovered = await fetch(`${restarted.url}/v1/requests/result`, { headers: { 'Idempotency-Key': 'same-key' } })
  assert.deepEqual(await recovered.json(), answer)
  const sse = await (await restarted.post({ ...request, stream: true }, 'same-key')).text()
  assert.ok(sse.includes(answer.id)); assert.match(sse, /same answer/)
  assert.equal(JSON.parse(sse.split('\n\n')[0].slice(6)).created, answer.created)
})

test('explicit durable cancellation is terminal and cannot silently resubmit', async (t) => {
  const started = deferred()
  let calls = 0
  const { post, url } = await http(t, async ({ signal }) => { calls++; started.resolve(); await sleep(60000, signal) })
  const response = post(request, 'cancel-me')
  await started.promise
  const cancel = await fetch(`${url}/v1/requests/cancel`, { method: 'POST', headers: { 'Idempotency-Key': 'cancel-me' } })
  assert.equal(cancel.status, 200)
  assert.equal((await response).status, 499)
  assert.equal((await post(request, 'cancel-me')).status, 499)
  const state = await (await fetch(`${url}/v1/requests/status`, { headers: { 'Idempotency-Key': 'cancel-me' } })).json()
  assert.equal(state.state, 'cancelled'); assert.equal(calls, 1)
})

test('durable failed validation replays the failure without another model turn', async (t) => {
  let calls = 0
  const { post } = await http(t, async () => { calls++; return result('invalid JSON') })
  const body = { ...request, response_format: { type: 'json_object' } }
  assert.equal((await post(body, 'bad-output')).status, 502)
  assert.equal((await post(body, 'bad-output')).status, 502)
  assert.equal(calls, 1)
})

test('a killed worker leaves an uncertain claim that a fresh process will not rerun', async (t) => {
  const dir = await directory(t)
  const module = new URL('../src/api/idempotency.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { IdempotencyStore } from ${JSON.stringify(module)};
    await new IdempotencyStore(${JSON.stringify(dir)}).run('crashed', 'fp', async () => {
      console.log('claimed'); await new Promise(() => {});
    });`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  t.after(() => { if (child.exitCode === null) child.kill() })
  await once(child.stdout, 'data')
  child.kill(); await exited
  let invoked = false
  const store = new IdempotencyStore(dir)
  await assert.rejects(store.run('crashed', 'fp', () => { invoked = true }), { code: 'outcome_unknown' })
  assert.equal(invoked, false)
  assert.equal((await store.status('crashed')).state, 'outcome_unknown')
})

test('attachment contents participate in the request identity', async (t) => {
  const dir = await directory(t), path = join(dir, 'input.txt')
  const parsed = { files: [path], prompt: 'read', requested: 'gemini', provider: 'gemini', modes: {} }
  await writeFile(path, 'first')
  const first = await requestFingerprint(parsed, {})
  await writeFile(path, 'second')
  assert.notEqual(await requestFingerprint(parsed, {}), first)
})

test('a durable attachment is frozen while queued and changed source bytes conflict', async (t) => {
  const dir = await directory(t), path = join(dir, 'evidence.txt')
  await writeFile(path, 'original evidence')
  const started = deferred(), finish = deferred()
  let snapshot
  const { post } = await http(t, async ({ files }) => {
    snapshot = files[0]; started.resolve(); await finish.promise
    return result(await readFile(snapshot, 'utf8'))
  })
  const body = { ...request, attachments: [path] }
  const first = post(body, 'file-snapshot')
  await started.promise
  assert.notEqual(snapshot, path)
  await writeFile(path, 'modified source')
  finish.resolve()
  assert.equal((await (await first).json()).choices[0].message.content, 'original evidence')
  await assert.rejects(readFile(snapshot), { code: 'ENOENT' })
  assert.equal((await post(body, 'file-snapshot')).status, 409)
})

test('corrupted request records fail closed rather than duplicating inference', async (t) => {
  const dir = await directory(t)
  const store = new IdempotencyStore(dir)
  await store.run('corrupt', 'fp', async () => ({ id: 'saved' }))
  const { readdir } = await import('node:fs/promises')
  const file = (await readdir(dir))[0]
  await writeFile(join(dir, file), '{broken')
  let ran = false
  await assert.rejects(store.run('corrupt', 'fp', async () => { ran = true }), { code: 'request_store_unavailable' })
  assert.equal(ran, false)
})

test('bounded queue and total timeout recover capacity', async (t) => {
  const started = deferred()
  const { post } = await http(t, async ({ signal }) => { started.resolve(); await sleep(60000, signal) }, { maxPendingRequests: 1, requestTimeoutMs: 100 })
  const first = post()
  await started.promise
  assert.equal((await post()).status, 503)
  assert.equal((await first).status, 504)
  assert.equal((await post()).status, 504)
})

test('200 HTTP requests with injected provider failures preserve identity and recover', async (t) => {
  let calls = 0
  const { post, url } = await http(t, async ({ prompt }) => {
    calls++
    const index = Number(prompt.split(':')[1])
    await tick()
    if (index % 7 === 0) throw new BridgeError('injected failure', { status: 502, code: 'injected' })
    return result(prompt)
  })
  for (let offset = 0; offset < 200; offset += 10) {
    await Promise.all(Array.from({ length: 10 }, async (_, j) => {
      const index = offset + j, prompt = `record:${index}`
      const res = await post({ ...request, messages: [{ role: 'user', content: prompt }] })
      assert.equal(res.status, index % 7 === 0 ? 502 : 200)
      if (res.status === 200) assert.equal((await res.json()).choices[0].message.content, prompt)
    }))
  }
  assert.equal(calls, 200)
  assert.equal((await (await fetch(`${url}/health`)).json()).requests.active, 0)
})

test('the Python batch client checkpoints and resumes without duplicate inference', async (t) => {
  try {
    const probe = spawn('python', ['--version'], { windowsHide: true, stdio: 'ignore' })
    await once(probe, 'exit')
  } catch (err) {
    if (err.code === 'ENOENT') { t.skip('Optional Python batch example requires Python'); return }
    throw err
  }
  let calls = 0
  const { url, dir } = await http(t, async () => { calls++; return result('saved') })
  const input = join(dir, 'batch.jsonl'), output = join(dir, 'results.jsonl')
  await writeFile(input, [{ id: 'one', body: request }, { id: 'two', body: request }].map(JSON.stringify).join('\n'))
  const run = async () => {
    const child = spawn('python', ['examples/durable_batch.py', input, output, '--run', 'test-v1', '--base-url', `${url}/v1`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, stderr)
  }
  await run()
  const original = await readFile(output, 'utf8')
  await run()
  assert.equal(await readFile(output, 'utf8'), original)
  assert.equal(calls, 2)
})

test('CLI reports its key before completion and recovers after being terminated', async (t) => {
  const began = deferred(), finish = deferred()
  let calls = 0
  const { app, dir } = await http(t, async ({ signal }) => {
    calls++; began.resolve(); await finish.promise
    assert.equal(signal.aborted, false)
    return result('durable CLI answer')
  })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: app.server.address().port }))
  const launch = (args) => {
    const child = spawn(process.execPath, ['bin/uibridge.mjs', ...args], { windowsHide: true,
      env: { ...process.env, UIBRIDGE_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    const done = once(child, 'exit').then(([code]) => ({ code, stdout, stderr }))
    return { child, done, stderr: () => stderr }
  }
  const asking = launch(['ask', 'gemini', '--key=cli-recovery', '--json', 'test prompt'])
  await began.promise
  assert.match(asking.stderr(), /Request key: cli-recovery/)
  asking.child.kill(); await asking.done
  finish.resolve()
  const recovered = await launch(['request', 'recover', 'cli-recovery', '--json']).done
  assert.equal(recovered.code, 0, recovered.stderr)
  assert.equal(JSON.parse(recovered.stdout).text, 'durable CLI answer')
  const status = await launch(['request', 'status', 'cli-recovery', '--json']).done
  assert.equal(JSON.parse(status.stdout).state, 'completed')
  assert.equal(calls, 1)
})
