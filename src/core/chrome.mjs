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
import { waitFor } from './async.mjs'
import { logger } from './log.mjs'
import { manageWindows } from './window.mjs'

const log = logger('chrome')

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
  // THREE MODES, because "no window in my face" and "headless" are not the
  // same requirement:
  //
  //   true        --headless=new. Cheapest, but MEASURED 2026-09-06:
  //               chatgpt.com serves an anonymous session to it even with
  //               valid session cookies in the profile, so a real ChatGPT
  //               turn cannot be done this way.
  //   'offscreen' a real, ordinary browser parked off the visible desktop.
  //               Nothing pops up, and the site sees exactly what it sees
  //               when a person uses it - which is the point of this whole
  //               project.
  //   false       a normal visible window. What `login` always uses, and
  //               what you want when watching it work.
  if (headless === true) args.unshift('--headless=new')
  else if (headless === 'offscreen') args.unshift('--window-position=-32000,-32000', '--window-size=1500,1000')

  log.debug(`launching chrome on port ${port} (profile ${userDataDir})`)
  const child = spawn(chromePath(), args, { detached: true, stdio: 'ignore' })
  child.unref()
  // NOT TRACKED FOR CLEANUP, DELIBERATELY. Chrome we launch is left
  // running: it holds the profile, and the next run reattaches to its
  // debugging port instead of paying the startup cost again. There was a
  // killSpawned() here for a long time that nothing ever called, which
  // read as an oversight rather than as the policy it actually is.

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
export async function connectBrowser(port, { connect = (url, options) => chromium.connectOverCDP(url, options), timeout = 8000 } = {}) {
  // Retrying attachment is safe: no provider request has been submitted yet.
  // Never restart Chrome automatically: another client may own an active tab.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await connect(`http://127.0.0.1:${port}`, { timeout })
    } catch (error) {
      if (attempt < 2) continue
      throw new BridgeError(
        `Cannot attach to Chrome on port ${port} after two attempts. Chrome may have unresponsive tabs even when its debugging endpoint responds. No prompt was submitted by this request. Close and reopen the dedicated provider browser when idle, then submit with a new request key; recover only retrieves the saved outcome.`,
        { status: 503, code: 'browser_unavailable', detail: {
          stage: 'browser_attach', submission_started: false, attempts: attempt,
          port, cause: String(error.message ?? error).split('\n')[0].slice(0, 300),
        } }
      )
    }
  }
}

export async function attachBrowser({ port, userDataDir, headless = false, clipboardOrigins = [] }) {
  const fresh = !(await debuggerUp(port))
  if (fresh) await launch(port, userDataDir, headless)

  const browser = await connectBrowser(port)
  const ctx = browser.contexts()[0] ?? (await browser.newContext())
  const preparePage = await manageWindows(ctx, headless, log)
  for (const origin of clipboardOrigins) {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {})
  }
  log.debug(`${fresh ? 'launched' : 'reattached'} on ${port}`)
  return { browser, ctx, launched: fresh, preparePage }
}

