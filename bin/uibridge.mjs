#!/usr/bin/env node
// uibridge CLI.
//
//   uibridge serve                 start the local OpenAI-compatible API
//   uibridge login <provider>      sign in once, in a visible window
//   uibridge logout <provider>     clear the bridge profile's site session
//   uibridge status [provider]     machine-friendly authentication state
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
import { mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
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
import { modelCatalogue } from '../src/providers/registry.mjs'
import { listThreads, readThreadEvents } from '../src/core/ledger.mjs'

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
  uibridge logout <provider>          clear the dedicated profile's site session
  uibridge status [provider] [--json] report authenticated profile state
  uibridge models [--json]            list callable model ids
  uibridge threads [provider] [--json] list locally recorded native threads
  uibridge thread <provider> <id>      show a thread's local file/turn ledger
  uibridge doctor [provider]          verify Chrome, session and UI contracts
  uibridge doctor <provider> --anon   prove signed-OUT is detected (throwaway profile)
  uibridge ask <provider> "prompt"    single prompt, no server
                                      [--file=path ...] [--model=id] [--thinking=on|off]
                                      [--thread=id] [--json]
  uibridge chat <provider>             persistent same-tab conversation
                                      [--thread=id] [--model=id] [--jsonl]
  uibridge export <provider> <id>      export a complete active thread branch
                                      [--output=path] [--json]
  uibridge capture <provider> ["p"]   record DOM + network for one exchange
                                      [--continue] reuses the open calibration thread
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
      if (v.state !== 'in') {
        bad++
        console.log(`  next      : uibridge login ${id}`)
        continue
      }

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

/** ask <provider> [--file=path ...] [--model=id] [--thinking=on|off] <prompt...> */
async function ask(id, args) {
  const files = []
  let model = null
  const modes = {}
  const words = []
  let json = false
  let threadId = null
  for (const a of args) {
    if (a.startsWith('--file=')) files.push(a.slice(7))
    else if (a.startsWith('--model=')) model = a.slice(8)
    else if (a.startsWith('--thinking=')) modes.thinking = a.slice(11) !== 'off'
    else if (a === '--json') json = true
    else if (a.startsWith('--thread=')) threadId = a.slice(9)
    else words.push(a)
  }
  const prompt = words.join(' ')
  if (!prompt) usage(1)
  // JSON mode is a real machine interface: informational logs belong
  // nowhere in stdout or they corrupt the document. Warnings/errors already
  // use stderr, so retain those.
  if (json) setLevel('warn')
  const session = await Session.open(id, { cfg })
  try {
    const r = await session.ask({ prompt, files, model, modes, threadId })
    if (json) {
      console.log(JSON.stringify(r, null, 2))
      return
    }
    console.log(`\n${r.text}\n`)
    console.log(
      `--- thread:${r.thread_id} | ${r.elapsed_ms}ms | via ${r.extraction}` +
        (r.lossy_math ? ' | maths lossy (no LaTeX in the DOM)' : '') +
        (r.truncated ? ' | TRUNCATED' : '') +
        ` | tables:${r.tables.length} code:${r.code_blocks.length}` +
        ` files:${r.files.length} browsed:${r.browsed} sources:${r.sources.length}` +
        (r.citations ? ` citations:${r.citations.length}` : '')
    )
    const p = r.provenance
    if (p.answered_by) console.log(`--- answered by ${p.answered_by}${p.sent_as ? ` (the page asked for ${p.sent_as})` : ''}`)
    if (p.final_state) console.log(`--- picker after setup: ${p.final_state}`)
    if (p.model) console.log(`--- model: requested ${p.model.requested}, ${p.model.verified ? 'verified' : 'NOT verified'} (${p.model.note})`)
    for (const c of r.citations ?? []) console.log(`    @${c.at}  ${c.url}`)
    for (const f of r.files ?? []) {
      console.log(f.error ? `    FILE FAILED ${f.name}: ${f.error}` : `    file ${f.name}  ${f.bytes ?? '?'} bytes  ${f.mime ?? ''}  -> ${f.path}`)
    }
    if (r.throttle_notice) console.log(`--- the site is rate-limiting: ${r.throttle_notice}`)
    if (r.ledger?.path) console.log(`--- ledger: ${r.ledger.path}`)
    if (r.ledger?.error) console.log(`--- ledger warning: ${r.ledger.error}`)
  } finally {
    await session.close()
  }
}

function chatOptions(args) {
  const options = { model: null, threadId: null, modes: {}, files: [], jsonl: args.includes('--jsonl') || !process.stdin.isTTY }
  for (const a of args) {
    if (a.startsWith('--model=')) options.model = a.slice(8)
    else if (a.startsWith('--thread=')) options.threadId = a.slice(9)
    else if (a.startsWith('--thinking=')) options.modes.thinking = a.slice(11) !== 'off'
    else if (a.startsWith('--file=')) options.files.push(a.slice(7))
  }
  return options
}

/** Persistent REPL/JSONL mode: one Session and therefore one recycled tab. */
async function chat(id, args) {
  const options = chatOptions(args)
  if (options.jsonl) setLevel('warn')
  const session = await Session.open(id, { cfg })
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
  let threadId = options.threadId
  let first = true
  const run = async (prompt) => {
    if (!prompt.trim()) return
    const result = await session.ask({
      prompt, threadId, model: options.model, modes: options.modes,
      files: first ? options.files : [],
    })
    first = false
    threadId = result.thread_id
    if (options.jsonl) console.log(JSON.stringify(result))
    else {
      console.log(`\n${result.text}\n`)
      console.log(`--- thread:${threadId} | ${result.elapsed_ms}ms | files:${result.files.length}${result.truncated ? ' | TRUNCATED' : ''}\n`)
    }
  }
  try {
    if (process.stdin.isTTY) {
      console.log(`Persistent ${id} chat${threadId ? ` on ${threadId}` : ''}. Type /exit to stop.`)
      while (true) {
        const prompt = await rl.question('> ')
        if (prompt.trim() === '/exit') break
        await run(prompt)
      }
    } else {
      for await (const line of rl) await run(line)
    }
  } finally {
    rl.close()
    await session.close()
  }
}

async function exportThread(id, args) {
  const positional = args.filter((a) => !a.startsWith('--'))
  const threadId = positional[0]
  if (!threadId) usage(1)
  const json = args.includes('--json')
  if (json) setLevel('warn')
  const requestedPath = args.find((a) => a.startsWith('--output='))?.slice(9)
  const session = await Session.open(id, { cfg })
  try {
    const data = await session.exportThread(threadId)
    const path = resolve(requestedPath ?? resolve(ROOT, cfg.exportDir, id, `${threadId}.json`))
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
    if (json) console.log(JSON.stringify({ path, ...data }, null, 2))
    else console.log(`${id} thread ${threadId}: ${data.messages.length} messages, complete=${data.complete}\n${path}`)
  } finally { await session.close() }
}

async function threads(args) {
  const json = args.includes('--json')
  const provider = args.find((a) => !a.startsWith('--')) ?? null
  if (provider) requireProviderArg(provider)
  const rows = await listThreads(resolve(ROOT, cfg.ledgerDir), provider)
  if (json) return console.log(JSON.stringify(rows, null, 2))
  if (!rows.length) return console.log('No locally recorded threads yet.')
  for (const row of rows) console.log(`${row.provider}\t${row.thread_id}\t${row.turns} turn(s)\t${row.updated_at}`)
}

function thread(args) {
  const provider = requireProviderArg(args.find((a) => !a.startsWith('--')))
  const positional = args.filter((a) => !a.startsWith('--'))
  const threadId = positional[1]
  if (!threadId) usage(1)
  const record = readThreadEvents(resolve(ROOT, cfg.ledgerDir), provider, threadId)
  if (args.includes('--json')) return console.log(JSON.stringify(record, null, 2))
  if (!record.events.length) return console.log(`No local ledger for ${provider} thread ${threadId}.`)
  console.log(`${provider} thread ${threadId}\n${record.path}`)
  for (const event of record.events) {
    console.log(`\n${event.at}  request ${event.request_id}${event.result?.truncated ? '  TRUNCATED' : ''}`)
    for (const f of event.inputs ?? []) console.log(`  sent       ${f.bytes} bytes  ${f.sha256}  ${f.path}`)
    for (const f of event.outputs ?? []) console.log(f.error ? `  download failed  ${f.name}: ${f.error}` : `  downloaded ${f.bytes} bytes  ${f.sha256}  ${f.path}`)
  }
}

/** Clear only the selected provider's dedicated browser profile session. */
async function logout(id) {
  const Class = providerClass(id)
  const settings = providerSettings(cfg, id, Class.defaults)
  const { ctx } = await attachBrowser({
    port: portFor(cfg, id, providerIds.indexOf(id)),
    userDataDir: settings.profileDir,
    headless: false,
  })
  const origin = new URL(Class.selectors.url).origin
  await ctx.clearCookies()
  for (const page of ctx.pages()) {
    if (!page.url().startsWith(origin)) continue
    await page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    }).catch(() => {})
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  }
  console.log(`${id}: dedicated uibridge session cleared`)
}

