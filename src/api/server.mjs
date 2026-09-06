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
import { modelCatalogue, providerIds, resolveModel } from '../providers/registry.mjs'
import {
  completionResponse,
  flattenMessages,
  modelsResponse,
  readAttachments,
  readModes,
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

    'POST /v1/chat/completions': async (body) => {
      const prompt = flattenMessages(body.messages)
      const files = readAttachments(body)
      const modes = readModes(body)
      const requested = body.model ?? cfg.defaultProvider
      const { provider, model, matched } = resolveModel(requested, cfg.defaultProvider)
      if (!matched) log.warn(`unknown model "${requested}" - using ${provider} as-is`)

      const session = await sessionFor(provider)
      const result = await session.ask({ prompt, files, model, modes })
      return completionResponse({ modelId: requested, result, provider })
    },
  }

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/'
    const route = routes[`${req.method} ${path}`]
    if (!route) return send(res, 404, { error: { message: `No route ${req.method} ${path}`, type: 'not_found' } })

    try {
      const body = req.method === 'POST' ? await readBody(req) : {}
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
