// Durable, local audit trail for provider-native threads.
// It records file identities and result metadata, never prompts, answers,
// cookies, headers, or browser storage.

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { appendFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const queues = new Map()
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_')

export function auditProvenance(provenance) {
  if (!provenance) return null
  const setting = (value) => value && Object.fromEntries(['requested', 'applied', 'verified', 'note', 'expected_slug', 'expected_effort']
    .filter((key) => value[key] !== undefined).map((key) => [key, value[key]]))
  return { model: setting(provenance.model), modes: Object.fromEntries(Object.entries(provenance.modes ?? {}).map(([key, value]) => [key, setting(value)])),
    ...Object.fromEntries(['final_state', 'answered_by', 'sent_as', 'sent_effort', 'history']
      .filter((key) => provenance[key] !== undefined).map((key) => [key, provenance[key]])) }
}

export async function fileIdentity(path) {
  const info = await stat(path)
  const hash = createHash('sha256')
  await new Promise((ok, fail) => createReadStream(path).on('data', (b) => hash.update(b)).on('end', ok).on('error', fail))
  return { path: resolve(path), bytes: info.size, sha256: hash.digest('hex') }
}

export function ledgerPath(root, provider, threadId) {
  return join(resolve(root), safe(provider), `${safe(threadId)}.jsonl`)
}

export async function recordThreadEvent(root, event) {
  const path = ledgerPath(root, event.provider, event.thread_id)
  mkdirSync(dirname(path), { recursive: true })
  const inputs = await Promise.all(event.inputs.map(fileIdentity))
  const outputs = await Promise.all(event.outputs.map(async (f) => {
    const metadata = Object.fromEntries(['name', 'path', 'bytes', 'mime', 'type', 'source', 'error', 'failure']
      .filter((key) => f[key] !== undefined).map((key) => [key, f[key]]))
    if (f.error || !f.path || !existsSync(f.path)) return metadata
    return { ...metadata, ...(await fileIdentity(f.path)) }
  }))
  const row = { ...event, provenance: auditProvenance(event.provenance), inputs, outputs }
  const previous = queues.get(path) ?? Promise.resolve()
  const pending = previous.then(() => appendFile(path, `${JSON.stringify(row)}\n`, 'utf8'))
  const tail = pending.catch(() => {}).finally(() => {
    if (queues.get(path) === tail) queues.delete(path)
  })
  queues.set(path, tail)
  await pending
  return { path, event: row }
}

export function readThreadEvents(root, provider, threadId) {
  const path = ledgerPath(root, provider, threadId)
  if (!existsSync(path)) return { path, events: [] }
  // ONE BAD LINE MUST NOT COST THE WHOLE LEDGER.
  // This is an append-only audit trail, so the realistic damage is a
  // truncated final line from a process that died mid-write - and a single
  // JSON.parse over the whole file turned that into a thrown error for
  // `threads`, `thread` and every listing, hiding every OTHER thread with it.
  // Bad lines are COUNTED rather than swallowed: quietly returning fewer
  // events than the file holds would be its own kind of lie.
  const events = []
  let skipped = 0
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      skipped++
    }
  }
  return { path, events, ...(skipped ? { skipped } : {}) }
}

export async function listThreads(root, provider = null) {
  const base = resolve(root)
  if (!existsSync(base)) return []
  const providers = provider ? [provider] : (await readdir(base, { withFileTypes: true })).filter((x) => x.isDirectory()).map((x) => x.name)
  const out = []
  for (const id of providers) {
    const dir = join(base, safe(id))
    if (!existsSync(dir)) continue
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      const thread_id = file.name.slice(0, -6)
      const { events, skipped } = readThreadEvents(base, id, thread_id)
      const last = events.at(-1)
      out.push({ provider: id, thread_id, turns: events.length, updated_at: last?.at ?? null,
        path: join(dir, file.name), ...(skipped ? { skipped } : {}) })
    }
  }
  return out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
}
