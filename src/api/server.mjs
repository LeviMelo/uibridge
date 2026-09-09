// HTTP API. OpenAI-compatible, on Node's built-in http - no framework.
//
// Sessions are created LAZILY, one per provider, on first use. Starting the
// server therefore never opens a browser, so `uibridge serve` cannot fail
// because of a provider you are not using, and an uncalibrated provider costs
// nothing until someone asks for it.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { IdempotencyStore, readKey, snapshotRequest } from './idempotency.mjs'
import { abortable, checkCancelled, cancellationError } from '../core/cancel.mjs'
import { apiCapabilities, parseCompletionRequest, validateResult } from './request.mjs'
import { BridgeError, RequestError } from '../core/errors.mjs'
import { loadConfig } from '../core/config.mjs'
import { logger } from '../core/log.mjs'
import { Session } from '../session.mjs'
import { listThreads } from '../core/ledger.mjs'
import { PROTOCOL_VERSION, SERVICE_ID } from '../core/protocol.mjs'
import { HOME } from '../core/config.mjs'
import { resolve } from 'node:path'
import { modelCatalogue, providerIds } from '../providers/registry.mjs'
import {
  completionResponse,
  completionChunk,
  contentDelta,
  modelsResponse,
  readThreadId,
} from './openai.mjs'

const log = logger('api')

function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req, limitBytes = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limitBytes) throw new RequestError('request body too large')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError('body is not valid JSON')
  }
}

