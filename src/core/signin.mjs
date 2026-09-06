// THE SIGN-IN PROMPT.
//
// A window appearing on screen is not a prompt. The person it is aimed at is
// looking at Chrome, not at the terminal that opened it, and a browser window
// that opens by itself reads as something to close, not something to act on.
// An earlier version of this opened a blank tab and expected the user to
// infer what it was for, which is not automation - it is a riddle.
//
// So the prompt is placed where the eyes already are: a banner inside the
// page itself, saying which tool opened this window, what it is waiting for,
// that the site's own Log in button is the thing to press, and that no
// password is ever seen by this tool. The terminal gets the same story, and
// the banner updates as the state changes so the user gets a visible
// confirmation rather than a window that simply stops mattering.
//
// The banner is injected ONLY on the provider's own origin. During sign-in
// the browser passes through Google's or OpenAI's identity pages, and drawing
// our own overlay on top of somebody's login form is exactly what a phishing
// page does. It has pointer-events: none for the same reason - it must never
// sit between the user and a control they are trying to press.

import { sessionState } from './auth.mjs'
import { sleep } from './async.mjs'

const BANNER_ID = 'uibridge-signin-banner'

const BANNER = `(state) => {
  const ID = 'uibridge-signin-banner'
  let el = document.getElementById(ID)
  if (!el) {
    el = document.createElement('div')
    el.id = ID
    // pointer-events:none - the banner must never intercept a click meant
    // for the page's own sign-in control.
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'pointer-events:none', 'font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif',
      'padding:14px 18px', 'box-sizing:border-box',
      'box-shadow:0 2px 14px rgba(0,0,0,.35)', 'color:#fff',
    ].join(';')
    document.documentElement.appendChild(el)
  }
  const tone = state.done ? '#166534' : state.warn ? '#9a3412' : '#1e3a8a'
  el.style.background = tone
  el.innerHTML =
    '<div style="max-width:900px;margin:0 auto">' +
    '<div style="font-weight:700;letter-spacing:.02em">' + state.title + '</div>' +
    '<div style="opacity:.92;margin-top:3px">' + state.body + '</div>' +
    '<div style="opacity:.75;margin-top:6px;font-size:12px">' + state.status + '</div>' +
    '</div>'
  // Push the page down so the banner never covers the site's own header,
  // where the Log in button usually lives.
  document.documentElement.style.scrollPaddingTop = el.offsetHeight + 'px'
  if (!document.body.dataset.uibridgeOffset) {
    document.body.dataset.uibridgeOffset = '1'
    document.body.style.paddingTop = el.offsetHeight + 'px'
  }
}`

const CLEAR = `() => {
  const el = document.getElementById('${BANNER_ID}')
  if (el) el.remove()
  if (document.body) { document.body.style.paddingTop = ''; delete document.body.dataset.uibridgeOffset }
}`

async function paint(page, origin, state) {
  // Only on the provider's own origin: never draw over an identity provider's
  // login form.
  if (!page.url().startsWith(origin)) return
  await page.evaluate(BANNER, state).catch(() => {})
}

/**
 * Open the site, prompt in the window, and wait for a PROVEN session.
 *
 * Returns the final verdict. Never types a credential, never touches a
 * verification challenge - if one appears it says so and keeps waiting, since
 * clearing it is the user's to do.
 */
export async function awaitSignIn({ page, providerId, url, auth, log, timeoutMs = 15 * 60 * 1000, onState }) {
  const origin = new URL(url).origin

  await page.bringToFront().catch(() => {})
  await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
  if (!page.url().startsWith(origin)) {
    await page.goto(auth?.signInUrl ?? url, { waitUntil: 'domcontentloaded' }).catch(() => {})
  }

  const deadline = Date.now() + timeoutMs
  let last = ''
  let verdict = null

  while (Date.now() < deadline) {
    verdict = await sessionState(page, auth ?? {})

    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000))
    const mins = `${Math.floor(left / 60)}m${String(left % 60).padStart(2, '0')}s`

    if (verdict.state === 'in') {
      const who = typeof verdict.evidence.account === 'string' ? ` as ${verdict.evidence.account}` : ''
      await paint(page, origin, {
        done: true,
        title: `Signed in${who} - uibridge is ready.`,
        body: 'You can close this window. The session is stored in this browser profile and persists across restarts.',
        status: verdict.authority,
      })
      log?.info(`signed in${who} (${verdict.authority})`)
      onState?.(verdict)
      await sleep(1200)
      await page.evaluate(CLEAR).catch(() => {})
      return verdict
    }

    const challenge = verdict.state === 'challenge'
    await paint(page, origin, {
      warn: challenge,
      title: challenge
        ? 'uibridge is waiting - please clear the verification shown below.'
        : `uibridge is waiting for you to sign in to ${providerId}.`,
      body: challenge
        ? 'This tool does not solve or bypass verification checks. Clear it yourself and sign-in detection will continue automatically.'
        : "Use this site's own Log in button, as you normally would. uibridge never sees or types your password.",
      status: `${verdict.authority} - checking every 2s, ${mins} left. This window belongs to uibridge; leave it open.`,
    })

    const line = `${verdict.state}: ${verdict.authority}`
    if (line !== last) {
      log?.info(line)
      onState?.(verdict)
    }
    last = line
    await sleep(2000)
  }

  await paint(page, origin, {
    warn: true,
    title: 'uibridge stopped waiting for sign-in.',
    body: `Run "node bin/uibridge.mjs login ${providerId}" again when you are ready.`,
    status: verdict?.authority ?? '',
  })
  return verdict ?? { state: 'unknown', authority: 'timed out waiting', because: [], evidence: {} }
}
