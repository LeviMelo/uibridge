// OpenAI-compatible local endpoint backed by real chat UI sessions.
//
//   npm run serve
//
// Then from Python:
//     from openai import OpenAI
//     c = OpenAI(base_url="http://127.0.0.1:8477/v1", api_key="unused")
//     c.chat.completions.create(model="gemini", messages=[...])
//
// Requests run CONCURRENTLY across a pool of tabs (config: services.*.concurrency).
// Each tab is an independent conversation, so a 60-call burst runs
// concurrency-at-a-time rather than single file. Overflow queues; nothing drops.

import { createServer } from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { loadConfig, openContext, killSpawned } from './browser.mjs'
import { TabPool } from './pool.mjs'
import { ask, extractJSON } from './driver.mjs'

const cfg = loadConfig()
const pools = new Map()   // service -> { ctx, pool }
const opening = new Map() // service -> in-flight open promise (avoid double launch)

const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)

async function poolFor(service) {
  if (pools.has(service)) return pools.get(service)
  if (opening.has(service)) return opening.get(service)

  const task = (async () => {
    const svc = cfg.services[service]
    log(`launching browser for ${service} (up to ${svc.concurrency ?? 1} tabs)`)
    const ctx = await openContext(cfg, service)
    const pool = new TabPool(ctx, svc.url, svc.concurrency ?? 1)
    const entry = { ctx, pool, svc }
    pools.set(service, entry)
    opening.delete(service)
    return entry
  })()

  opening.set(service, task)
  return task
}

/** Which service owns this model id? Returns {service, modelKey} or null. */
function resolveModel(id) {
  if (!id) return null
  for (const [service, svc] of Object.entries(cfg.services)) {
    if (svc.models && svc.models[id]) return { service, modelKey: id }
  }
  if (cfg.services[id]) return { service: id, modelKey: null } // bare service name
  return null
}

/** Every model id across all services, for /v1/models. */
function allModels() {
  const out = []
  for (const [service, svc] of Object.entries(cfg.services)) {
    for (const id of Object.keys(svc.models ?? {})) out.push({ id, service })
    out.push({ id: service, service }) // bare service = account default model
  }
  return out
}

/** Flatten OpenAI-style messages into a single prompt. */
function flatten(messages) {
  const parts = []
  for (const m of messages ?? []) {
    const content =
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map((c) => c.text ?? '').join('\n')
    if (!content.trim()) continue
    if (m.role === 'system') parts.push(`[System instructions]\n${content}`)
    else if (m.role === 'assistant') parts.push(`[Previous assistant reply]\n${content}`)
    else parts.push(content)
  }
  return parts.join('\n\n')
}

function send(res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 200 * 1024 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/health') {
    const stats = {}
    for (const [name, { pool }] of pools) {
      stats[name] = { tabs: pool.created, busy: pool.busy, waiting: pool.waiters.length }
    }
    return send(res, 200, { status: 'ok', services: Object.keys(cfg.services), pools: stats })
  }

  if (url.pathname === '/v1/models') {
    return send(res, 200, {
      object: 'list',
      data: allModels().map(({ id, service }) => ({
        id,
        object: 'model',
        owned_by: `uibridge/${service}`,
      })),
    })
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return send(res, 400, { error: { message: 'invalid JSON body' } })
    }

    const resolved = resolveModel(body.model)
    const service = resolved ? resolved.service : cfg.defaultService
    const modelKey = resolved ? resolved.modelKey : null
    const prompt = flatten(body.messages)
    if (!prompt.trim()) {
      return send(res, 400, { error: { message: 'no usable content in messages' } })
    }
    const files = Array.isArray(body.attachments) ? body.attachments : []
    // Validate up front. A bad path would otherwise sail through the drag
    // dispatch and then hang for the full upload timeout waiting for a chip
    // that can never appear.
    const missing = files.filter((f) => typeof f !== 'string' || !existsSync(f))
    if (missing.length) {
      return send(res, 400, {
        error: { message: `attachment(s) not found: ${missing.join(', ')}`, type: 'bad_attachment' },
      })
    }
    const dirs = files.filter((f) => statSync(f).isDirectory())
    if (dirs.length) {
      return send(res, 400, {
        error: { message: `attachment(s) are directories: ${dirs.join(', ')}`, type: 'bad_attachment' },
      })
    }

    const started = Date.now()
    try {
      const { pool, svc } = await poolFor(service)
      log(
        `-> ${service}  ${prompt.length} chars${files.length ? `, ${files.length} file(s)` : ''}` +
          `  [${pool.busy}/${pool.size} busy${pool.waiters.length ? `, ${pool.waiters.length} waiting` : ''}]`
      )

      const modes = { ...(svc.models?.[modelKey]?.modes ?? {}), ...(body.modes ?? {}) }
      const result = await pool.withTab((page) =>
        ask(page, svc, { prompt, files, model: modelKey, modes }, (m) =>
          log(`   ${service}: ${m}`)
        )
      )
      const text = result.text

      log(`<- ${service}  ${text.length} chars in ${((Date.now() - started) / 1000).toFixed(1)}s`)

      return send(res, 200, {
        id: `uibridge-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? service,
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        // Token counts are not observable through a UI; present but zero so
        // client libraries that read usage do not crash.
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        // Real provenance: which model the UI was actually on, plus the modes
        // applied. Requested != applied when a picker label does not match.
        _uibridge: {
          json: extractJSON(text),
          elapsed_ms: Date.now() - started,
          model_applied: result.model,
          modes_applied: result.modes,
          browsed: result.browsed ?? false,
          sources: result.sources ?? [],
          modes_requested: modes,
          // Was the text the UI's own markdown (Copy button) or the innerText
          // fallback? Tables and LaTeX are only faithful in the former.
          markdown: result.markdown ?? false,
          // Structured views of that markdown, so a caller does not re-parse.
          tables: result.tables ?? [],
          code_blocks: result.code_blocks ?? [],
          // Files GEMINI generated, already saved to disk. Text payloads
          // under fileInlineMaxBytes also come back inline.
          files: result.files ?? [],
        },
      })
    } catch (err) {
      log(`!! ${service}: ${err.message}`)
      return send(res, 502, { error: { message: err.message, type: 'uibridge_error' } })
    }
  }

  send(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`
Port ${cfg.port} is already in use - uibridge is probably already running.

  Check   : curl http://127.0.0.1:${cfg.port}/health
  Stop it : close the other terminal, or change "port" in config.json
`)
    process.exit(1)
  }
  throw err
})

server.listen(cfg.port, '127.0.0.1', () => {
  const conc = Object.entries(cfg.services)
    .map(([n, s]) => `${n}=${s.concurrency ?? 1}`)
    .join(', ')
  console.log(`
uibridge listening on http://127.0.0.1:${cfg.port}

  base_url    : http://127.0.0.1:${cfg.port}/v1
  models      : ${Object.keys(cfg.services).join(', ')}
  concurrency : ${conc}

Tabs open lazily. First request per service launches the browser; leave it open.
If a service reports "signed out", run:  node login.mjs <service>
`)
})

let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) process.exit(0)
    shuttingDown = true
    console.log('\nclosing browsers...')
    for (const { pool } of pools.values()) await pool.close().catch(() => {})
    // Only kills Chrome instances this process started - your own browser is
    // never touched.
    killSpawned()
    process.exit(0)
  })
}
