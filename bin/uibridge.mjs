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

import { loadConfig, providerSettings, portFor, ROOT } from '../src/core/config.mjs'
import { resolve } from 'node:path'
import { setLevel, logger } from '../src/core/log.mjs'
import { BridgeError } from '../src/core/errors.mjs'
import { attachBrowser } from '../src/core/chrome.mjs'
import { waitFor } from '../src/core/async.mjs'
import { Session } from '../src/session.mjs'
import { serve } from '../src/api/server.mjs'
import { providerClass, providerIds } from '../src/providers/registry.mjs'
import { captureExchange } from '../src/tools/capture.mjs'
import { reconObserve, reconExchange } from '../src/tools/recon.mjs'

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
  uibridge recon observe <url>        describe an UNKNOWN site: DOM + network
  uibridge recon exchange <url> ...   drive one turn there and record the wire

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
      // A scaffolded provider is a STATE, not a fault: it is not advertised
      // by /v1/models and cannot be called by accident. Counting it as a
      // failure made `doctor` exit non-zero on a perfectly healthy install,
      // which is exactly the kind of false alarm that gets a check ignored.
      console.log('  selectors : not calibrated yet - scaffold only, not advertised')
      console.log(`              to bring it up: uibridge capture ${id}`)
      if (only) bad++
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

/**
 * RECON: point it at a URL, not a provider.
 *
 * Deliberately outside the provider registry: its whole purpose is to work
 * on a site nothing is known about yet, which is exactly the situation
 * `capture` cannot serve because capture needs the selectors we are trying
 * to learn. Flags are --key=value; --profile picks which Chrome profile
 * (i.e. which signed-in session) to look through.
 */
async function recon(argv) {
  const [phase, url, ...flags] = argv
  const opts = Object.fromEntries(
    flags
      .filter((f) => f.startsWith('--'))
      .map((f) => {
        const i = f.indexOf('=')
        return i === -1 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]
      })
  )
  if (!url) {
    console.error('usage: uibridge recon observe|exchange <url> [--profile=chatgpt] [--composer=sel] [--send=sel] [--turns=sel] [--prompt=...]')
    process.exit(1)
  }
  // ABSOLUTE. Chrome resolves a relative --user-data-dir against its own
  // working directory, not ours, and then simply never opens the debugging
  // port - which surfaces as "Chrome failed to start" with no clue why.
  const profile = resolve(ROOT, cfg.profileDir, opts.profile ?? new URL(url).host.split('.')[0])
  const port = Number(opts.port ?? 9400)
  if (phase === 'observe') await reconObserve(cfg, url, { port, profile })
  else if (phase === 'exchange') await reconExchange(cfg, url, { ...opts, port, profile })
  else {
    console.error('recon phase must be "observe" or "exchange"')
    process.exit(1)
  }
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
  else if (cmd === 'recon') await recon(rest)
  else usage(cmd === '-h' || cmd === '--help' ? 0 : 1)
} catch (e) {
  if (e instanceof BridgeError) {
    console.error(`\n${e.message}\n`)
    process.exit(1)
  }
  throw e
}

if (cmd !== 'serve' && cmd !== undefined) process.exit(0)
