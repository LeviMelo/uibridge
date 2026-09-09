// Configuration.
//
// Split deliberately from selectors. config.json holds OPERATIONAL choices -
// port, concurrency, timeouts, which provider is default. Selectors live with
// their provider. In the prototype both were in one file, so tuning a timeout
// meant editing the same blob as the DOM contract, and it was never clear
// which lines were safe to touch.
//
// Defaults are here, not spread through the code, so the effective settings
// for a run can be printed and logged.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { RequestError } from './errors.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * This build's version, from package.json.
 *
 * Reported on /health so "which uibridge am I talking to?" has an answer -
 * the daemon outlives the shell that started it and can easily be running
 * code older than the checkout in front of you.
 */
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Where uibridge keeps STATE: config.json, the Chrome profiles that hold
 * your logins, downloads, the thread ledger, exports, the daemon log.
 *
 * ROOT is where the CODE lives, and once this is installed globally the two
 * must not be the same: `npm i -g` puts the code under npm's own directory,
 * so writing profiles there would bury your logins somewhere invisible and
 * lose them on the next reinstall.
 *
 *   UIBRIDGE_HOME           wins, if set
 *   <checkout>/config.json  exists -> the checkout itself, so development
 *                           and an existing copy behave exactly as before
 *   otherwise               %LOCALAPPDATA%/uibridge (Windows) or
 *                           ~/.local/share/uibridge
 */
