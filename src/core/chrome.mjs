// Chrome lifecycle. Provider-agnostic: it knows about profiles and debugging
// ports, nothing about chat UIs.
//
// WHY WE ATTACH OVER CDP INSTEAD OF launchPersistentContext:
// Chrome on Windows re-execs itself during startup ("opening in an existing
// browser session"). The process Playwright spawned exits, Playwright decides
// the browser died, and you get "Target page, context or browser has been
// closed" - while a real, orphaned Chrome keeps running and holding the
// profile lock, so the next attempt fails too. Launching Chrome ourselves and
// attaching to a fixed debugging port removes the question of which process
// owns the browser: we only need something listening.
//
// The profile directory holds the user's live session cookie. Nothing here
// touches credentials - signing in is a human action in a visible window, and
// .profiles/ is gitignored precisely because it is as sensitive as a password.

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { BridgeError } from './errors.mjs'
import { sleep, waitFor } from './async.mjs'
import { logger } from './log.mjs'

const log = logger('chrome')
const spawned = new Map() // port -> child

const CANDIDATES = [
  process.env.UIBRIDGE_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

function chromePath() {
  const found = CANDIDATES.find((p) => existsSync(p))
  if (!found) {
    throw new BridgeError(
      'Google Chrome not found. Set UIBRIDGE_CHROME to its full path.',
      { code: 'chrome_missing' }
    )
  }
  return found
}

async function debuggerUp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1200),
    })
    return r.ok
  } catch {
    return false
  }
}

async function launch(port, userDataDir, headless) {
  mkdirSync(userDataDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    // Chrome's own automation banner changes layout and focus behaviour;
    // dropping it keeps the window the same shape a person would see.
    '--disable-blink-features=AutomationControlled',
    'about:blank',
  ]
  if (headless) args.unshift('--headless=new')

  log.debug(`launching chrome on port ${port} (profile ${userDataDir})`)
  const child = spawn(chromePath(), args, { detached: true, stdio: 'ignore' })
  child.unref()
  spawned.set(port, child)

  await waitFor(() => debuggerUp(port), {
    timeout: 45000,
    poll: 300,
    what: `Chrome to open a debugging port on ${port}`,
  })
}

/**
 * One browser context per profile, reattaching if Chrome is already up.
 *
 * `clipboardOrigins` are granted clipboard access because on some providers
 * the message "Copy" button is the only route to the original markdown - see
 * transports/dom.mjs for why that matters.
 */
export async function attachBrowser({ port, userDataDir, headless = false, clipboardOrigins = [] }) {
  const fresh = !(await debuggerUp(port))
  if (fresh) await launch(port, userDataDir, headless)

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const ctx = browser.contexts()[0] ?? (await browser.newContext())
  for (const origin of clipboardOrigins) {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {})
  }
  log.debug(`${fresh ? 'launched' : 'reattached'} on ${port}`)
  return { browser, ctx, launched: fresh }
}

/** Kill only Chrome instances we started. The user's own browser is theirs. */
export async function killSpawned() {
  for (const [port, child] of spawned) {
    try {
      process.kill(child.pid)
      log.debug(`killed chrome on ${port}`)
    } catch {
      /* already gone */
    }
  }
  spawned.clear()
  await sleep(0)
}
