// Browser plumbing: one persistent Chrome profile per service.
//
// WHY CDP INSTEAD OF launchPersistentContext:
// Chrome on Windows re-execs itself during startup ("Opening in an existing
// browser session"). The process Playwright spawned exits, Playwright decides
// the browser died, and you get "Target page, context or browser has been
// closed" - while a real, orphaned Chrome keeps running and holding the
// profile lock. Launching Chrome ourselves and attaching over a debugging
// PORT sidesteps that entirely: we do not care which process ends up owning
// the browser, only that something is listening.
//
// The profile holds YOUR login session. Nothing here handles credentials -
// the cookie lives in the profile exactly as it would in normal Chrome.

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE_PORT = 9333
const spawned = new Map() // port -> child process

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
]

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function loadConfig() {
  return JSON.parse(readFileSync(resolve(HERE, 'config.json'), 'utf8'))
}

export function serviceConfig(cfg, name) {
  const svc = cfg.services[name]
  if (!svc) {
    throw new Error(`Unknown service "${name}". Known: ${Object.keys(cfg.services).join(', ')}`)
  }
  return svc
}

function chromePath() {
  const found = CHROME_CANDIDATES.find((p) => p && existsSync(p))
  if (!found) throw new Error('Google Chrome not found in the usual locations')
  return found
}

/** Deterministic debugging port per service, so restarts reattach. */
export function portFor(cfg, service) {
  const i = Object.keys(cfg.services).indexOf(service)
  return BASE_PORT + (i < 0 ? 0 : i)
}

async function cdpReady(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1200),
    })
    return r.ok
  } catch {
    return false
  }
}

async function launchChrome(port, userDataDir, headless) {
  mkdirSync(userDataDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--disable-blink-features=AutomationControlled',
    'about:blank',
  ]
  if (headless) args.unshift('--headless=new')

  const child = spawn(chromePath(), args, { detached: true, stdio: 'ignore' })
  child.unref()
  spawned.set(port, child)

  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (await cdpReady(port)) return
    await sleep(300)
  }
  throw new Error(`Chrome did not open a debugging port on ${port} within 45s`)
}

/**
 * Get a browser context for a service, launching Chrome if needed.
 * Reattaches to an already-running instance on the same port.
 */
export async function openContext(cfg, service, { headless } = {}) {
  const userDataDir = resolve(HERE, cfg.profileDir, service)
  const port = portFor(cfg, service)

  if (!(await cdpReady(port))) {
    await launchChrome(port, userDataDir, headless ?? cfg.headless)
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const ctx = browser.contexts()[0] ?? (await browser.newContext())
  // Needed to read the message "Copy" button's output, which is the only way
  // to get the original markdown (see config _extraction).
  const origin = new URL(cfg.services[service].url).origin
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {})
  ctx._uibridgePort = port
  return ctx
}

export async function firstPage(ctx, url) {
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  if (url && !page.url().startsWith(url.split('?')[0])) {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
  }
  return page
}

/** Kill any Chrome we started ourselves. Leaves the user's own Chrome alone. */
export function killSpawned() {
  for (const [, child] of spawned) {
    try {
      process.kill(child.pid)
    } catch {
      /* already gone */
    }
  }
  spawned.clear()
}
