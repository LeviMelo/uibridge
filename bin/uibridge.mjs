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
import { awaitSignIn } from '../src/core/signin.mjs'
import { checkAnonymousDetection } from '../src/tools/anoncheck.mjs'
import { signedOutMessage, sessionState } from '../src/core/auth.mjs'

const nlLiteral = String.fromCharCode(10)

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
  uibridge doctor <provider> --anon   prove signed-OUT is detected (throwaway profile)
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
 * Sign in: a guided flow, not a window that appears and hopes.
 *
 * The person this is aimed at is looking at Chrome, not at this terminal, so
 * the instructions are painted INTO the page as well as printed here, the
 * window opens on the provider's real page rather than a blank tab, and the
 * banner turns green and names the account when detection flips. Everything
 * about it is designed so that "what is this window and what do I do with it"
 * never has to be asked.
 *
 * Works on an uncalibrated provider on purpose: signing in has to come BEFORE
 * calibration, since the signed-out site is a different application and
 * calibrating against it would record the wrong selectors.
 */
async function login(id) {
  const Class = providerClass(id)
  const settings = providerSettings(cfg, id, Class.defaults)
  const url = Class.selectors.url
  const auth = Class.selectors.auth ?? {}

  const { ctx } = await attachBrowser({
    port: portFor(cfg, id, providerIds.indexOf(id)),
    userDataDir: settings.profileDir,
    headless: false,
    clipboardOrigins: [new URL(url).origin],
  })
  // One tab, not a pile of them. Earlier runs left a blank window per
  // attempt, which is how a sign-in prompt turns into visual noise the user
  // learns to close.
  const pages = ctx.pages()
  const page = pages[0] ?? (await ctx.newPage())
  for (const p of pages.slice(1)) await p.close().catch(() => {})

  console.log(`
  Signing in to ${id}
  ------------------------------------------------------------------
  A Chrome window is opening on ${url}.
  It belongs to uibridge and shows a blue banner explaining itself.

    1. Sign in there with your own account, as you normally would.
    2. Leave the window open; this detects the session by itself.
    3. The banner turns green when it is done.

  uibridge never sees or types your password. The session is stored in
  this browser profile (${settings.profileDir}) and persists across
  restarts, so this is a one-time step.
`)

  const verdict = await awaitSignIn({ page, providerId: id, url, auth, log })

  if (verdict.state === 'in') {
    console.log(`
  SIGNED IN.
  Proven by: ${verdict.authority}
${(verdict.because ?? []).map((b) => `    - ${b}`).join(nlLiteral)}

  You can close the window. Next: node bin/uibridge.mjs doctor ${id}
`)
    // The cookie jar is how a session is proven on the next run, so record
    // what is actually there. On a provider whose auth block was written
    // from a signed-OUT page, this is the measurement that confirms or
    // corrects it - rather than leaving a guess in place that happens to
    // work today.
    const named = (verdict.evidence?.cookies ?? []).filter((c) => c.httpOnly && c.chars > 20)
    if (named.length) {
      console.log(`  httpOnly cookies now in this profile (candidates for auth.authCookiePattern):`)
      console.log(`    ${named.map((c) => c.name).join(', ')}
`)
    }
    process.exit(0)
  }

  console.log(`
  NOT signed in yet - ${verdict.authority}.
  Nothing was changed. Run this again when you are ready:
      node bin/uibridge.mjs login ${id}
`)
  process.exit(1)
}

/**
 * Print a session verdict the way a person needs to read it: the state, what
 * proved it, and - when it is bad news - the one command that fixes it.
 */
function printSession(v) {
  const line = {
    in: 'signed in',
    anonymous: 'SIGNED OUT (the site is serving its anonymous app)',
    challenge: 'BLOCKED by a verification challenge - clear it yourself in the window',
    unknown: 'UNKNOWN - treated as signed out',
  }[v.state ?? 'unknown']
  console.log(`  session   : ${line}`)
  console.log(`              why: ${v.authority}`)
  for (const b of v.because ?? []) console.log(`                   ${b}`)
}

/** Session state for a provider we cannot fully open (e.g. uncalibrated). */
async function peekSession(id, sel) {
  const settings = providerSettings(cfg, id, providerClass(id).defaults)
  const { ctx } = await attachBrowser({
    port: portFor(cfg, id, providerIds.indexOf(id)),
    userDataDir: settings.profileDir,
    headless: false,
    clipboardOrigins: [new URL(sel.url).origin],
  })
  const pages = ctx.pages()
  const page = pages[0] ?? (await ctx.newPage())
  for (const p of pages.slice(1)) await p.close().catch(() => {})
  if (!page.url().startsWith(new URL(sel.url).origin)) {
    await page.goto(sel.url, { waitUntil: 'domcontentloaded' }).catch(() => {})
  }
  return sessionState(page, sel.auth ?? {})
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
      // Session state is still reported, because sign-in comes BEFORE
      // calibration: the signed-out site is a different application, and
      // calibrating against it records the wrong selectors.
      const v = await peekSession(id, sel).catch((e) => ({ state: 'unknown', authority: e.message.split(nlLiteral)[0], because: [] }))
      printSession(v)
      console.log(`  next      : ${v.state === 'in' ? `uibridge capture ${id}` : `uibridge login ${id}`}`)
      if (only) bad++
      continue
    }
    let session
    try {
      session = await Session.open(id, { cfg })
      const v = await session.sessionState()
      console.log(`  chrome    : ok (port ${portFor(cfg, id, providerIds.indexOf(id))})`)
      printSession(v)
      if (v.state !== 'in') bad++

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
  else if (cmd === 'doctor') {
    // --anon proves the check fires the OTHER way: a signal that has only
    // ever been seen succeed has not been tested.
    if (rest.includes('--anon')) {
      const ok = await checkAnonymousDetection(requireProviderArg(rest.find((a) => !a.startsWith('--'))))
      process.exit(ok ? 0 : 1)
    }
    await doctor(rest[0])
  }
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