async function status(only, json = false) {
  const ids = only ? [requireProviderArg(only)] : providerIds
  const out = {}
  for (const id of ids) {
    const session = await Session.open(id, { cfg })
    try {
      const verdict = await session.sessionState()
      out[id] = {
        state: verdict.state,
        authenticated: verdict.state === 'in',
        authority: verdict.authority,
        because: verdict.because ?? [],
        action: verdict.state === 'in' ? null : `uibridge login ${id}`,
      }
    } finally {
      await session.close()
    }
  }
  if (json) console.log(JSON.stringify(out, null, 2))
  else {
    for (const [id, v] of Object.entries(out)) {
      console.log(`${id}: ${v.authenticated ? 'authenticated' : v.state}`)
      console.log(`  ${v.authority}`)
      if (v.action) console.log(`  action: ${v.action}`)
    }
  }
  if (Object.values(out).some((v) => !v.authenticated)) process.exitCode = 1
}

try {
  if (cmd === 'serve' || cmd === undefined) await serve(cfg)
  else if (cmd === 'login') await login(requireProviderArg(rest[0]))
  else if (cmd === 'logout') await logout(requireProviderArg(rest[0]))
  else if (cmd === 'status') {
    const only = rest.find((a) => !a.startsWith('--'))
    await status(only, rest.includes('--json'))
  }
  else if (cmd === 'models') {
    const ids = modelCatalogue().map((m) => m.id)
    console.log(rest.includes('--json') ? JSON.stringify(ids, null, 2) : ids.join('\n'))
  }
  else if (cmd === 'threads') await threads(rest)
  else if (cmd === 'thread') thread(rest)
  else if (cmd === 'doctor') {
    // --anon proves the check fires the OTHER way: a signal that has only
    // ever been seen succeed has not been tested.
    if (rest.includes('--anon')) {
      const ok = await checkAnonymousDetection(requireProviderArg(rest.find((a) => !a.startsWith('--'))))
      process.exit(ok ? 0 : 1)
    }
    await doctor(rest[0])
  }
  else if (cmd === 'ask') await ask(requireProviderArg(rest[0]), rest.slice(1))
  else if (cmd === 'chat') await chat(requireProviderArg(rest[0]), rest.slice(1))
  else if (cmd === 'export') await exportThread(requireProviderArg(rest[0]), rest.slice(1))
  else if (cmd === 'capture') {
    const continueConversation = rest.includes('--continue')
    const prompt = rest.slice(1).filter((a) => a !== '--continue').join(' ')
    await captureExchange(cfg, requireProviderArg(rest[0]), prompt, { continueConversation })
  }
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
