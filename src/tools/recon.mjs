// RECON: look at a site before writing a single selector.
//
// This tool knows NOTHING about any provider. It takes a URL and reports what
// is actually there: the DOM's own vocabulary, every network call with its
// body, the runtime's globals, whether a service worker or WebSocket is in
// play, and - the question that decides the whole architecture - whether the
// answer arrives in a readable network payload.
//
// It exists because `capture` cannot help with a NEW provider: capture drives
// the generic flow, and the generic flow needs selectors, and the selectors
// are what we are trying to learn. Guessing them to break that circle is
// exactly the mistake that cost days on Gemini.
//
// Two phases, deliberately separate:
//
//   uibridge recon observe <url>
//       Load the page and describe it. No typing, no clicking, no
//       assumptions. Produces the vocabulary: every data-testid, every
//       aria-label, every editable, every file input, plus the runtime.
//
//   uibridge recon exchange <url> --composer=<sel> --send=<sel> --prompt=...
//       Now that the selectors come from OBSERVATION rather than from
//       imagination, drive one real exchange and record the wire.
//
// Nothing here signs in, types a credential, or touches a challenge.

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from '../core/config.mjs'
import { logger } from '../core/log.mjs'
import { attachBrowser } from '../core/chrome.mjs'
import { sleep, waitFor } from '../core/async.mjs'

// ---------------------------------------------------------------------------
// In-page instrumentation, installed BEFORE the app's own scripts run.
//
// Record-only on purpose: it notes what the app requested and what came back,
// but never substitutes a Response. Teeing a stream to read it means handing
// the app a rebuilt Response (losing res.url, res.redirected), and an app that
// depends on those breaks in a way that looks like a site bug. CDP's
// Network.streamResourceContent reads bodies without that risk, so this hook
// only fills the gap CDP is weakest at: request bodies, which get evicted.
// ---------------------------------------------------------------------------
const INSTRUMENT = `
(() => {
  const B = (window.__ubRecon = { calls: [], sockets: [], workers: [] })
  const note = (rec) => { if (B.calls.length < 400) B.calls.push(rec) }

  const origFetch = window.fetch
  window.fetch = function (input, init) {
    let url = '', method = 'GET', body = null
    try {
      url = typeof input === 'string' ? input : (input && input.url) || ''
      method = (init && init.method) || (input && input.method) || 'GET'
      body = init && typeof init.body === 'string' ? init.body : null
    } catch (e) {}
    const rec = { via: 'fetch', url, method, body, t: Date.now() }
    note(rec)
    const p = origFetch.apply(this, arguments)
    p.then(
      (r) => { rec.status = r.status; rec.mime = r.headers.get('content-type') || '' },
      (e) => { rec.error = String(e && e.message) }
    )
    return p
  }

  const OpenXHR = XMLHttpRequest.prototype.open
  const SendXHR = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__ub = { via: 'xhr', url: String(u), method: m, t: Date.now() }
    return OpenXHR.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function (b) {
    if (this.__ub) {
      this.__ub.body = typeof b === 'string' ? b : null
      note(this.__ub)
      this.addEventListener('load', () => {
        this.__ub.status = this.status
        this.__ub.mime = this.getResponseHeader('content-type') || ''
      })
    }
    return SendXHR.apply(this, arguments)
  }

  const OrigWS = window.WebSocket
  window.WebSocket = function (url, protocols) {
    B.sockets.push({ url: String(url), t: Date.now() })
    return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols)
  }
  window.WebSocket.prototype = OrigWS.prototype

  const OrigES = window.EventSource
  if (OrigES) {
    window.EventSource = function (url, cfg) {
      B.calls.push({ via: 'eventsource', url: String(url), method: 'GET', t: Date.now() })
      return new OrigES(url, cfg)
    }
    window.EventSource.prototype = OrigES.prototype
  }
})()
`