export function createApp(cfg = loadConfig(), { openSession = (id) => Session.open(id, { cfg }) } = {}) {
  const sessions = new Map()
  const opening = new Map()
  const requests = new Set()
  const store = new IdempotencyStore(resolve(HOME, cfg.requestDir ?? '.uibridge/requests'))
  let closing = null
  let stopping = false

  async function infer(parsed, signal, onProgress = null) {
    checkCancelled(signal)
    if (stopping) throw new BridgeError('The service is stopping', { status: 503, code: 'shutting_down' })
    if (requests.size >= (cfg.maxPendingRequests ?? 64)) throw new BridgeError('The local request queue is full', { status: 503, code: 'queue_full', retryable: true })
    const controller = new AbortController()
    requests.add(controller)
    const timer = setTimeout(() => controller.abort(new BridgeError('Request exceeded its total time budget', { status: 504, code: 'request_timeout' })), cfg.requestTimeoutMs ?? 900000)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      const session = await abortable(sessionFor(parsed.provider), combined)
      checkCancelled(combined)
      return validateResult(await session.ask({ ...parsed, signal: combined, onProgress }), parsed.format)
    } finally { clearTimeout(timer); requests.delete(controller) }
  }

  /** One session per provider; concurrent first-hits must not race. */
  async function sessionFor(id) {
    if (stopping) throw new BridgeError('The service is stopping', { status: 503, code: 'shutting_down' })
    let stale = null
    if (sessions.has(id)) {
      const current = sessions.get(id)
      if (current.available !== false) return current
      // Reopen only BEFORE asking. Retrying a failed in-flight inference
      // could submit the same scientific record twice.
      sessions.delete(id)
      stale = current
    }
    if (!opening.has(id)) {
      opening.set(
        id,
        Promise.resolve().then(async () => {
          if (stale) await stale.close().catch(() => {})
          return openSession(id)
        })
          .then(async (s) => {
            if (stopping) {
              await s.close().catch(() => {})
              throw new BridgeError('The service is stopping', { status: 503, code: 'shutting_down' })
            }
            sessions.set(id, s)
            opening.delete(id)
            return s
          })
          .catch((e) => {
            opening.delete(id)
            throw e
          })
      )
    }
    return opening.get(id)
  }

  const routes = {
    'GET /health': async () => ({
      service: SERVICE_ID,
      protocol: PROTOCOL_VERSION,
      status: 'ok',
      providers: providerIds,
      default: cfg.defaultProvider,
      requests: { active: requests.size, durable_active: store.active, capacity: cfg.maxPendingRequests ?? 64 },
      sessions: Object.fromEntries([...sessions].map(([id, s]) => [id, s.stats])),
    }),

    'GET /v1/models': async () => modelsResponse(modelCatalogue()),
    'GET /v1/requests/result': async (_body, { key, signal }) => {
      if (!key) throw new RequestError('Idempotency-Key header is required')
      return abortable(store.result(key), signal)
    },
    'GET /v1/requests/status': async (_body, { key }) => {
      if (!key) throw new RequestError('Idempotency-Key header is required')
      return store.status(key)
    },
    'POST /v1/requests/cancel': async (_body, { key }) => {
      if (!key) throw new RequestError('Idempotency-Key header is required')
      return store.cancel(key)
    },

    'GET /v1/capabilities': async () => {
      const out = {}
      for (const [id, s] of sessions) out[id] = s.capabilities
      return { open: out, providers: providerIds, api: apiCapabilities }
    },

    /**
     * Export one thread over HTTP.
     *
     * Addressed by body rather than by path because a thread id is the
     * provider's own uuid and this dispatcher matches whole paths; inventing
     * a parser for one route would be more moving parts than the feature.
     * `files: true` also retrieves everything the thread generated, which
     * costs a click and a download per file - so it stays opt-in here too.
     */
    'POST /v1/threads/export': async (body, { signal }) => {
      const id = body.provider ?? cfg.defaultProvider
      if (!providerIds.includes(id)) {
        throw new RequestError(`Unknown provider "${id}". Known: ${providerIds.join(', ')}`)
      }
      const threadId = readThreadId({ thread_id: body.thread_id ?? body.threadId })
      if (!threadId) throw new RequestError('thread_id is required')
      const session = await abortable(sessionFor(id), signal)
      checkCancelled(signal)
      return session.exportThread(threadId, { files: body.files === true, signal })
    },

    /**
     * Stop this instance. Bound to the loopback interface like the rest of
     * the API, and it exists because the CLI now starts a daemon on demand:
     * something has to be able to stop one, and "find the pid yourself" is
     * not an interface. Code changes do not reach a running instance.
     */
    'POST /admin/shutdown': async () => {
      stopping = true
      setTimeout(async () => {
        // A hung browser must not make the stop command ineffective forever.
        const deadline = setTimeout(() => process.exit(0), 5000)
        try { await close() } finally { clearTimeout(deadline); process.exit(0) }
      }, 50)
      return { status: 'stopping' }
    },

    'GET /v1/threads': async () => ({
      threads: await listThreads(resolve(HOME, cfg.ledgerDir), null),
    }),

    'POST /v1/chat/completions': async (body, { signal, key }) => {
      const parsed = parseCompletionRequest(body, cfg)
      const execute = async (input, workSignal) => completionResponse({ modelId: parsed.requested,
        result: await infer(input, workSignal), provider: parsed.provider })
      if (!key) return execute(parsed, signal)
      const snapshot = await snapshotRequest(parsed, body, signal)
      // Cleanup belongs to shared completion, not this HTTP subscriber: the
      // first subscriber may disconnect while its snapshot is still uploading.
      const work = store.run(key, snapshot.fingerprint, (s) => execute(snapshot.parsed, s))
        .finally(() => snapshot.cleanup().catch(() => {}))
      return abortable(work, signal)
    },
  }

  async function streamCompletion(body, res, { signal, key }) {
    const { prompt, files, modes, threadId, requested, provider, model, format, includeUsage } = parseCompletionRequest(body, cfg)

    let opened = false
    let sent = ''
    let streamId = null
    let created = Math.floor(Date.now() / 1000)
    const write = (value) => {
      if (res.destroyed) throw new BridgeError('Client disconnected', { code: 'client_disconnected' })
      if (!opened) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        opened = true
      }
      res.write(`data: ${JSON.stringify({ ...value, created, ...(includeUsage ? { usage: null } : {}) })}\n\n`)
    }
    const progress = (text) => {
      const update = contentDelta(sent, text)
      if (update.rewritten) {
        throw new BridgeError(
          'The provider rewrote text that was already emitted. The partial stream was stopped rather than returning corrupted content.',
          { status: 502, code: 'non_monotonic_stream', retryable: true }
        )
      }
      const delta = update.delta
      sent = update.next
      if (!delta) return
      if (!streamId) {
        streamId = `chatcmpl-${randomUUID()}`
        write(completionChunk({ id: streamId, modelId: requested, delta: { role: 'assistant' } }))
      }
      write(completionChunk({ id: streamId, modelId: requested, delta: { content: delta } }))
    }

    try {
      let full
      if (key) {
        // Durable streams emit only the persisted final result. Disconnecting
        // a subscriber does not cancel shared work; use /requests/cancel.
        full = await routes['POST /v1/chat/completions'](body, { signal, key })
        created = full.created
      } else {
        const result = await infer({ prompt, files, model, modes, threadId, requested, provider, format }, signal,
          format.structured ? null : progress)
        full = completionResponse({ modelId: requested, result, provider })
      }
      if (!streamId) {
        streamId = full.id
        write(completionChunk({ id: streamId, modelId: requested, delta: { role: 'assistant' } }))
      }
      if (sent !== full.choices[0].message.content) progress(full.choices[0].message.content)
      write(completionChunk({
        id: streamId,
        modelId: requested,
        finishReason: full.choices[0].finish_reason,
        bridge: full._uibridge,
      }))
      if (includeUsage) res.write(`data: ${JSON.stringify({ id: streamId, object: 'chat.completion.chunk', created,
        model: requested, choices: [], usage: full.usage })}\n\n`)
      res.end('data: [DONE]\n\n')
    } catch (err) {
      if (!opened) throw err
      if (res.destroyed) return
      const payload = err instanceof BridgeError
        ? err.toJSON()
        : { error: { message: err.message, type: 'internal' } }
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
      res.end('data: [DONE]\n\n')
    }
  }

  const server = createServer(async (req, res) => {
    const controller = new AbortController()
    const disconnected = () => { if (!res.writableEnded) controller.abort(cancellationError()) }
    res.once('close', disconnected)
    req.once('aborted', disconnected)
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/'
    const route = routes[`${req.method} ${path}`]
    if (!route) return send(res, 404, { error: { message: `No route ${req.method} ${path}`, type: 'not_found' } })

    try {
      const context = { signal: controller.signal, key: readKey(req) }
      const body = req.method === 'POST' ? await readBody(req) : {}
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new RequestError('body must be a JSON object')
      }
      if (`${req.method} ${path}` === 'POST /v1/chat/completions' && body.stream === true) {
        await streamCompletion(body, res, context)
        return
      }
      send(res, 200, await route(body, context))
    } catch (err) {
      // Typed errors carry their own status, so a caller can tell "log in"
      // from "retry" from "your path is wrong" - the prototype answered 502
      // for all three.
      if (err instanceof BridgeError) {
        log.warn(`${err.code}: ${err.message}`)
        return send(res, err.status, err.toJSON())
      }
      const message = String(err.message ?? err).split('\n')[0].slice(0, 500)
      log.error(message)
      send(res, 500, { error: { message, type: 'internal' } })
    } finally {
      res.removeListener('close', disconnected)
      req.removeListener('aborted', disconnected)
    }
  })

  function close() {
    if (closing) return closing
    stopping = true
    closing = (async () => {
      const stopped = new Promise((r) => server.close(r))
      for (const controller of requests) controller.abort(new BridgeError('The service is stopping', { status: 503, code: 'shutting_down' }))
      await store.close()
      await Promise.allSettled([...sessions.values()].map((s) => s.close()))
      await Promise.allSettled([...opening.values()])
      sessions.clear()
      await stopped
    })()
    return closing
  }

  return { server, close, cfg }
}

/** Start listening. Returns { close }. */
export async function serve(cfg = loadConfig()) {
  const app = createApp(cfg)
  await new Promise((resolve, reject) => {
    app.server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        reject(
          new BridgeError(
            `Port ${cfg.port} is already in use - uibridge may already be running.\n` +
              `  check : curl http://${cfg.host}:${cfg.port}/health\n` +
              `  or    : change "port" in config.json`,
            { code: 'port_in_use' }
          )
        )
      } else reject(e)
    })
    app.server.listen(cfg.port, cfg.host, resolve)
  })

  console.log(`
uibridge listening on http://${cfg.host}:${cfg.port}

  base_url  : http://${cfg.host}:${cfg.port}/v1
  models    : ${modelCatalogue().map((m) => m.id).join(', ')}
  health    : http://${cfg.host}:${cfg.port}/health

A browser opens on the first request, not now. Sign in once per provider:
  uibridge login gemini
`)
  return app
}
