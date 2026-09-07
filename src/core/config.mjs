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
  defaultProvider: 'gemini',
  // One debugging port per provider, derived from this base, so restarts
  // reattach to the browser that is already running.
  basePort: 9333,
  provider: {
    concurrency: 2,
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
    strictModel: false,
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
  const cfg = merge(DEFAULTS, file)
  cfg.providers = cfg.providers ?? {}
  return cfg
}

/** Effective settings for one provider: defaults, then per-provider overrides. */
export function providerSettings(cfg, id, providerDefaults = {}) {
  const s = merge(merge(cfg.provider, providerDefaults), cfg.providers[id] ?? {})
  // Window mode can differ per provider: measured, Gemini works in true
  // headless and ChatGPT does not, and forcing both to the weaker setting
  // would cost a window nobody asked for.
  s.headless = s.headless ?? cfg.headless
  s.downloadDir = resolve(HOME, s.downloadDir ?? cfg.downloadDir)
  s.profileDir = resolve(HOME, cfg.profileDir, id)
  s.ledgerDir = resolve(HOME, cfg.ledgerDir)
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
