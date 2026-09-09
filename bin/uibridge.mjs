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

import { loadConfig, providerSettings, portFor, ROOT, HOME, VERSION } from '../src/core/config.mjs'
import { resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { setLevel, logger } from '../src/core/log.mjs'
import { BridgeError } from '../src/core/errors.mjs'
import { attachBrowser } from '../src/core/chrome.mjs'
import { waitFor } from '../src/core/async.mjs'
import { ensureDaemon, daemonPost, rawHealth, daemonHealth, flatten } from '../src/core/client.mjs'
import { identify, isUibridge } from '../src/core/protocol.mjs'
import { Session } from '../src/session.mjs'
import { serve } from '../src/api/server.mjs'
import { providerClass, providerIds, modelCatalogue } from '../src/providers/registry.mjs'
import { captureExchange } from '../src/tools/capture.mjs'
import { reconObserve, reconExchange } from '../src/tools/recon.mjs'
import { awaitSignIn } from '../src/core/signin.mjs'
import { checkAnonymousDetection } from '../src/tools/anoncheck.mjs'
import { signedOutMessage, sessionState } from '../src/core/auth.mjs'
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
  uibridge ask <provider> "prompt" [--key=ID]  durable prompt via daemon
                                      [--file=path ...] [--model=id] [--thinking=on|off]
                                      [--thread=id] [--json]
  uibridge request status|recover|cancel <key> [--json]
  uibridge profiles [--json]         saved locations and last successful use
  uibridge chat <provider>             persistent same-tab conversation
                                      [--thread=id] [--model=id] [--thinking=on|off]
                                      [--file=path ...] [--jsonl]
                                      in the chat: /new  /thread  /help  /exit
  uibridge stop                       stop the background uibridge (restart after code changes)
  uibridge paths [--json]             where config, profiles, downloads and logs live
  uibridge --version                  print the version and exit
  uibridge autostart [--remove|--status]  run uibridge at logon (Windows task)
  uibridge export <provider> <id>      export a complete active thread branch
  uibridge export <provider> <id> --files  ...and download every file it generated
                                      [--output=path] [--json]
  uibridge capture <provider> ["p"]   record DOM + network for one exchange
                                      [--continue] reuses the open calibration thread
  uibridge recon observe <url>        describe an UNKNOWN site: DOM + network
  uibridge recon exchange <url> ...   drive one turn there and record the wire

  providers: ${providerIds.join(', ')}
`)
  process.exit(code)
}

/**
 * Flags that carry a value, and therefore MUST be written `--flag=value`.
 *
 * Checking only the NAME left the original defect alive in its other half:
 * `--model` is a known flag, so `ask echo --model echo-fast hello` passed
 * validation, and the per-command parsers match only `--model=`, so both the
 * flag and its value fell through to `words.push(a)`. Measured: that command
 * exited 0 having sent the model the literal prompt
 * "--model echo-fast hello", with `provenance.model: null`. The same shape
 * made `export --output path.json` write to the default location and say
 * nothing. A tool used to produce data must never quietly do something other
 * than what the command line said.
 */
const VALUED_FLAGS = ['--file', '--model', '--thinking', '--thread', '--key', '--output']

/**
 * Reject flags this command does not have, and values written with a space.
 *
 * A tool used to produce data must never quietly do something other than
 * what the command line said. Measured here: `export ... --out file.json`
 * (the flag is `--output=`) wrote to the default location and said nothing,
 * and in `ask` an unrecognised flag was swept into the PROMPT and sent to
 * the model. Both look like success.
 */
function checkFlags(args, allowed, command) {
  const naked = args.filter((a) => VALUED_FLAGS.includes(a) && allowed.includes(a))
  if (naked.length) {
    throw new BridgeError(
      `${command}: ${naked.join(', ')} needs its value attached, as ${naked[0]}=VALUE. ` +
        'Written with a space, the value would have been read as part of the prompt.',
      { code: 'invalid_request', status: 400 }
    )
  }
  const bad = args
    .filter((a) => a.startsWith('--') && a !== '--')
    .map((a) => a.split('=')[0])
    .filter((f) => !allowed.includes(f))
  if (!bad.length) return
  const near = (f) => allowed.find((a) => a.startsWith(f.slice(0, 4)) || f.startsWith(a.slice(0, 4)))
  throw new BridgeError(
    `${command}: unknown option ${bad.join(', ')}.` +
      (near(bad[0]) ? ` Did you mean ${near(bad[0])}?` : '') +
      ` Accepted here: ${allowed.join(' ')}`,
    { code: 'invalid_request', status: 400 }
  )
}

/**
 * `--thinking=on|off`, with ONE meaning across every command.
 *
 * `ask` rejected anything else; `chat` used `!== 'off'`, so `--thinking=yes`
 * silently turned thinking ON and `--thinking=0` silently turned it on too.
 * Two contracts for one flag is how a run ends up recorded under settings
 * nobody chose.
 */
function parseThinking(value) {
  if (!['on', 'off'].includes(value)) {
    throw new BridgeError('--thinking must be on or off', { code: 'invalid_request', status: 400 })
  }
  return value === 'on'
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
    // ALWAYS HEADED: a human types here. Never inherit cfg.headless.
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
    // ALWAYS HEADED: a human types here. Never inherit cfg.headless.
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
  const profile = resolve(HOME, cfg.profileDir, opts.profile ?? new URL(url).host.split('.')[0])
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
  checkFlags(args, ['--file', '--model', '--thinking', '--json', '--thread', '--key', '--local'], 'ask')
  const words = []
  let json = false
  let threadId = null
  let key = null
  for (const a of args) {
    if (a.startsWith('--file=')) files.push(a.slice(7))
    else if (a.startsWith('--model=')) model = a.slice(8)
    else if (a.startsWith('--thinking=')) {
      modes.thinking = parseThinking(a.slice(11))
    }
    else if (a === '--json') json = true
    else if (a.startsWith('--thread=')) threadId = a.slice(9)
    else if (a.startsWith('--key=')) key = a.slice(6)
    else if (a === '--local') continue
    else words.push(a)
  }
  const prompt = words.join(' ')
  if (!prompt) usage(1)
  if (args.includes('--local') && key) throw new BridgeError('--key requires the daemon; remove --local', { code: 'invalid_request', status: 400 })
  // JSON mode is a real machine interface: informational logs belong
  // nowhere in stdout or they corrupt the document. Warnings/errors already
  // use stderr, so retain those.
  if (json) setLevel('warn')

  // Prefer a running uibridge: its browser is already warm and it is the
  // only process that may drive that Chrome profile. Starting a cold one
  // per turn was costing ~40s and colliding with `serve`.
  const daemon = args.includes('--local') ? null : await ensureDaemon(cfg, { log: logger('cli') })
  if (daemon) {
    key ??= `cli-${randomUUID()}`
    console.error(`Request key: ${key}\nRecover: uibridge request recover ${key} --json`)
  }
  const r = daemon
    ? flatten(
        await daemonPost(`${daemon.base}/v1/chat/completions`, {
          model: model ?? id,
          messages: [{ role: 'user', content: prompt }],
          files,
          modes,
          thread_id: threadId,
        }, { headers: { 'Idempotency-Key': key } })
      )
    : null
  const session = daemon ? null : await Session.open(id, { cfg })
  try {
    const result = r ?? (await session.ask({ prompt, files, model, modes, threadId }))
    await printAsk(result, json)
  } finally {
    await session?.close()
  }
}

async function printAsk(r, json) {
  {
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
  }
}

function chatOptions(args) {
  checkFlags(args, ['--model', '--thread', '--thinking', '--file', '--jsonl', '--local'], 'chat')
  const options = { model: null, threadId: null, modes: {}, files: [], jsonl: args.includes('--jsonl') || !process.stdin.isTTY }
  for (const a of args) {
    if (a.startsWith('--model=')) options.model = a.slice(8)
    else if (a.startsWith('--thread=')) options.threadId = a.slice(9)
    else if (a.startsWith('--thinking=')) options.modes.thinking = parseThinking(a.slice(11))
    else if (a.startsWith('--file=')) options.files.push(a.slice(7))
  }
  return options
}

/** Persistent REPL/JSONL mode: one Session and therefore one recycled tab. */
async function chat(id, args) {
  const options = chatOptions(args)
  if (options.jsonl) setLevel('warn')
  // Same reason as `ask`: one process may drive a given Chrome profile, and
  // the daemon's tab is already warm and already signed in.
  const daemon = args.includes('--local') ? null : await ensureDaemon(cfg, { log: logger('cli') })
  const session = daemon ? null : await Session.open(id, { cfg })
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
  let threadId = options.threadId
  let first = true
  // The recovery key is printed only when it is USEFUL - i.e. when the turn
  // failed. Announcing it before every message turns a conversation into a
  // wall of bookkeeping.
  let lastKey = null
  const run = async (prompt) => {
    if (!prompt.trim()) return
    const files = first ? options.files : []
    const key = `cli-${randomUUID()}`
    lastKey = daemon ? key : null
    const result = daemon
      ? flatten(
          await daemonPost(`${daemon.base}/v1/chat/completions`, {
            model: options.model ?? id,
            messages: [{ role: 'user', content: prompt }],
            files,
            modes: options.modes,
            thread_id: threadId,
          }, { headers: { 'Idempotency-Key': key } })
        )
      : await session.ask({ prompt, threadId, model: options.model, modes: options.modes, files })
    first = false
    threadId = result.thread_id
    if (options.jsonl) console.log(JSON.stringify(result))
    else {
      await printAsk(result, false)
    }
  }
  // A FAILED TURN MUST NOT END THE CONVERSATION. Measured 2026-09-09: a
  // single 502 mid-session aborted the loop, the remaining input was never
  // sent, and the thread being built was lost - in a chat, of all places,
  // where the whole point is that the context accumulates. A chat UI does not
  // close itself because one message failed, and neither does this.
  //
  // The failure is still REPORTED: printed on stderr, emitted as a JSONL
  // record for a machine consumer, and remembered so the process can exit
  // non-zero at the end.
  let failed = 0
  const turn = async (prompt) => {
    try {
      await run(prompt)
    } catch (err) {
      failed++
      const message = err?.message ?? String(err)
      if (options.jsonl) console.log(JSON.stringify({ error: { message, type: err?.code ?? 'error', retryable: err?.retryable ?? false }, thread_id: threadId, request_key: lastKey }))
      const hints = []
      if (threadId) hints.push(`The conversation is still open on thread ${threadId}.`)
      if (lastKey) hints.push(`If that turn landed anyway, read it back with: uibridge request recover ${lastKey} --json`)
      console.error(['', message, ...hints, ''].join('\n'))
    }
  }

  // Under --jsonl, stdout is a machine's input and must stay one JSON document
  // per line; the conversation's own chatter belongs on stderr, where the
  // operator still sees it and no parser has to skip it.
  const say = (text) => (options.jsonl ? console.error(text) : console.log(text))
  const commands = {
    '/exit': () => 'stop',
    '/quit': () => 'stop',
    '/new': () => { threadId = null; first = true; say('Starting a new conversation.') },
    '/thread': () => say(threadId ? `thread ${threadId}  (resume later: uibridge chat ${id} --thread=${threadId})` : 'no thread yet - send a message first'),
    '/help': () => say('/new  start a fresh conversation   /thread  show this thread id   /exit  leave'),
  }

  // ONE LOOP FOR BOTH. A piped session is the same conversation as a typed
  // one, so `/new` means the same thing in a heredoc as it does at a prompt -
  // and, more to the point, is never mistaken for something to SEND.
  const handle = async (line) => {
    const command = commands[line.trim()]
    if (!command) return await turn(line)
    return command()
  }

  // Ctrl-D closes stdin and Ctrl-C interrupts; either must leave through the
  // `finally` below, or a --local run abandons a live browser context. An
  // abort signal turns both into a normal end of loop.
  const ended = new AbortController()
  rl.on('close', () => ended.abort())
  const bye = () => { if (threadId) say(`\nthread ${threadId} - resume with: uibridge chat ${id} --thread=${threadId}`) }

  try {
    if (process.stdin.isTTY) {
      console.log(`Persistent ${id} chat${threadId ? ` on ${threadId}` : ''}. /help for commands, /exit to stop.`)
      while (true) {
        let line
        try {
          line = await rl.question('> ', { signal: ended.signal })
        } catch {
          break
        }
        if (await handle(line) === 'stop') break
      }
      bye()
    } else {
      for await (const line of rl) if (await handle(line) === 'stop') break
    }
  } finally {
    rl.close()
    await session?.close()
  }
  if (failed) process.exitCode = 1
}

async function exportThread(id, args) {
  checkFlags(args, ['--json', '--output', '--files', '--local'], 'export')
  const positional = args.filter((a) => !a.startsWith('--'))
  const threadId = positional[0]
  if (!threadId) usage(1)
  const json = args.includes('--json')
  if (json) setLevel('warn')
  const requestedPath = args.find((a) => a.startsWith('--output='))?.slice(9)
  const wantFiles = args.includes('--files')
  const daemon = args.includes('--local') ? null : await ensureDaemon(cfg, { log: logger('cli') })
  const session = daemon ? null : await Session.open(id, { cfg })
  try {
    const data = daemon
      ? await daemonPost(`${daemon.base}/v1/threads/export`, { provider: id, thread_id: threadId, files: wantFiles })
      : await session.exportThread(threadId, { files: wantFiles })
    const path = resolve(requestedPath ?? resolve(HOME, cfg.exportDir, id, `${threadId}.json`))
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
    if (json) console.log(JSON.stringify({ path, ...data }, null, 2))
    else {
      console.log(`${id} thread ${threadId}: ${data.messages.length} messages, complete=${data.complete}`)
      for (const f of data.files ?? []) {
        console.log(f.error ? `  file ${f.name}: ${f.error}` : `  file ${f.name} -> ${f.path} (${f.bytes} bytes)`)
      }
      if (data.files_skipped) console.log(`  files: ${data.files_skipped}`)
      console.log(path)
    }
  } finally { await session?.close() }
}

/** Stop a running uibridge. Code changes need a restart to take effect. */
/**
 * Where everything lives. Asked often enough - and after a global install
 * the answer is not "next to the code" - that guessing it is worse than
 * printing it.
 */
function paths(args) {
  const rows = {
    code: ROOT,
    home: HOME,
    config: resolve(HOME, 'config.json'),
    profiles: resolve(HOME, cfg.profileDir),
    downloads: resolve(HOME, cfg.downloadDir),
    ledger: resolve(HOME, cfg.ledgerDir),
    exports: resolve(HOME, cfg.exportDir),
    daemon_log: resolve(HOME, '.uibridge', 'daemon.log'),
    base_url: `http://${cfg.host}:${cfg.port}/v1`,
  }
  if (args.includes('--json')) return console.log(JSON.stringify(rows, null, 2))
  for (const [k, v] of Object.entries(rows)) console.log(`${k.padEnd(11)}: ${v}`)
  console.log(`\nSet UIBRIDGE_HOME to keep state somewhere else.`)
}

