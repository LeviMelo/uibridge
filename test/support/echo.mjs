// Start a real uibridge server backed by the scripted provider.
//
// Everything here is the PRODUCTION code path - the same `serve()`, the same
// Session, the same durable request store - with only the provider replaced.
// That is the point: a suite that stubs the HTTP layer proves nothing about
// the HTTP layer.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A server on an ephemeral port, with its own throwaway state directory.
 *
 * `UIBRIDGE_HOME` and `UIBRIDGE_TEST_PROVIDER` are read at import time by
 * config and registry, so they are set before those modules are loaded and
 * the server is started in a child-free, in-process way.
 */
export async function startEchoServer({ port = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'uibridge-echo-'))
  process.env.UIBRIDGE_HOME = home
  process.env.UIBRIDGE_TEST_PROVIDER = '1'

  const { serve } = await import('../../src/api/server.mjs')
  const { loadConfig } = await import('../../src/core/config.mjs')
  const { setLevel } = await import('../../src/core/log.mjs')
  setLevel('error')

  const cfg = { ...loadConfig(), port, host: '127.0.0.1', defaultProvider: 'echo' }
  const app = await serve(cfg)
  const actual = app.server.address().port

  // How many times did a request actually reach the server? A client library
  // may retry on its own, and against a browser-driving bridge each retry is
  // another message typed into a real conversation - so a test has to be able
  // to count arrivals, not just look at the final answer.
  let hits = 0
  app.server.on('request', (req) => { if ((req.url ?? '').startsWith('/v1/chat/completions')) hits++ })

  return {
    home,
    port: actual,
    hits: () => hits,
    resetHits() { hits = 0 },
    base: `http://127.0.0.1:${actual}`,
    async close() {
      await app.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}
