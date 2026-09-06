// PROVE THE NEGATIVE.
//
// Getting "signed in" right is easy; it happens by accident. The case that
// matters is the other one, because a wrong "signed in" does not throw - the
// request goes out against an anonymous session, comes back from a weaker
// model, and lands in a batch with nothing to mark it.
//
// So this drives detection against a THROWAWAY profile that has never seen a
// login. It is a genuine signed-out browser, and it touches nothing the user
// has signed into. Run it whenever a provider's auth block is written or
// changed - a signal that only ever fires one way has not been tested.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachBrowser } from '../core/chrome.mjs'
import { sessionState, signedOutMessage } from '../core/auth.mjs'
import { providerClass } from '../providers/registry.mjs'
import { sleep } from '../core/async.mjs'

export async function checkAnonymousDetection(id, { port = 9411 } = {}) {
  const sel = providerClass(id).selectors
  const dir = mkdtempSync(join(tmpdir(), `uibridge-anon-${id}-`))
  let page

  try {
    const { ctx } = await attachBrowser({
      port,
      userDataDir: dir,
      headless: false,
      clipboardOrigins: [new URL(sel.url).origin],
    })
    page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(sel.url, { waitUntil: 'domcontentloaded' })
    // These apps decide what to serve after hydration, so an immediate read
    // describes a page that does not exist a second later.
    await sleep(7000)

    const v = await sessionState(page, sel.auth ?? {})
    const correct = v.state !== 'in'

    console.log(`\n== ${id}: signed-out detection (throwaway profile) ==`)
    console.log(`  verdict   : ${v.state}  ${correct ? '(correct)' : '(WRONG - claimed a session that does not exist)'}`)
    console.log(`  why       : ${v.authority}`)
    for (const b of v.because ?? []) console.log(`              ${b}`)
    console.log(`  cookies   : ${v.evidence.cookies.map((c) => c.name).join(', ') || '(none)'}`)
    console.log(`\n  --- what a caller would receive ---`)
    for (const line of signedOutMessage(id, v).split(String.fromCharCode(10))) console.log(`  ${line}`)
    console.log()
    return correct
  } finally {
    await page?.close().catch(() => {})
    // The profile held a real (anonymous) browsing session; do not leave it.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Chrome may still hold a handle; the OS temp dir is swept anyway */
    }
  }
}