// ---------------------------------------------------------------------------
// DOM survey. Describes the page in ITS OWN vocabulary rather than looking
// for things we expect: no "find the send button", just "here is every
// labelled control, every editable, every custom element".
// ---------------------------------------------------------------------------
const SURVEY = `(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
  }
  const label = (el) =>
    (el.getAttribute('aria-label') ||
      el.getAttribute('data-tooltip') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      (el.innerText || '').trim().slice(0, 60) ||
      '').replace(/\\s+/g, ' ').trim()

  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    testid: el.getAttribute('data-testid'),
    id: el.id || null,
    role: el.getAttribute('role'),
    type: el.getAttribute('type'),
    label: label(el),
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || null,
    visible: vis(el),
    box: box(el),
  })

  // 1. data-testid is the most stable handle a React app offers: it is put
  //    there for the app's own tests, so it survives styling churn.
  const testids = {}
  for (const el of document.querySelectorAll('[data-testid]')) {
    const k = el.getAttribute('data-testid')
    if (!testids[k]) testids[k] = { count: 0, sample: describe(el) }
    testids[k].count++
  }

  // 2. Anything that takes input.
  const editables = [...document.querySelectorAll('[contenteditable=""], [contenteditable="true"], textarea, input:not([type="hidden"])')].map(describe)

  // 3. File inputs, including the hidden ones an "Attach" menu drives.
  const fileInputs = [...document.querySelectorAll('input[type="file"]')].map((el) => ({
    ...describe(el),
    accept: el.getAttribute('accept'),
    multiple: el.multiple,
    hidden: !vis(el),
  }))

  // 4. Every labelled control, visible or not.
  const controls = [...document.querySelectorAll('button, [role="button"], a[href], [role="menuitem"], [role="option"], [role="tab"]')]
    .map(describe)
    .filter((d) => d.label || d.testid)

  // 5. Custom elements: an Angular/Lit app names its own concepts here.
  const custom = {}
  for (const el of document.querySelectorAll('*')) {
    const t = el.tagName.toLowerCase()
    if (t.includes('-')) custom[t] = (custom[t] || 0) + 1
  }

  // 6. Attributes the app invented. These name the domain model, and they
  //    are what a message turn is usually identified by.
  const dataAttrs = {}
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes) {
      if (a.name.startsWith('data-') && a.name !== 'data-testid') {
        const k = a.name + '=' + (a.value.length > 24 ? '<value>' : a.value)
        dataAttrs[k] = (dataAttrs[k] || 0) + 1
      }
    }
  }

  // 7. Runtime: how the app talks to its backend, and whether something
  //    sits between us and the network.
  const runtime = {
    url: location.href,
    title: document.title,
    globals: Object.keys(window).filter((k) => /^__|^_[A-Z]|next|remix|apollo|trpc/i.test(k)).slice(0, 40),
    nextData: !!window.__NEXT_DATA__,
    reactRoot: !!document.querySelector('#__next, [data-reactroot], #root'),
    localStorage: Object.keys(localStorage || {}).slice(0, 60),
    sessionStorage: Object.keys(sessionStorage || {}).slice(0, 40),
    cookieNames: document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean),
    serviceWorkers: 0,
    hasWebSocket: (window.__ubRecon && window.__ubRecon.sockets.length) || 0,
  }

  // 8. Signed-in / signed-out signals, stated as EVIDENCE rather than as a
  //    verdict: a password field means a login wall; an avatar or an account
  //    menu means a session. The verdict is mine to draw after looking.
  const bodyText = (document.body.innerText || '').slice(0, 4000)
  const evidence = {
    passwordFields: document.querySelectorAll('input[type="password"]').length,
    emailFields: document.querySelectorAll('input[type="email"], input[name="email"], input[name="username"]').length,
    mentionsLogIn: /log ?in|sign ?up|entrar|criar conta/i.test(bodyText),
    mentionsChallenge: /unusual|verify you|not a robot|just a moment|cloudflare/i.test(bodyText),
    bodyHead: bodyText.slice(0, 700),
  }

  return { testids, editables, fileInputs, controls, custom, dataAttrs, runtime, evidence }
})()`

/**
 * Work in ONE tab, and leave none behind.
 *
 * Every run used to take a fresh page and never close it, so a session left a
 * row of blank windows on screen and, less visibly, kept enough targets alive
 * that connectOverCDP itself eventually timed out. Reuse the first tab, close
 * the leftovers.
 */
async function singleTab(ctx) {
  const pages = ctx.pages()
  const page = pages[0] ?? (await ctx.newPage())
  for (const p of pages.slice(1)) await p.close().catch(() => {})
  return page
}

function outDir(tag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = resolve(ROOT, 'testdata', 'recon', `${tag}-${stamp}`)
  mkdirSync(resolve(dir, 'net'), { recursive: true })
  return dir
}