/**
 * Run uibridge at logon, so any program on this machine can just call it.
 *
 * A Scheduled Task rather than a Startup shortcut: it survives without a
 * console window, restarts cleanly, and can be inspected and removed by
 * name. The task runs `serve`, which opens no browser until the first
 * request arrives.
 */
async function autostart(args) {
  const name = 'uibridge'
  const cmd = `"${process.execPath}" "${resolve(ROOT, 'bin', 'uibridge.mjs')}" serve`
  const run = async (a) => {
    const { spawn } = await import('node:child_process')
    return new Promise((res) => {
      const p = spawn('schtasks', a, { windowsHide: true })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (out += d))
      p.on('close', (code) => res({ code, out: out.trim() }))
    })
  }

  if (process.platform !== 'win32') {
    console.log(
      'Automatic start is wired for Windows only.\n' +
        'On Linux/macOS, run this at login with your own supervisor, e.g. a systemd user unit:\n\n' +
        `  ExecStart=${cmd}\n`
    )
    return
  }

  if (args.includes('--remove')) {
    const r = await run(['/Delete', '/TN', name, '/F'])
    console.log(r.code === 0 ? `Removed the "${name}" logon task.` : r.out)
    return
  }
  if (args.includes('--status')) {
    const r = await run(['/Query', '/TN', name])
    console.log(r.code === 0 ? r.out : `No "${name}" logon task is installed.`)
    return
  }
  // /RL LIMITED, not HIGHEST: this drives a browser as you, and asking for
  // elevation for that would be both unnecessary and a bad habit.
  const r = await run(['/Create', '/TN', name, '/TR', cmd, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'])
  if (r.code !== 0) return console.log(`Could not create the logon task:\n${r.out}`)
  console.log(
    `uibridge will start at logon.\n` +
      `  task    : ${name}  (uibridge autostart --status | --remove)\n` +
      `  runs    : ${cmd}\n` +
      `  api     : http://${cfg.host}:${cfg.port}/v1\n` +
      `It opens no browser until the first request arrives.`
  )
}

async function stopDaemon() {
  // Identity first: /health is not proof of being us, and shutting down
  // whatever unrelated service happens to hold the port would be worse than
  // doing nothing.
  const kind = identify(await rawHealth(cfg))
  if (kind === 'absent') return console.log(`No uibridge listening on ${cfg.host}:${cfg.port}.`)
  if (!isUibridge(kind)) {
    return console.log(`Port ${cfg.port} is held by something that is not uibridge. Leaving it alone.`)
  }
  if (kind !== 'ours') console.log(`Stopping a uibridge from an older build (${kind}).`)
  await fetch(`http://${cfg.host}:${cfg.port}/admin/shutdown`, { method: 'POST' }).catch(() => {})

  // WAIT UNTIL IT IS ACTUALLY GONE. Shutdown is asynchronous - the daemon
  // closes its browser first, and gives that up to five seconds - so
  // returning as soon as the request is accepted made `uibridge stop` a lie
  // for the moment that matters most: the very next command would find the
  // port still held and reuse the daemon running the OLD code, which is
  // exactly the situation `stop` exists to prevent.
  for (let i = 0; i < 120; i++) {
    if (identify(await rawHealth(cfg, 300)) === 'absent') {
      return console.log(`Stopped the uibridge on ${cfg.host}:${cfg.port}. Its browser tabs close with it.`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(
    `The uibridge on ${cfg.host}:${cfg.port} accepted the stop but is still listening after 12s. ` +
      'Something is holding it; check .uibridge/daemon.log.'
  )
}

/**
 * The ledger, read through the daemon when one is listening.
 *
 * Both paths call the SAME core/ledger.mjs - there is no second
 * implementation - but the daemon owns the state directory while it runs,
 * and asking it means the CLI and an HTTP caller can never disagree about
 * what was recorded.
 */
/**
 * Ask the daemon, if one of this build is listening; otherwise null.
 *
 * Used for read-only state that both sides derive from the same module. It
 * deliberately does NOT start a daemon: listing a local ledger should not
 * launch a service, and when nothing is running there is nobody else who
 * could be holding a different view of the state directory.
 *
 * A typed failure from the daemon (a 404 for an unknown thread, say) is a
 * real answer and is re-thrown - only "there is no daemon" falls back.
 */
async function viaDaemon(path, body, pick) {
  // ASK THE SAME QUESTION `ask` ASKS. This used to test only "is a uibridge
  // listening", skipping the state-directory comparison that lives in
  // daemonHealth - so with a daemon serving home A, `threads`/`thread` run
  // under UIBRIDGE_HOME=B returned A's ledger rows and A's file paths, exit
  // 0, while `ask` under B correctly refused. Reading another home's history
  // and calling it yours is the quiet kind of wrong.
  const live = await daemonHealth(cfg).catch((e) => {
    if (e?.code === 'daemon_other_home') throw e
    return null
  })
  if (!live) return null
  return pick(await daemonPost(`http://${cfg.host}:${cfg.port}${path}`, body))
}

async function threads(args) {
  checkFlags(args, ['--json'], 'threads')
  const json = args.includes('--json')
  const provider = args.find((a) => !a.startsWith('--')) ?? null
  if (provider) requireProviderArg(provider)
  const rows = await viaDaemon(`/v1/threads/list`, { provider }, (r) => r.threads)
    ?? await listThreads(resolve(HOME, cfg.ledgerDir), provider)
  if (json) return console.log(JSON.stringify(rows, null, 2))
  if (!rows.length) return console.log('No locally recorded threads yet.')
  for (const row of rows) console.log(`${row.provider}\t${row.thread_id}\t${row.turns} turn(s)\t${row.updated_at}`)
}

async function thread(args) {
  checkFlags(args, ['--json'], 'thread')
  const provider = requireProviderArg(args.find((a) => !a.startsWith('--')))
  const positional = args.filter((a) => !a.startsWith('--'))
  const threadId = positional[1]
  if (!threadId) usage(1)
  const record = await viaDaemon('/v1/threads/events', { provider, thread_id: threadId }, (r) => r)
    ?? readThreadEvents(resolve(HOME, cfg.ledgerDir), provider, threadId)
  // A LOOKUP MISS IS NOT A SUCCESS. This exited 0 with an empty document, so
  // a script could not tell "this thread has no recorded turns" from "you
  // asked for a thread this machine has never seen" - and neither could a
  // person reading a log.
  if (!record.events.length) {
    throw new BridgeError(
      `No local ledger for ${provider} thread ${threadId}. ` +
        'Run `uibridge threads` to list the threads this machine has recorded.',
      { status: 404, code: 'thread_unknown', detail: { provider, thread_id: threadId } }
    )
  }
  if (args.includes('--json')) return console.log(JSON.stringify(record, null, 2))
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
    // ALWAYS HEADED: a human types here. Never inherit cfg.headless.
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

/**
 * THROUGH THE DAEMON, like every other command that needs a browser.
 *
 * This used to open its own Session, which launches a second Chrome against
 * the same profile and debugging port the daemon uses. Only one process may
 * drive a profile: the leftover Chrome from one such run held port 9334 and
 * broke every later ChatGPT request with a 45s "Chrome never opened a
 * debugging port". The daemon already has a warm, signed-in browser, so
 * asking it is both correct and faster. `--local` still runs it in-process
 * for debugging the browser layer itself.
 */
async function status(only, json = false, local = false) {
  const ids = only ? [requireProviderArg(only)] : providerIds
  let out = {}
  if (!local) {
    const daemon = await ensureDaemon(cfg, { log: logger('cli') })
    out = await daemonPost(`${daemon.base}/v1/session`, only ? { provider: only } : {})
  } else {
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

async function profiles(args) {
  const history = await listThreads(resolve(HOME, cfg.ledgerDir))
  const result = providerIds.map((provider) => {
    const path = providerSettings(cfg, provider, providerClass(provider).defaults).profileDir
    return { provider, path, exists: existsSync(path),
      last_successful_authenticated_use: history.find((r) => r.provider === provider)?.updated_at ?? null,
      evidence: 'successful_thread_ledger; not a current login check' }
  })
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else for (const entry of result) console.log(`${entry.provider}: ${entry.path}\n  profile ${entry.exists ? 'present' : 'absent'}; last recorded use: ${entry.last_successful_authenticated_use ?? 'unknown'}`)
}

async function requestCommand(args) {
  const [action, key] = args
  if (!['status', 'recover', 'cancel'].includes(action) || !key || !/^[\x21-\x7e]{1,200}$/.test(key)) {
    throw new BridgeError('Usage: uibridge request status|recover|cancel <key> [--json]', { code: 'invalid_request', status: 400 })
  }
  checkFlags(args, ['--json'], 'request')
  setLevel('warn')
  const daemon = await ensureDaemon(cfg)
  const result = await daemonPost(`${daemon.base}/v1/requests/${action === 'recover' ? 'result' : action}`, {}, {
    method: action === 'cancel' ? 'POST' : 'GET', headers: { 'Idempotency-Key': key },
  })
  if (action === 'recover') await printAsk(flatten(result), args.includes('--json'))
  else console.log(JSON.stringify(result, null, 2))
}

// Asking for help is never an error, and never a provider name. Without
// this, `uibridge ask --help` answered 'Unknown provider "--help"'.
if (cmd === '--version' || cmd === '-v' || rest.includes('--version')) { console.log(VERSION); process.exit(0) }
if (rest.includes('--help') || rest.includes('-h')) usage(0)

try {
  if (cmd === 'serve' || cmd === undefined) {
    // Headless is the default because this is a background service. --headed
    // is for watching it work, which is the only way some UI bugs are ever
    // found.
    const headed = rest.includes('--headed') || rest.includes('--no-headless')
    // Fall back to the CONFIGURED value, not to undefined: writing undefined
    // unconditionally made UIBRIDGE_HEADED (and any windowModeOverride in
    // config) inert for the daemon, which is the one process that matters.
    await serve({
      ...cfg,
      windowModeOverride: headed ? false : rest.includes('--headless') ? true : cfg.windowModeOverride,
    })
  }
  else if (cmd === 'login') await login(requireProviderArg(rest[0]))
  else if (cmd === 'logout') await logout(requireProviderArg(rest[0]))
  else if (cmd === 'status') {
    checkFlags(rest, ['--json', '--local'], 'status')
    const only = rest.find((a) => !a.startsWith('--'))
    await status(only, rest.includes('--json'), rest.includes('--local'))
  }
  else if (cmd === 'models') {
    checkFlags(rest, ['--json'], 'models')
    // A RUNNING DAEMON IS THE AUTHORITY. It keeps serving the code it started
    // with, so after an edit the checkout and the daemon can disagree about
    // which model ids exist - and the daemon's answer is the one a caller's
    // request is actually judged against. Only when nothing is listening does
    // the local catalogue speak for the API.
    // Same state-directory rule as viaDaemon: a daemon serving another home
    // must not answer for this one's catalogue.
    const live = await daemonHealth(cfg).catch((e) => {
      if (e?.code === 'daemon_other_home') throw e
      return null
    })
    const ids = live
      ? (await daemonPost(`http://${cfg.host}:${cfg.port}/v1/models`, null, { method: 'GET' })).data.map((m) => m.id)
      : modelCatalogue().map((m) => m.id)
    console.log(rest.includes('--json') ? JSON.stringify(ids, null, 2) : ids.join(String.fromCharCode(10)))
  }
  else if (cmd === 'threads') await threads(rest)
  else if (cmd === 'thread') await thread(rest)
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
  else if (cmd === 'stop') await stopDaemon()
  else if (cmd === 'paths') paths(rest)
  else if (cmd === 'profiles') await profiles(rest)
  else if (cmd === 'request') await requestCommand(rest)
  else if (cmd === 'autostart') await autostart(rest)
  else if (cmd === 'export') await exportThread(requireProviderArg(rest[0]), rest.slice(1))
  else if (cmd === 'capture') {
    const continueConversation = rest.includes('--continue')
    const prompt = rest.slice(1).filter((a) => a !== '--continue').join(' ')
    await captureExchange(cfg, requireProviderArg(rest[0]), prompt, { continueConversation })
  }
  else if (cmd === 'recon') await recon(rest)
  else usage(cmd === '-h' || cmd === '--help' ? 0 : 1)
} catch (e) {
  // An EXPECTED condition is not a crash. Signed out, thread gone, network
  // down, a daemon serving another state directory: each is typed, each has
  // an actionable message, and a Node stack trace over the top of one buries
  // the sentence the operator needs. Only an unrecognised error - a bug in
  // here - still prints its stack.
  if (e instanceof BridgeError) {
    if (rest.includes('--json')) {
      // A pipeline reading --json must get a document on failure too.
      console.error(JSON.stringify(e.toJSON(), null, 2))
    } else {
      console.error(`\n${e.message}\n`)
      if (e.retryable) console.error('This one may succeed if you try it again.\n')
    }
    process.exit(1)
  }
  throw e
}

// Forced because a CDP connection or a keep-alive socket can hold the loop
// open after the work is done. `process.exitCode` is whatever the command
// set (`status` on a signed-out provider, `chat` after a failed turn) and
// must not be flattened to 0 on the way out.
if (cmd !== 'serve' && cmd !== undefined) process.exit(process.exitCode ?? 0)
