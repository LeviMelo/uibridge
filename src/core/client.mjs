// Talking to a RUNNING uibridge instead of starting a second one.
//
// Every CLI command used to open its own browser, drive one turn and throw
// the tab away: 45-60s of that was Chrome and the site booting, per turn,
// for work a warm tab does in 8-22s. Worse, two copies cannot drive the same
// Chrome profile, so a command issued while `serve` was running failed on a
// composer that was never going to appear - it belonged to the other
// process.
//
// So the CLI is a client. If a uibridge is listening it does the work in its
// warm tab; if none is, one is started and stays for the next command.
// `--local` opts out for debugging the browser layer itself.

import { spawn } from 'node:child_process'
import { openSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { HOME, ROOT } from './config.mjs'
import { BridgeError } from './errors.mjs'
import { identify, isUibridge } from './protocol.mjs'

const base = (cfg) => `http://${cfg.host}:${cfg.port}`

async function get(url, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs)
  const res = await fetch(url, { signal })
  return res.ok ? res.json() : null
}

/** Whatever answers /health on the configured port, unjudged. */
export async function rawHealth(cfg, timeoutMs = 700) {
  return get(`${base(cfg)}/health`, timeoutMs).catch(() => null)
}

/**
 * The health payload of a listening uibridge of THIS build, or null.
 *
 * ALSO CHECKS WHICH STATE DIRECTORY IT SERVES. A client is a client of
 * whatever holds the port, and the port is the same for every HOME by
 * default, so a command run with a different UIBRIDGE_HOME - a second
 * account, a test config, an experiment - was silently answered by the
 * daemon someone started yesterday, with yesterday's config and yesterday's
 * logins. Measured: an `ask` pointed at a deliberately unreachable host
 * returned a normal answer from the real site, and the ledger line named the
 * wrong directory. Nothing in the output said so. Refusing is the only
 * honest option: the alternative is data attributed to the wrong
 * configuration.
 */
export async function daemonHealth(cfg, timeoutMs = 700) {
  const payload = await rawHealth(cfg, timeoutMs)
  const kind = identify(payload)
  if (kind === 'absent') return null
  if (kind === 'ours') {
    if (payload.home && resolve(payload.home) !== resolve(HOME)) {
      throw new BridgeError(
        `The uibridge on ${cfg.host}:${cfg.port} is serving a different state directory:
` +
          `  it is using : ${payload.home}
` +
          `  you asked for: ${HOME}
` +
          'Its config, logins and ledger are the ones that would be used. Run `uibridge stop` ' +
          'first, or give this one its own "port" in config.json.',
        { status: 409, code: 'daemon_other_home', retryable: false, detail: { daemon_home: payload.home, requested_home: HOME } }
      )
    }
    return payload
  }
  throw new BridgeError(
    isUibridge(kind)
      ? `A uibridge from a different build is already on ${cfg.host}:${cfg.port}. ` +
        'Run `uibridge stop` to replace it with this one - a running daemon keeps serving the code it started with.'
      : `Port ${cfg.port} is occupied by something that is not uibridge. Refusing to send prompts to it.`,
    { status: 503, code: 'daemon_incompatible', retryable: false }
  )
}

/**
 * A running uibridge, starting one if needed.
 *
 * Failure is explicit. Silently falling back to a second in-process browser
 * can make two processes fight over the same Chrome profile.
 */
export async function ensureDaemon(cfg, { autostart = true, log } = {}) {
  const health = await daemonHealth(cfg)
  if (health) return { base: base(cfg), started: false, health }
  if (!autostart) {
    throw new BridgeError(
      `No uibridge is listening on ${cfg.host}:${cfg.port}, and starting one was not permitted. ` +
        'Run `uibridge serve`, or pass --local to drive a browser in this process.',
      { status: 503, code: 'daemon_not_running', retryable: true }
    )
  }

  log?.info(`starting uibridge on ${cfg.host}:${cfg.port} so this and later commands reuse one warm browser`)
  // The daemon's logs must not land in this command's stdout (--json output
  // would stop being a document), but discarding them makes every failure
  // inside the daemon undiagnosable from here. They go to a file.
  const logDir = resolve(HOME, '.uibridge')
  mkdirSync(logDir, { recursive: true })
  const logFile = openSync(resolve(logDir, 'daemon.log'), 'a')
  const child = spawn(process.execPath, [resolve(ROOT, 'bin', 'uibridge.mjs'), 'serve'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFile, logFile],
  })
  child.unref()

  // Wait for it to actually answer. A spawned process is not a service.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const up = await daemonHealth(cfg, 400)
    if (up) return { base: base(cfg), started: true, health: up }
  }
  throw new BridgeError(
    `The uibridge daemon did not become ready on ${cfg.host}:${cfg.port} within 20s. ` +
      `See ${resolve(HOME, '.uibridge', 'daemon.log')}. Use --local only when deliberately debugging without a daemon.`,
    { status: 503, code: 'daemon_start_failed', retryable: true }
  )
}

/**
 * POST to the daemon and surface ITS error, not a generic one.
 *
 * The API's typed errors (401 signed_out, 503 thread_unavailable, ...) are
 * the whole point of having them; flattening them into "request failed"
 * would make the CLI less informative than the HTTP interface it wraps.
 */
export async function daemonPost(url, body, { timeoutMs = 20 * 60 * 1000, headers = {}, method = 'POST' } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await res.json().catch(() => null)
  if (!res.ok) {
    // RE-TYPE IT LOCALLY. The daemon's error was a BridgeError before HTTP
    // flattened it; handing back a bare Error meant the CLI's own handler
    // did not recognise it and dumped a Node stack trace over an ordinary,
    // expected condition ("you are signed out", "that thread is gone").
    throw new BridgeError(payload?.error?.message ?? `uibridge returned ${res.status}`, {
      status: res.status,
      code: payload?.error?.code ?? payload?.error?.type ?? 'bridge_error',
      retryable: payload?.error?.retryable ?? false,
      detail: payload?.error?.detail,
    })
  }
  return payload
}

/** The OpenAI envelope, flattened back to what the CLI prints. */
export function flatten(envelope) {
  const u = envelope._uibridge ?? {}
  return {
    text: envelope.choices?.[0]?.message?.content ?? '',
    ...u,
    tables: u.tables ?? [],
    code_blocks: u.code_blocks ?? [],
    files: u.files ?? [],
    sources: u.sources ?? [],
    provenance: u.provenance ?? {},
  }
}