/** Attach CDP network recording that keeps STREAMED bodies. */
async function recordNetwork(ctx, page) {
  const client = await ctx.newCDPSession(page)
  await client.send('Network.enable', {
    maxResourceBufferSize: 256 * 1024 * 1024,
    maxTotalBufferSize: 512 * 1024 * 1024,
  })
  await client.send('Page.enable').catch(() => {})
  const reqs = new Map()
  const sockets = []
  const dec = (b64) => Buffer.from(b64, 'base64').toString('utf8')

  client.on('Network.requestWillBeSent', (e) => {
    reqs.set(e.requestId, {
      id: e.requestId,
      url: e.request.url,
      method: e.request.method,
      type: e.type,
      postData: e.request.postData ?? null,
      hasPostData: !!e.request.hasPostData,
      // Header NAMES only. The values carry the session token, and this
      // report gets written to disk and read in a terminal.
      reqHeaderNames: Object.keys(e.request.headers ?? {}),
      chunks: [],
      streamed: false,
    })
  })
  client.on('Network.responseReceived', async (e) => {
    const r = reqs.get(e.requestId)
    if (!r) return
    r.status = e.response.status
    r.mime = e.response.mimeType
    r.resHeaderNames = Object.keys(e.response.headers ?? {})
    // Subscribe NOW: a streamed body is not retained, so asking afterwards
    // returns nothing for precisely the response worth having.
    try {
      const s = await client.send('Network.streamResourceContent', { requestId: e.requestId })
      r.streamed = true
      if (s.bufferedData) r.chunks.push(dec(s.bufferedData))
    } catch {
      /* not streamable; getResponseBody later */
    }
  })
  client.on('Network.dataReceived', (e) => {
    const r = reqs.get(e.requestId)
    if (r && e.data) r.chunks.push(dec(e.data))
  })
  client.on('Network.webSocketCreated', (e) => sockets.push(e.url))

  return { client, reqs, sockets }
}

