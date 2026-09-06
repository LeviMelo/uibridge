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
import { fileURLToPath } from 'node:url'
import { RequestError } from './errors.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const DEFAULTS = {
  port: 8477,
  host: '127.0.0.1',
  profileDir: '.profiles',
  downloadDir: 'downloads',
  headless: false,
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
export function loadConfig(path = resolve(ROOT, 'config.json')) {
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const cfg = merge(DEFAULTS, file)
  cfg.providers = cfg.providers ?? {}
  return cfg
}

/** Effective settings for one provider: defaults, then per-provider overrides. */
export function providerSettings(cfg, id, providerDefaults = {}) {
  const s = merge(merge(cfg.provider, providerDefaults), cfg.providers[id] ?? {})
  s.downloadDir = resolve(ROOT, s.downloadDir ?? cfg.downloadDir)
  s.profileDir = resolve(ROOT, cfg.profileDir, id)
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