export const HOME = (() => {
  if (process.env.UIBRIDGE_HOME) return resolve(process.env.UIBRIDGE_HOME)
  if (existsSync(resolve(ROOT, 'config.json'))) return ROOT
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ?? resolve(homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local', 'share')
  return resolve(base, 'uibridge')
})()

const DEFAULTS = {
  port: 8477,
  host: '127.0.0.1',
  profileDir: '.profiles',
  downloadDir: 'downloads',
  ledgerDir: '.uibridge/threads',
  exportDir: '.uibridge/exports',
  requestDir: '.uibridge/requests',
  maxPendingRequests: 64,
  requestTimeoutMs: 900000,
  // HEADLESS BY DEFAULT. This runs as a background service for other
  // programs on the machine; a chat window flashing open on every call is
  // not something a caller asked for. Signing in is the exception - that is
  // a human action and always opens a real window. Override per run with
  // `uibridge serve --headed`, or permanently with "headless": false here.
  // Window mode: true (--headless=new), 'offscreen' (a real browser parked
  // off the visible desktop - nothing pops up, and the site sees a normal
  // browser) or false (a visible window). Signing in always opens a real
  // visible window regardless: that is a human action.
  // MEASURED: ChatGPT serves an anonymous session to true headless even with
  // valid cookies, so its own provider block pins 'offscreen'.
  headless: process.env.UIBRIDGE_HEADED ? false : 'offscreen',
  windowModeOverride: process.env.UIBRIDGE_HEADED ? false : undefined,
  defaultProvider: 'gemini',
  // One debugging port per provider, derived from this base, so restarts
  // reattach to the browser that is already running.
  basePort: 9333,
  provider: {
    concurrency: 2,
    // Large rich-text pastes can truncate (Gemini) or stall the editor.
    // Carry the complete request in a temporary UTF-8 attachment instead.
    maxComposerChars: 32000,
    // A fresh conversation per request: no shared context, and model choice
    // actually takes effect (switching mid-thread is unreliable).
    newChatPerRequest: true,
    readyTimeoutMs: 60000,
    // Only DOM-extracted continuations need an old-response baseline. This
    // is deliberately short and never applies to wire extraction.
    historyBaselineMs: 8000,
    // Exporting history requests the history itself, so it gets a separate
    // generous budget rather than borrowing the send-path baseline budget.
    historyTimeoutMs: 60000,
    // How long a requested thread has to actually appear in the URL after we
    // navigate to it. Nothing is sent until it does: a site that quietly
    // lands on a new chat instead would otherwise get the prompt anyway.
    threadResumeMs: 10000,
    // A turn appears within seconds of a real submission. Its own short
    // budget, so a prompt that never got sent fails in a minute instead of
    // sitting for the full response timeout with a misleading message.
    submitAckMs: 60000,
    responseTimeoutMs: 600000,
    uploadTimeoutMs: 180000,
    fileWaitMs: 20000,
    pollMs: 150,
    // Consecutive identical reads that mean "finished". A measurement of
    // stability, not padding.
    settleChecks: 5,
    // Gemini drops model switches sometimes - their bug, not ours - and a
    // retry usually takes. See DomProvider.selectModel.
    modelSelectAttempts: 3,
    // false: an unapplied model is recorded as unverified and the request
    // proceeds (what an OpenAI-shaped client expects).
    // true : it becomes an error. Use this for a pipeline where provenance
    //        integrity matters more than getting an answer - a systematic
    //        review must not attribute a row to a model that did not write it.
    strictModel: true,
    // Extra provider error wordings, as regex source strings. A provider can
    // change its failure text at any time and an operator meets the new one
    // before we do; adding it must not require editing source.
    errorTextExtra: [],
    // Turn a SUSPECTED provider failure (see core/answer-integrity.mjs) into
    // a 502 instead of a flag. Off by default because a refusal or a terse
    // apology can be legitimate content; on for pipelines that would rather
    // lose a row than record one.
    failOnSuspectedProviderError: false,
    // A provider error notice is short. Longer text containing an apology is
    // an answer.
    errorNoticeMaxChars: 400,
    // Minimum spacing between request STARTS on a provider, across all its
    // tabs. A burst of fresh conversations trips these sites' throttling,
    // and a batch pipeline is exactly the caller that would burst. Per
    // provider below; 0 disables.
    minIntervalMs: 0,
    // Continuations do not create sidebar conversations and therefore do
    // not trigger the fresh-chat burst condition. Set independently when a
    // provider/account needs slower same-thread traffic.
    continuationIntervalMs: 0,
  },
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function merge(base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v
  }
  return out
}

/** Load config.json if present, merged over defaults. */
export function loadConfig(path = resolve(HOME, 'config.json')) {
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  validateConfig(file, path)
  const cfg = merge(DEFAULTS, file)
  cfg.providers = cfg.providers ?? {}
  return cfg
}

// Keys that are legitimate inside `provider` / `providers.<id>` but are not
// in the shared defaults: the window mode and the site address are resolved
// per provider, and the debug port is per provider by construction.
const PROVIDER_ONLY = ['headless', 'url', 'debugPort', 'downloadDir']

/**
 * Refuse a setting this build does not have.
 *
 * A misspelled key used to be merged in and ignored in silence, so
 * `"headles": false` or `"responseTimeout": 900000` looked applied and
 * changed nothing - the same failure mode as an unknown command-line flag,
 * except it persists in a file and quietly governs every later run. For work
 * whose results have to be reproducible, a configuration that does not mean
 * what it says is worse than one that will not load.
 *
 * Keys beginning with `_` are ignored on purpose, so a config file can carry
 * notes the way the selector files do.
 */
export function validateConfig(file, path = '(config)') {
  const known = new Set([...Object.keys(DEFAULTS), 'provider', 'providers'])
  const providerKeys = new Set([...Object.keys(DEFAULTS.provider), ...PROVIDER_ONLY])
  const bad = []
  const check = (obj, allowed, where) => {
    for (const key of Object.keys(obj ?? {})) {
      if (key.startsWith('_') || allowed.has(key)) continue
      const near = [...allowed].find((a) => a.toLowerCase().startsWith(key.slice(0, 5).toLowerCase()))
      bad.push(`${where}${key}${near ? ` (did you mean "${near}"?)` : ''}`)
    }
  }
  check(file, known, '')
  check(file.provider, providerKeys, 'provider.')
  for (const [id, settings] of Object.entries(file.providers ?? {})) {
    if (id.startsWith('_')) continue
    check(settings, providerKeys, `providers.${id}.`)
  }
  if (bad.length) {
    throw new RequestError(
      `${path} has ${bad.length} setting(s) this build does not recognise: ${bad.join(', ')}. ` +
        'Remove them, or prefix a key with "_" to keep it as a note.'
    )
  }
}

/** Effective settings for one provider: defaults, then per-provider overrides. */
export function providerSettings(cfg, id, providerDefaults = {}) {
  const s = merge(merge(cfg.provider, providerDefaults), cfg.providers[id] ?? {})
  // Window mode can differ per provider: measured, Gemini works in true
  // headless and ChatGPT does not, and forcing both to the weaker setting
  // would cost a window nobody asked for.
  s.headless = s.headless ?? cfg.headless
  if (cfg.windowModeOverride !== undefined) s.headless = cfg.windowModeOverride
  // EVERY PATH COMES FROM THE SAME HOME AS THE SERVER'S. `cfg.home` is how an
  // embedder (and the test suite) points one instance at its own state
  // directory; the API already resolved its ledger reads, its idempotency
  // store and the identity on /health against it. These three did not, and
  // took the process-global HOME instead. Measured 2026-09-09: a server given
  // cfg.home answered a completion, wrote the ledger into the OTHER
  // directory, then returned 404 thread_unknown for the thread it had just
  // created, and /v1/threads listed nothing. profileDir is the dangerous one
  // of the three - a split there drives a different Chrome profile, which is
  // a different logged-in account.
  const stateHome = cfg.home ?? HOME
  s.downloadDir = resolve(stateHome, s.downloadDir ?? cfg.downloadDir)
  s.profileDir = resolve(stateHome, cfg.profileDir, id)
  s.ledgerDir = resolve(stateHome, cfg.ledgerDir)
  return s
}

/** Deterministic debugging port per provider. */
export function portFor(cfg, id, index) {
  return cfg.providers?.[id]?.debugPort ?? cfg.basePort + index
}

export function requireProvider(cfg, known, id) {
  const name = id ?? cfg.defaultProvider
  if (!known.includes(name)) {
    throw new RequestError(`Unknown provider "${name}". Known: ${known.join(', ')}`)
  }
  return name
}