/** Write every request to disk and return a compact index. */
async function dumpNetwork(client, reqs, dir, { prompt, answerProbe }) {
  const answerWords = (answerProbe ?? '')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 6)
    .slice(0, 4)
  const rows = []
  for (const r of reqs.values()) {
    let body = r.chunks.join('')
    if (!body) {
      try {
        const got = await client.send('Network.getResponseBody', { requestId: r.id })
        body = got.base64Encoded ? Buffer.from(got.body, 'base64').toString('utf8') : got.body
      } catch {
        body = ''
      }
    }
    if (r.hasPostData && !r.postData) {
      try {
        r.postData = (await client.send('Network.getRequestPostData', { requestId: r.id })).postData
      } catch {
        /* evicted */
      }
    }
    const u = new URL(r.url)
    if (/\.(png|jpe?g|webp|svg|woff2?|css|ico|mp4)(\?|$)/i.test(u.pathname)) continue
    if (/^(Image|Font|Stylesheet|Media)$/i.test(r.type ?? '')) continue

    const holdsAnswer = answerWords.length ? answerWords.every((w) => body.includes(w)) : false
    const carriesPrompt =
      !!prompt &&
      ((r.postData ?? '').includes(prompt.slice(0, 24)) ||
        decodeURIComponent(r.postData ?? '').includes(prompt.slice(0, 24)))
    const sse = /event-stream/i.test(r.mime ?? '')

    const safe = (u.pathname.split('/').filter(Boolean).slice(-2).join('_') || 'root')
      .replace(/[^\w.-]/g, '_')
      .slice(0, 60)
    writeFileSync(
      resolve(dir, 'net', `${safe}-${r.id.replace(/[^\w]/g, '')}.txt`),
      [
        `URL: ${r.url}`,
        `METHOD: ${r.method}  STATUS: ${r.status}  MIME: ${r.mime}  TYPE: ${r.type}  STREAMED: ${r.streamed}`,
        `SSE: ${sse}  HOLDS_ANSWER: ${holdsAnswer}  CARRIES_PROMPT: ${carriesPrompt}`,
        `REQUEST HEADER NAMES: ${(r.reqHeaderNames ?? []).join(', ')}`,
        `RESPONSE HEADER NAMES: ${(r.resHeaderNames ?? []).join(', ')}`,
        '',
        '===== REQUEST BODY =====',
        r.postData ?? '(none)',
        '',
        '===== RESPONSE BODY =====',
        body,
      ].join('\n')
    )
    rows.push({
      path: u.host + u.pathname,
      method: r.method,
      status: r.status,
      mime: (r.mime ?? '').split(';')[0],
      bytes: body.length,
      sse,
      holdsAnswer,
      carriesPrompt,
      reqHeaderNames: r.reqHeaderNames ?? [],
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// PHASE 1: observe. Load and describe. Nothing is typed or clicked.
// ---------------------------------------------------------------------------
export async function reconObserve(cfg, url, { port = 9400, profile }) {
  const log = logger('recon')
  const host = new URL(url).host.replace(/[^\w.-]/g, '_')
  const dir = outDir(`${host}-observe`)

  const { ctx } = await attachBrowser({
    port,
    userDataDir: profile,
    headless: false,
    clipboardOrigins: [new URL(url).origin],
  })
  const page = await singleTab(ctx)
  await page.setViewportSize({ width: 1500, height: 1000 }).catch(() => {})
  await page.addInitScript(INSTRUMENT).catch(() => {})

  const { client, reqs, sockets } = await recordNetwork(ctx, page)

  log.info(`loading ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // Settle: an app of this kind renders its shell, then hydrates, then
  // fetches. Reading the DOM at domcontentloaded describes a page that does
  // not exist a second later.
  await sleep(6000)

  const survey = await page.evaluate(SURVEY)
  survey.runtime.serviceWorkers = await page
    .evaluate(() => navigator.serviceWorker?.getRegistrations?.().then((r) => r.length) ?? 0)
    .catch(() => 0)
  const inPage = await page.evaluate(() => window.__ubRecon ?? { calls: [], sockets: [] }).catch(() => ({ calls: [], sockets: [] }))

  const rows = await dumpNetwork(client, reqs, dir, {})
  const html = await page.content()

  writeFileSync(resolve(dir, 'survey.json'), JSON.stringify(survey, null, 2))
  writeFileSync(resolve(dir, 'inpage-calls.json'), JSON.stringify(inPage, null, 2))
  writeFileSync(resolve(dir, 'network.json'), JSON.stringify(rows, null, 2))
  writeFileSync(resolve(dir, 'page.html'), html)
  await page.screenshot({ path: resolve(dir, 'page.png') }).catch(() => {})

  report(survey, rows, sockets, inPage)
  console.log(`\nsaved to ${dir}\n`)
  await client.detach().catch(() => {})
  return { dir, survey, rows, page, ctx, client }
}

function report(survey, rows, sockets, inPage) {
  const r = survey.runtime
  console.log(`\n=== recon: ${r.url}`)
  console.log(`title      : ${r.title}`)
  console.log(
    `runtime    : nextData=${r.nextData} reactRoot=${r.reactRoot} ` +
      `serviceWorkers=${r.serviceWorkers} webSockets=${sockets.length}`
  )
  console.log(`storage    : localStorage=[${r.localStorage.slice(0, 12).join(', ')}]`)
  console.log(`cookies    : ${r.cookieNames.join(', ') || '(none readable from JS)'}`)
  const e = survey.evidence
  console.log(
    `session    : passwordFields=${e.passwordFields} emailFields=${e.emailFields} ` +
      `mentionsLogIn=${e.mentionsLogIn} mentionsChallenge=${e.mentionsChallenge}`
  )
  console.log(`\ntestids (${Object.keys(survey.testids).length}):`)
  for (const [k, v] of Object.entries(survey.testids).slice(0, 60)) {
    console.log(`  ${k}${v.count > 1 ? ` x${v.count}` : ''}  <${v.sample.tag}> "${v.sample.label}"`)
  }
  console.log(`\neditables (${survey.editables.length}):`)
  for (const d of survey.editables.slice(0, 20)) {
    console.log(`  <${d.tag}> id=${d.id} testid=${d.testid} vis=${d.visible} box=${d.box} "${d.label}"`)
  }
  console.log(`\nfile inputs (${survey.fileInputs.length}):`)
  for (const d of survey.fileInputs) {
    console.log(`  <${d.tag}> accept=${d.accept} multiple=${d.multiple} hidden=${d.hidden} testid=${d.testid}`)
  }
  console.log(`\ndata-* attributes the app invented:`)
  for (const [k, n] of Object.entries(survey.dataAttrs).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${k}  x${n}`)
  }
  const custom = Object.entries(survey.custom).sort((a, b) => b[1] - a[1]).slice(0, 15)
  if (custom.length) console.log(`\ncustom elements: ${custom.map(([t, n]) => `${t}x${n}`).join(' ')}`)
  console.log(`\nnetwork (${rows.length} non-asset requests):`)
  for (const q of rows.slice(0, 40)) {
    console.log(
      `  ${String(q.method).padEnd(5)} ${String(q.status).padEnd(4)} ${q.mime.padEnd(26)} ` +
        `${String(q.bytes).padStart(7)}b  ${q.sse ? 'SSE ' : '    '}${q.path}`
    )
  }
  if (inPage.calls?.length) {
    console.log(`\nin-page fetch/XHR (${inPage.calls.length}):`)
    for (const c of inPage.calls.slice(0, 25)) {
      console.log(`  ${c.via.padEnd(11)} ${String(c.method).padEnd(5)} ${String(c.status ?? '-').padEnd(4)} ${c.url.slice(0, 110)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// PHASE 2: exchange. Drive one real turn using selectors DERIVED FROM PHASE 1,
// and record what crosses the wire. This is the question that decides the
// architecture: does the answer arrive as a readable payload, or only as
// pixels?
// ---------------------------------------------------------------------------
export async function reconExchange(cfg, url, opts) {
  const log = logger('recon')
  const host = new URL(url).host.replace(/[^\w.-]/g, '_')
  const dir = outDir(`${host}-exchange`)
  const prompt = opts.prompt ?? 'Reply with exactly: RECON-OK-7731'

  const { ctx } = await attachBrowser({
    port: opts.port ?? 9400,
    userDataDir: opts.profile,
    headless: false,
    clipboardOrigins: [new URL(url).origin],
  })
  const page = await singleTab(ctx)
  await page.setViewportSize({ width: 1500, height: 1000 }).catch(() => {})
  await page.addInitScript(INSTRUMENT).catch(() => {})
  const { client, reqs, sockets } = await recordNetwork(ctx, page)

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(5000)

  const composer = page.locator(opts.composer).first()
  await composer.waitFor({ state: 'visible', timeout: 20000 })
  await composer.click()
  await page.keyboard.insertText(prompt)
  await sleep(400)

  log.info('submitting')
  if (opts.send) {
    await page.locator(opts.send).first().click({ timeout: 10000 })
  } else {
    await page.keyboard.press('Enter')
  }

  // Wait on a MEASUREMENT, not a sleep: the turn count rising, then the text
  // holding still. `turns` is a selector learned in phase 1.
  const turnSel = opts.turns
  let before = 0
  if (turnSel) before = await page.locator(turnSel).count().catch(() => 0)

  let lastLen = -1
  let stable = 0
  const deadline = Date.now() + (opts.timeoutMs ?? 180000)
  while (Date.now() < deadline) {
    await sleep(700)
    let len = 0
    if (turnSel) {
      const n = await page.locator(turnSel).count().catch(() => 0)
      if (n <= before) continue
      len = ((await page.locator(turnSel).last().innerText().catch(() => '')) ?? '').length
    } else {
      len = ((await page.locator('body').innerText().catch(() => '')) ?? '').length
    }
    if (len > 0 && len === lastLen) {
      if (++stable >= 4) break
    } else stable = 0
    lastLen = len
  }

  const answerText = turnSel
    ? ((await page.locator(turnSel).last().innerText().catch(() => '')) ?? '')
    : ''
  await sleep(1500)

  const survey = await page.evaluate(SURVEY)
  const inPage = await page.evaluate(() => window.__ubRecon ?? { calls: [] }).catch(() => ({ calls: [] }))
  const turnHtml = turnSel
    ? await page.locator(turnSel).last().evaluate((el) => el.outerHTML).catch(() => '')
    : ''

  const rows = await dumpNetwork(client, reqs, dir, { prompt, answerProbe: answerText.slice(0, 200) })

  writeFileSync(resolve(dir, 'survey.json'), JSON.stringify(survey, null, 2))
  writeFileSync(resolve(dir, 'network.json'), JSON.stringify(rows, null, 2))
  writeFileSync(resolve(dir, 'inpage-calls.json'), JSON.stringify(inPage, null, 2))
  writeFileSync(resolve(dir, 'turn.html'), turnHtml)
  writeFileSync(resolve(dir, 'turn.txt'), answerText)
  await page.screenshot({ path: resolve(dir, 'page.png') }).catch(() => {})

  report(survey, rows, sockets, inPage)
  console.log(`\nanswer text (${answerText.length} chars): ${JSON.stringify(answerText.slice(0, 160))}`)
  const wire = rows.filter((q) => q.holdsAnswer)
  const sent = rows.filter((q) => q.carriesPrompt)
  console.log(`\nWIRE VERDICT`)
  console.log(`  requests carrying the prompt  : ${sent.length ? sent.map((q) => `${q.method} ${q.path}`).join(', ') : 'NONE'}`)
  console.log(`  payloads containing the answer: ${wire.length ? wire.map((q) => `${q.path} (${q.bytes}b${q.sse ? ', SSE' : ''})`).join(', ') : 'NONE'}`)
  console.log(`\nsaved to ${dir}\n`)

  await client.detach().catch(() => {})
  return { dir, rows, survey }
}
