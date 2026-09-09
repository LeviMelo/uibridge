// Persist a claim BEFORE inference. Never automatically rerun an uncertain turn.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeError, RequestError } from '../core/errors.mjs'
import { checkCancelled, cancellationError } from '../core/cancel.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
  return value
}
export function readKey(req) {
  const key = req.headers['idempotency-key']
  if (key === undefined) return null
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) throw new RequestError('Idempotency-Key must contain 1–200 printable ASCII characters without spaces')
  return key
}
export async function requestFingerprint(parsed, body, signal, contentPaths = parsed.files) {
  const files = []
  for (const [index, path] of parsed.files.entries()) {
    checkCancelled(signal)
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(contentPaths[index], { signal })) digest.update(chunk)
    files.push({ path, sha256: digest.digest('hex') })
  }
  return hash(JSON.stringify(canonical({ prompt: parsed.prompt, files, model: parsed.requested,
    provider: parsed.provider, modes: parsed.modes, thread: parsed.threadId, format: body.response_format ?? null })))
}

/** Freeze uploaded bytes before queuing: editing a source file cannot change
 * the inference under an already claimed fingerprint. No prompt is persisted. */
export async function snapshotRequest(parsed, body, signal) {
  if (!parsed.files.length) return { parsed, fingerprint: await requestFingerprint(parsed, body, signal), cleanup: async () => {} }
  const dir = await mkdtemp(join(tmpdir(), 'uibridge-attachments-'))
  const cleanup = () => rm(dir, { recursive: true, force: true })
  try {
    const paths = []
    for (const [index, path] of parsed.files.entries()) {
      checkCancelled(signal)
      const folder = join(dir, String(index))
      await mkdir(folder)
      const copy = join(folder, basename(path))
      await copyFile(path, copy)
      paths.push(copy)
    }
    const fingerprint = await requestFingerprint(parsed, body, signal, paths)
    checkCancelled(signal)
    return { parsed: { ...parsed, files: paths }, fingerprint, cleanup }
  } catch (err) { await cleanup(); throw err }
}
function outcomeError(err) {
  return { status: err instanceof BridgeError ? err.status : 500,
    body: err instanceof BridgeError ? err.toJSON() : { error: {
      message: String(err.message ?? err).split('\n')[0].slice(0, 500), type: 'internal', retryable: false,
    } } }
}
function unwrap(record) {
  if (record.state === 'completed') return record.response
  if (record.failure) {
    const { error } = record.failure.body
    throw new BridgeError(error.message, { status: record.failure.status, code: error.type, detail: error.detail, retryable: false })
  }
  throw new BridgeError('This key has an unfinished durable record. Its provider outcome is unknown; inspect the conversation before deliberately using a new key.', {
    status: 409, code: 'outcome_unknown', retryable: false,
  })
}

export class IdempotencyStore {
  #dir
  #running = new Map()
  constructor(dir) { this.#dir = dir }
  get active() { return this.#running.size }
  #path(key) { return join(this.#dir, `${hash(key)}.json`) }

  async #read(key) {
    try { return JSON.parse(await readFile(this.#path(key), 'utf8')) } catch (err) {
      if (err.code === 'ENOENT') return null
      throw new BridgeError('Cannot read durable request record; refusing to resubmit', { status: 503, code: 'request_store_unavailable' })
    }
  }

  run(key, fingerprint, execute) {
    const existing = this.#running.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new BridgeError('Idempotency-Key was used with a different request', { status: 409, code: 'idempotency_conflict' }))
      return existing.promise
    }
    const controller = new AbortController()
    const entry = { fingerprint, controller }
    // Install ownership synchronously, before any file operation yields.
    entry.promise = Promise.resolve().then(async () => {
      await mkdir(this.#dir, { recursive: true })
      const prior = await this.#read(key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new BridgeError('Idempotency-Key was used with a different request', { status: 409, code: 'idempotency_conflict' })
        return unwrap(prior)
      }
      const path = this.#path(key)
      const record = { version: 1, fingerprint, state: 'running', created_at: new Date().toISOString() }
      entry.record = record
      let file
      try { file = await open(path, 'wx', 0o600) } catch (err) {
        if (err.code === 'EEXIST') {
          const claimed = await this.#read(key)
          if (claimed?.fingerprint !== fingerprint) throw new BridgeError('Idempotency-Key was claimed by another request', { status: 409, code: 'idempotency_conflict' })
          return unwrap(claimed)
        }
        throw new BridgeError('Cannot claim durable request; no inference was started', { status: 503, code: 'request_store_unavailable' })
      }
      try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
      try {
        checkCancelled(controller.signal)
        record.response = await execute(controller.signal)
        record.state = 'completed'
      } catch (err) {
        record.state = controller.signal.aborted ? 'cancelled' : 'failed'
        record.failure = outcomeError(err)
      }
      record.finished_at = new Date().toISOString()
      const temp = `${path}.${randomUUID()}.tmp`
      try {
        const output = await open(temp, 'wx', 0o600)
        try { await output.writeFile(JSON.stringify(record)); await output.sync() } finally { await output.close() }
        await rename(temp, path)
      } catch {
        throw new BridgeError('Inference finished but its result could not be saved. The key remains uncertain; do not automatically resubmit.', { status: 503, code: 'request_store_unavailable' })
      } finally { await rm(temp, { force: true }).catch(() => {}) }
      return unwrap(record)
    }).finally(() => this.#running.delete(key))
    this.#running.set(key, entry)
    return entry.promise
  }

  async status(key) {
    const active = this.#running.get(key)
    // Reading the destination while it is atomically replaced can contend
    // with rename on Windows. Active work already owns its metadata in memory.
    const record = active ? active.record : await this.#read(key)
    if (!record && !active) throw new BridgeError('No record for this key', { status: 404, code: 'request_not_found' })
    return { state: active ? (active.controller.signal.aborted ? 'cancelling' : 'running') : record.state === 'running' ? 'outcome_unknown' : record.state,
      created_at: record?.created_at, finished_at: record?.finished_at,
      response_id: record?.response?.id, error: record?.failure?.body?.error }
  }

  async cancel(key) {
    this.#running.get(key)?.controller.abort(cancellationError())
    return this.status(key)
  }
  async result(key) {
    const active = this.#running.get(key)
    if (active) return active.promise
    const record = await this.#read(key)
    if (!record) throw new BridgeError('No record for this key', { status: 404, code: 'request_not_found' })
    return unwrap(record)
  }
  async close() {
    for (const { controller } of this.#running.values()) controller.abort(cancellationError())
    await Promise.allSettled([...this.#running.values()].map((e) => e.promise))
  }
}
