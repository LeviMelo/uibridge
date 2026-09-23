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
  // The most a request may declare for its own answer
  // (`_uibridge.response_timeout_ms`); above it the request is refused.
  maxResponseTimeoutMs: 3600000,
  // Added to a declared response budget for the whole-request budget.
  requestOverheadMs: 300000,
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
  // Documented in README as the way to get the refusal back for OpenAI
  // parameters a chat UI has no knob for. It was read but never defaulted,
  // so no config file could set it and the branch was unreachable.
  strictParameters: false,
  // One debugging port per provider, derived from this base, so restarts
  // reattach to the browser that is already running.
  basePort: 9333,
  provider: {
    concurrency: 2,
    // The size past which the editor is not tried at all. NOT a policy about
    // when to attach: the composer is tried first for anything below this and
    // a `compose_failed` falls back to an attachment by itself (session.mjs).
    //
    // It was 32,000, from when `fill()` typed the prompt at ~0.1 s per line
    // and a large paste could truncate or stall. `placeAsParagraphs` replaced
    // that with a single ProseMirror write (342 lines in 0.6 s, 2026-09-18),
    // and `fillComposer` reads the composer back and refuses retryably if any
    // of the prompt is missing, so truncation is caught rather than risked.
    // Leaving it at 32,000 cost a caller 65 of its 80 per-window uploads on
    // text the editor would have taken (PHAROS, 2026-09-20). A shorter prompt
    // the site itself will not send (its send button stays disabled: ChatGPT
    // Instantânea past ~58K tokens, 2026-09-23) is attached too
    // (dom-provider, TEXT_SEND_SETTLE_MS).
    maxComposerChars: 400000,
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
    // How long the page may show a turn finished (no stop control, its text
    // unchanged) while the answer's stream has still not reported an end,
    // before the stream is given up and the answer read off the page.
    // Measured 2026-09-18: a connection lost mid-turn left the stream's end
    // unseen, and a finished draft with six files waited out its whole
    // 2,700 s budget and failed. On a healthy turn the two end together.
    wireStallMs: 60000,
    // Ten PDFs in one prompt go through the app's own upload pipeline one
    // by one; on a slow link that is more than three minutes (2026-09-17:
    // eight of ten such batches timed out at 180 s). The wait is per file:
    // `uploadPerFileMs` each, at least `uploadFloorMs` (small batches always
    // fit in 180 s), at most `uploadTimeoutMs`. One file waits 180 s, ten
    // wait 600 s. A single-file wait of 600 s only prolonged stalls: 31 of
    // 1,205 requests died on a process_upload_stream that never finished,
    // and the retry of the one on 2026-09-17 answered in 108 s.
    uploadTimeoutMs: 600000,
    uploadPerFileMs: 60000,
    uploadFloorMs: 180000,
    // Type and send the prompt while its attachments are still uploading,
    // instead of after every upload is confirmed. Only on a provider whose
    // uploads are visible on the wire (ChatGPT): there the site holds a sent
    // prompt until its files are ready - read from its own code and seen by
    // the user - and the confirmations still catch a refused file after the
    // send. Waiting first was our gate, not the site's, and each of the 31
    // stalls above cost its whole budget before failing. See
    // DomProvider.attach. false restores the wait-then-type order.
    sendDuringUpload: true,
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
  // A hand-edited config with a trailing comma threw a bare SyntaxError
  // from deep inside startup, naming neither the file nor the fix.
  let file = {}
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
      throw new RequestError(`${path} is not valid JSON: ${e.message}`)
    }
  }
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

/**
 * `--concurrency=N` for `serve`: the tab pool size of EVERY provider, over
 * the provider's own default and whatever config.json says. A number given
 * on the command line is the operator's decision for this run; it does not
 * touch pacing (`minIntervalMs`), which stays the floor between request
 * starts however many tabs there are. Returns a new config; `cfg` is not
 * mutated, so a config object shared with tests keeps its file values.
 */
export function withConcurrency(cfg, n) {
  const value = Number(n)
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new Error(`--concurrency must be an integer from 1 to 16, not ${JSON.stringify(n)}`)
  }
  const providers = {}
  for (const id of Object.keys(cfg.providers ?? {})) providers[id] = { ...(cfg.providers[id] ?? {}), concurrency: value }
  return { ...cfg, provider: { ...cfg.provider, concurrency: value }, providers }
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
