// HTTP API. OpenAI-compatible, on Node's built-in http - no framework.
//
// Sessions are created LAZILY, one per provider, on first use. Starting the
// server therefore never opens a browser, so `uibridge serve` cannot fail
// because of a provider you are not using, and an uncalibrated provider costs
// nothing until someone asks for it.

import { createServer } from 'node:http'
import { BridgeError, RequestError } from '../core/errors.mjs'
import { loadConfig } from '../core/config.mjs'
import { logger } from '../core/log.mjs'
import { Session } from '../session.mjs'
import { listThreads } from '../core/ledger.mjs'
import { PROTOCOL_VERSION, SERVICE_ID } from '../core/protocol.mjs'
import { HOME } from '../core/config.mjs'
import { resolve } from 'node:path'
import { modelCatalogue, providerIds, resolveModel } from '../providers/registry.mjs'
import {
  completionResponse,
  completionChunk,
  contentDelta,
  flattenMessages,
  modelsResponse,
  readAttachments,
  readModes,
  readThreadId,
} from './openai.mjs'

const log = logger('api')

function send(res, status, body) {
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

export function createApp(cfg = loadConfig()) {
  const sessions = new Map()
  const opening = new Map()

  /** One session per provider; concurrent first-hits must not race. */
  async function sessionFor(id) {
    if (sessions.has(id)) return sessions.get(id)
    if (!opening.has(id)) {
      opening.set(
        id,
        Session.open(id, { cfg })
          .then((s) => {
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
      sessions: Object.fromEntries([...sessions].map(([id, s]) => [id, s.stats])),
    }),

    'GET /v1/models': async () => modelsResponse(modelCatalogue()),

    'GET /v1/capabilities': async () => {
      const out = {}
      for (const [id, s] of sessions) out[id] = s.capabilities
      return { open: out, providers: providerIds }
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
    'POST /v1/threads/export': async (body) => {
      const id = body.provider ?? cfg.defaultProvider
      if (!providerIds.includes(id)) {
        throw new RequestError(`Unknown provider "${id}". Known: ${providerIds.join(', ')}`)
      }
      const threadId = body.thread_id ?? body.threadId
      if (!threadId) throw new RequestError('thread_id is required')
      const session = await sessionFor(id)
      return session.exportThread(threadId, { files: body.files === true })
    },

    /**
     * Stop this instance. Bound to the loopback interface like the rest of
     * the API, and it exists because the CLI now starts a daemon on demand:
     * something has to be able to stop one, and "find the pid yourself" is
     * not an interface. Code changes do not reach a running instance.
     */
    'POST /admin/shutdown': async () => {
      setTimeout(async () => {
        for (const [, s] of sessions) await s.close().catch(() => {})
        process.exit(0)
      }, 50)
      return { status: 'stopping' }
    },

    'GET /v1/threads': async () => ({
      threads: await listThreads(resolve(HOME, cfg.ledgerDir), null),
    }),

    'POST /v1/chat/completions': async (body) => {
      const prompt = flattenMessages(body.messages)
      const files = readAttachments(body)
      const modes = readModes(body)
      const threadId = readThreadId(body)
      const requested = body.model ?? cfg.defaultProvider
      const { provider, model, matched } = resolveModel(requested, cfg.defaultProvider)
      if (!matched) {
        throw new RequestError(
          `Unknown model "${requested}". Available: ${modelCatalogue().map((m) => m.id).join(', ')}`
        )
      }

      const session = await sessionFor(provider)
      const result = await session.ask({ prompt, files, model, modes, threadId })
      return completionResponse({ modelId: requested, result, provider })
    },
  }

  async function streamCompletion(body, res) {
    const prompt = flattenMessages(body.messages)
    const files = readAttachments(body)
    const modes = readModes(body)
    const threadId = readThreadId(body)
    const requested = body.model ?? cfg.defaultProvider
    const { provider, model, matched } = resolveModel(requested, cfg.defaultProvider)
    if (!matched) {
      throw new RequestError(
        `Unknown model "${requested}". Available: ${modelCatalogue().map((m) => m.id).join(', ')}`
      )
    }

    const session = await sessionFor(provider)
    let opened = false
    let sent = ''
    let streamId = null
    const write = (value) => {
      if (!opened) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        opened = true
      }
      res.write(`data: ${JSON.stringify(value)}\n\n`)
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
        streamId = `chatcmpl-stream-${Date.now().toString(36)}`
        write(completionChunk({ id: streamId, modelId: requested, delta: { role: 'assistant' } }))
      }
      write(completionChunk({ id: streamId, modelId: requested, delta: { content: delta } }))
    }

    try {
      const result = await session.ask({ prompt, files, model, modes, onProgress: progress, threadId })
      const full = completionResponse({ modelId: requested, result, provider })
      if (!streamId) {
        streamId = full.id
        write(completionChunk({ id: streamId, modelId: requested, delta: { role: 'assistant' } }))
      }
      if (sent !== result.text) progress(result.text)
      write(completionChunk({
        id: streamId,
        modelId: requested,
        finishReason: result.truncated ? 'length' : 'stop',
        bridge: full._uibridge,
      }))
      res.end('data: [DONE]\n\n')
    } catch (err) {
      if (!opened) throw err
      const payload = err instanceof BridgeError
        ? err.toJSON()
        : { error: { message: err.message, type: 'internal' } }
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
      res.end('data: [DONE]\n\n')
    }
  }

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/'
    const route = routes[`${req.method} ${path}`]
    if (!route) return send(res, 404, { error: { message: `No route ${req.method} ${path}`, type: 'not_found' } })

    try {
      const body = req.method === 'POST' ? await readBody(req) : {}
      if (`${req.method} ${path}` === 'POST /v1/chat/completions' && body.stream === true) {
        await streamCompletion(body, res)
        return
      }
      send(res, 200, await route(body))
    } catch (err) {
      // Typed errors carry their own status, so a caller can tell "log in"
      // from "retry" from "your path is wrong" - the prototype answered 502
      // for all three.
      if (err instanceof BridgeError) {
        log.warn(`${err.code}: ${err.message}`)
        return send(res, err.status, err.toJSON())
      }
      log.error(err.stack ?? String(err))
      send(res, 500, { error: { message: err.message, type: 'internal' } })
    }
  })

  async function close() {
    for (const s of sessions.values()) await s.close().catch(() => {})
    sessions.clear()
    await new Promise((r) => server.close(r))
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
