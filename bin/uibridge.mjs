#!/usr/bin/env node
// uibridge CLI.
//
//   uibridge serve                 start the local OpenAI-compatible API
//   uibridge login <provider>      sign in once, in a visible window
//   uibridge doctor [provider]     check Chrome, session, and UI contracts
//   uibridge ask <provider> "..."  one prompt, no server (quick check)
//   uibridge capture <provider>    dump DOM + network for one exchange
//
// `doctor` and `capture` are first-class commands, not scratch scripts,
// because UI drift is the standing risk here: when something breaks, the
// first question is always "which selector stopped matching?", and that
// deserves a real tool rather than a probe rewritten each time.

import { loadConfig, providerSettings, portFor } from '../src/core/config.mjs'
import { setLevel, logger } from '../src/core/log.mjs'
import { BridgeError } from '../src/core/errors.mjs'
import { attachBrowser } from '../src/core/chrome.mjs'
import { waitFor } from '../src/core/async.mjs'
import { Session } from '../src/session.mjs'
import { serve } from '../src/api/server.mjs'
import { providerClass, providerIds } from '../src/providers/registry.mjs'
import { captureExchange } from '../src/tools/capture.mjs'

const [, , cmd, ...rest] = process.argv
if (process.env.UIBRIDGE_LOG) setLevel(process.env.UIBRIDGE_LOG)

const cfg = loadConfig()
const log = logger('cli')

function usage(code = 0) {
  console.log(`
uibridge - a local OpenAI-compatible API backed by chat UIs you already pay for

  uibridge serve                      start the API (default port ${cfg.port})
  uibridge login <provider>           open a window and sign in
  uibridge doctor [provider]          verify Chrome, session and UI contracts
  uibridge ask <provider> "prompt"    single prompt, no server
  uibridge capture <provider> ["p"]   record DOM + network for one exchange

  providers: ${providerIds.join(', ')}
`)
  process.exit(code)
}

function requireProviderArg(name) {
  if (!name) usage(1)
  if (!providerClass(name)) {
    console.error(`Unknown provider "${name}". Known: ${providerIds.join(', ')}`)
    process.exit(1)
  }
  return name
}

/**
 * Open a visible window and wait for a REAL account.
 *
 * A rendered composer is not proof of sign-in - an anonymous session shows
 * one too, and requests then run against no account, which is how a whole
 * batch can come back subtly wrong. So this waits for an account marker and
 * says plainly what it is waiting for.
 */
async function login(id) {
  const Class = providerClass(id)
  const settings = providerSettings(cfg, id, Class.defaults)
  const url = Class.selectors.url
  const { ctx } = await attachBrowser({
    port: portFor(cfg, id, providerIds.indexOf(id)),
    userDataDir: settings.profileDir,
    headless: false,
    clipboardOrigins: [new URL(url).origin],
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  const provider = new Class({ selectors: Class.selectors, settings: { ...settings, url }, log })
  console.log(`\nA Chrome window is open on ${url}.`)
  console.log('Sign in there yourself - this tool never handles your password.')
  console.log('Waiting for a signed-in session...\n')

  let last = ''
  await waitFor(
    async () => {
      const ok = await provider.isSignedIn(page).catch(() => false)
      if (ok) return true
      const body = await page.locator('body').innerText().catch(() => '')
      const state = /unusual traffic|verify you|not a robot/i.test(body)
        ? 'waiting: a verification challenge is showing - please clear it'
        : 'waiting: not signed in yet'
      if (state !== last) console.log(`  ${state}`)
      last = state
      return null
    },
    { timeout: 15 * 60 * 1000, poll: 1500, what: 'you to sign in' }
  )
  console.log('\nSIGNED IN. The session is stored in the profile; you can close the window.')
  console.log('It persists across restarts - .profiles/ is gitignored because it holds it.')
}

/** Check the things that actually break, and name them. */
async function doctor(only) {
  const ids = only ? [requireProviderArg(only)] : providerIds
  let bad = 0
  for (const id of ids) {
    const Class = providerClass(id)
    const sel = Class.selectors
    console.log(`\n== ${id} ==`)
    if (sel.calibrated === false) {
      console.log('  selectors : NOT CALIBRATED (placeholders - see selectors.json)')
      bad++
      continue
    }
    let session
    try {
      session = await Session.open(id, { cfg })
      const signedIn = await session.signedIn()
      console.log(`  chrome    : ok (port ${portFor(cfg, id, providerIds.indexOf(id))})`)
      console.log(`  session   : ${signedIn ? 'signed in' : `SIGNED OUT - run: uibridge login ${id}`}`)
      if (!signedIn) bad++

      // The clipboard is a machine-global resource that can fail on its own,
      // and when it does, extraction quietly drops to a lower tier. Better to
      // see that here than to wonder later why tables lost their structure.
      const clip = await session.clipboardHealthy()
      console.log(
        `  clipboard : ${clip ? 'working (copy path available)' : 'UNAVAILABLE - extraction will use the DOM fallback'}`
      )

      const caps = session.capabilities
      console.log(`  models    : ${Object.keys(caps.models).join(', ') || '(none declared)'}`)
      console.log(`  modes     : ${Object.keys(caps.modes).join(', ') || '(none)'}`)
      console.log(
        `  features  : attachments=${caps.attachments} generatedFiles=${caps.generatedFiles} citations=${caps.citations}`
      )
      console.log(`  transports: ${caps.transports.join(', ')}`)
    } catch (e) {
      console.log(`  FAILED    : ${e.message.split('\n')[0]}`)
      bad++
    } finally {
      await session?.close().catch(() => {})
    }
  }
  console.log()
  process.exit(bad ? 1 : 0)
}

async function ask(id, prompt) {
  if (!prompt) usage(1)
  const session = await Session.open(id, { cfg })
  try {
    const r = await session.ask({ prompt })
    console.log(`\n${r.text}\n`)
    console.log(
      `--- ${r.elapsed_ms}ms | via ${r.extraction}` +
        (r.lossy_math ? ' | maths lossy (no LaTeX in the DOM)' : '') +
        ` | tables:${r.tables.length} code:${r.code_blocks.length}` +
        ` files:${r.files.length} browsed:${r.browsed} sources:${r.sources.length}`
    )
  } finally {
    await session.close()
  }
}

try {
  if (cmd === 'serve' || cmd === undefined) await serve(cfg)
  else if (cmd === 'login') await login(requireProviderArg(rest[0]))
  else if (cmd === 'doctor') await doctor(rest[0])
  else if (cmd === 'ask') await ask(requireProviderArg(rest[0]), rest.slice(1).join(' '))
  else if (cmd === 'capture') await captureExchange(cfg, requireProviderArg(rest[0]), rest.slice(1).join(' '))
  else usage(cmd === '-h' || cmd === '--help' ? 0 : 1)
} catch (e) {
  if (e instanceof BridgeError) {
    console.error(`\n${e.message}\n`)
    process.exit(1)
  }
  throw e
}

if (cmd !== 'serve' && cmd !== undefined) process.exit(0)
