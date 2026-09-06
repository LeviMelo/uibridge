// One-time sign-in for a service.
//
//   node login.mjs gemini
//
// IMPORTANT: the composer appearing does NOT mean you are signed in. Gemini
// serves a working composer to anonymous visitors, on a reduced model list,
// and anonymous sessions get bot-flagged very quickly. So this checks for a
// real account, not just a usable page.

import { loadConfig, serviceConfig, openContext, firstPage, sleep } from './browser.mjs'

const service = process.argv[2] ?? 'gemini'
const cfg = loadConfig()
const svc = serviceConfig(cfg, service)

/** { composer, account, anonymous } */
async function state(page) {
  return page.evaluate(
    ({ composerSel, accountSel, outRe }) => {
      const vis = (el) => !!(el && el.getClientRects().length)
      const composer = vis(document.querySelector(composerSel))
      const account = accountSel ? vis(document.querySelector(accountSel)) : false
      const body = document.body ? document.body.innerText : ''
      const anonymous = outRe ? new RegExp(outRe, 'i').test(body) : false
      return { composer, account, anonymous }
    },
    {
      composerSel: svc.composer,
      accountSel: svc.accountMarker ?? null,
      outRe: svc.signedOutMarker ?? null,
    }
  )
}

console.log(`\nOpening ${service} -> ${svc.url}`)
console.log('Sign in with your Google account. Clear any "unusual traffic" check first.')
console.log('I am checking for a real signed-in account, not just a usable page.\n')

const ctx = await openContext(cfg, service, { headless: false })
const page = await firstPage(ctx, svc.url)

const deadline = Date.now() + 10 * 60 * 1000
let last = ''
let ok = false

while (Date.now() < deadline) {
  let s
  try {
    s = await state(page)
  } catch {
    await sleep(1500)
    continue
  }

  const blocked = page.url().includes('/sorry/')
  const line = blocked
    ? 'waiting: unusual-traffic check on screen - please clear it'
    : s.account && !s.anonymous
      ? 'SIGNED IN'
      : s.composer
        ? 'waiting: page works but the session is ANONYMOUS - please sign in'
        : 'waiting: page still loading'

  if (line !== last) {
    console.log(line)
    last = line
  }
  if (line === 'SIGNED IN') {
    ok = true
    break
  }
  await sleep(2000)
}

if (ok) {
  console.log('\nAccount detected. Session persisted to the profile.')
  console.log('You can close the Chrome window - later runs reattach to it.\n')
} else {
  console.log('\nTimed out without detecting a signed-in account.')
  console.log('If you DID sign in, the account marker may be wrong for your UI:')
  console.log(`  node calibrate.mjs ${service}\n`)
}

process.exit(ok ? 0 : 1)
