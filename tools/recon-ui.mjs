// A BULK CAPTURE AID. **NOT** a substitute for opening the page yourself.
//
// READ THIS BEFORE YOU TRUST IT. This file was written to "recon the UI"
// automatically, and it failed at that in the most instructive way possible.
// Its rule for finding the composer - the last `[contenteditable="true"]` -
// resolved to `div.ql-clipboard`, Quill's permanently-offscreen paste buffer.
// Its rule for submitting reported `could not submit: Enter did nothing and
// no send button matched`, and then it went on capturing as though a turn had
// been sent. Both rules were reasonable. Both were wrong, because a script
// can only look for what its author already assumed - which is the very
// mistake this file was meant to cure, moved one level up.
//
// THE SURVEY THAT COUNTS IS `docs/UI-RECON.md`, and it was done by hand, in a
// signed-in browser, by reading the DOM and watching the page react. It found
// things nothing here would have asked about: that Gemini has no send button
// until you type, that its menus mount into a body-level overlay seconds
// late, and that a reloaded ChatGPT thread can render without its first turn
// while every scroll-based completeness signal reads true.
//
// So use this to bulk-capture inventories and network logs once you already
// know what you are looking at. Do not use it to find out.
//
// WHY ANY OF IT EXISTS. Every selector defect this project has hit was found
// the same way: something broke in production, someone read the error,
// guessed a new selector, and shipped it. That is not measurement, it is a
// bug report with extra steps. The result is a selectors file that describes
// the parts of the page we happened to break on, and says nothing about the
// parts we have not broken on yet.
//
// This walks a real signed-in session through every surface uibridge
// automates and records what is ACTUALLY THERE, using generic discovery -
// contenteditable, [role], [aria-label], [data-testid], custom element names -
// and deliberately NOT the project's own selectors. Nothing here reads
// selectors.json. If the survey and the selectors disagree, the survey wins,
// because the survey looked.
//
//   node tools/recon-ui.mjs gemini
//   node tools/recon-ui.mjs chatgpt
//
// Writes to testdata/recon/ui-<provider>/ (gitignored - raw bodies and
// conversation text):
//   NN-<checkpoint>.inventory.json   custom elements, testids, aria labels,
//                                    every interactive node with its path
//   NN-<checkpoint>.skeleton.html    the DOM with scripts/styles/svg stripped
//                                    and text truncated - structure, readable
//   network.jsonl                    every request: method, url, status, type
//   notes.json                       what the walk did, and what it could not
//
// It sends a handful of real messages. That is the point: a composer at rest
// and a composer mid-generation are different documents.

import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const ID = process.argv[2]
if (!['gemini', 'chatgpt'].includes(ID)) {
  console.error('usage: node tools/recon-ui.mjs <gemini|chatgpt>')
  process.exit(2)
}

// uibridge is used ONLY as the driver here - to reach the Chrome profile that
// already holds the user's session. Nothing below reads its selectors.
const { loadConfig, providerSettings, portFor, ROOT } = await import('../src/core/config.mjs')
const { attachBrowser } = await import('../src/core/chrome.mjs')
const { providerIds, providerClass } = await import('../src/providers/registry.mjs')
const { setLevel } = await import('../src/core/log.mjs')
setLevel('warn')

const cfg = loadConfig()
const settings = providerSettings(cfg, ID, providerClass(ID).defaults)
const HOME_URL = ID === 'gemini' ? 'https://gemini.google.com/app' : 'https://chatgpt.com/'
const OUT = resolve(ROOT, 'testdata', 'recon', `ui-${ID}`)
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const notes = { provider: ID, checkpoints: [], problems: [] }
const note = (m) => { console.log('  · ' + m); notes.checkpoints.push(m) }
const problem = (m) => { console.log('  ! ' + m); notes.problems.push(m) }

const { ctx } = await attachBrowser({
  port: portFor(cfg, ID, providerIds.indexOf(ID)),
  userDataDir: settings.profileDir,
  headless: false,
  clipboardOrigins: [new URL(HOME_URL).origin],
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.setViewportSize({ width: 1600, height: 1100 }).catch(() => {})

// --- network -----------------------------------------------------------------
const client = await ctx.newCDPSession(page)
await client.send('Network.enable', { maxResourceBufferSize: 64 * 1024 * 1024 })
const netFile = join(OUT, 'network.jsonl')
const inflight = new Map()
client.on('Network.requestWillBeSent', (e) => {
  inflight.set(e.requestId, { url: e.request.url, method: e.request.method, type: e.type,
    postBytes: e.request.postData ? e.request.postData.length : 0 })
})
client.on('Network.responseReceived', (e) => {
  const r = inflight.get(e.requestId)
  if (!r) return
  appendFileSync(netFile, JSON.stringify({ ...r, status: e.response.status, mime: e.response.mimeType }) + '\n')
  inflight.delete(e.requestId)
})

// --- the recorder ------------------------------------------------------------

/**
 * Everything a selector could be written against, and where it sits.
 * Generic on purpose: no provider knowledge, no project selectors.
 */
const INVENTORY = () => {
  const pathOf = (el) => {
    const parts = []
    let e = el
    while (e && e.tagName && e !== document.body && parts.length < 12) {
      const cls = (e.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
      const tid = e.getAttribute('data-testid')
      parts.unshift(e.tagName.toLowerCase() + (tid ? `[data-testid="${tid}"]` : cls ? '.' + cls : ''))
      e = e.parentElement
    }
    return parts.join(' > ')
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.01
  }
  const all = [...document.querySelectorAll('*')]
  const tally = (get) => {
    const m = {}
    for (const el of all) { const v = get(el); if (v) m[v] = (m[v] || 0) + 1 }
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 160))
  }

  const INTERACTIVE = 'button,[role="button"],[role="menuitem"],[role="menu"],[role="dialog"],[role="tab"],a[href],input,textarea,select,[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
  const interactive = all.filter((e) => e.matches(INTERACTIVE)).slice(0, 500).map((el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    testid: el.getAttribute('data-testid'),
    aria: (el.getAttribute('aria-label') || '').slice(0, 80) || null,
    tooltip: (el.getAttribute('data-tooltip') || el.getAttribute('title') || '').slice(0, 80) || null,
    disabled: el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true',
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    placeholder: (el.getAttribute('placeholder') || '').slice(0, 60) || null,
    text: (el.innerText || '').trim().slice(0, 60) || null,
    visible: visible(el),
    cls: (el.getAttribute('class') || '').slice(0, 140) || null,
    path: pathOf(el),
  }))

  // Anything that looks like it holds a message, a file, or a notice - by
  // shape, not by name. These are the regions selectors get written against.
  const REGIONS = {
    contenteditable: '[contenteditable="true"]',
    textareas: 'textarea',
    fileInputs: 'input[type="file"]',
    dialogs: '[role="dialog"],dialog',
    alerts: '[role="alert"],[role="status"]',
    menus: '[role="menu"],[role="listbox"]',
    scrollers: '[class*="scroll"],[class*="overflow"]',
    codeBlocks: 'pre,code-block,[class*="code-block"]',
    tables: 'table',
    images: 'img[alt]',
    downloads: 'a[download],a[href^="blob:"],[aria-label*="ownload"],[data-tooltip*="ownload"]',
  }
  const regions = {}
  for (const [k, sel] of Object.entries(REGIONS)) {
    const found = [...document.querySelectorAll(sel)]
    regions[k] = { count: found.length, samples: found.slice(0, 6).map((e) => ({ path: pathOf(e), visible: visible(e), aria: e.getAttribute('aria-label'), text: (e.innerText || '').trim().slice(0, 60) })) }
  }

  return {
    url: location.href,
    title: document.title,
    customElements: tally((e) => (e.tagName.includes('-') ? e.tagName.toLowerCase() : null)),
    dataTestIds: tally((e) => e.getAttribute('data-testid')),
    ariaLabels: tally((e) => (e.getAttribute('aria-label') || '').slice(0, 60) || null),
    roles: tally((e) => e.getAttribute('role')),
    dataAttributes: tally((e) => { for (const a of e.attributes) if (a.name.startsWith('data-') && a.name !== 'data-testid') return a.name; return null }),
    regions,
    interactive,
  }
}

/** The DOM with the noise removed: structure and identity, not styling. */
const SKELETON = () => {
  const KEEP = new Set(['id', 'class', 'role', 'href', 'title', 'alt', 'type', 'name', 'placeholder', 'contenteditable', 'disabled', 'download', 'value'])
  const clone = document.body.cloneNode(true)
  for (const el of [...clone.querySelectorAll('script,style,noscript,svg,path,link,meta')]) el.remove()
  const walk = (el) => {
    for (const a of [...el.attributes]) {
      if (KEEP.has(a.name) || a.name.startsWith('data-') || a.name.startsWith('aria-')) continue
      el.removeAttribute(a.name)
    }
    const cls = el.getAttribute('class')
    if (cls && cls.length > 160) el.setAttribute('class', cls.slice(0, 160) + ' …')
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 3 && n.textContent.length > 120) n.textContent = n.textContent.slice(0, 120) + '…'
      else if (n.nodeType === 1) walk(n)
    }
  }
  walk(clone)
  return clone.innerHTML
}

let step = 0
async function snap(name) {
  step += 1
  const tag = String(step).padStart(2, '0') + '-' + name
  try {
    const inv = await page.evaluate(INVENTORY)
    const skel = await page.evaluate(SKELETON)
    writeFileSync(join(OUT, tag + '.inventory.json'), JSON.stringify(inv, null, 2))
    writeFileSync(join(OUT, tag + '.skeleton.html'), skel.slice(0, 4_000_000))
    note(`${tag}: ${inv.interactive.length} interactive, ${Object.keys(inv.customElements).length} custom elements, ${Object.keys(inv.dataTestIds).length} testids, url ${inv.url}`)
  } catch (e) {
    problem(`${tag}: could not capture - ${e.message.split('\n')[0]}`)
  }
}

// --- generic drivers: find things by SHAPE, never by project selector -------

// The composer, found by MEASUREMENT rather than by position in the document.
// The first version of this took `.last()` of every contenteditable and got
// `div.ql-clipboard` - Quill's hidden paste buffer, permanently invisible.
// That is the whole thesis of this file in miniature: the plausible guess and
// the real element are different elements. Pick the biggest VISIBLE one.
const CANDIDATES = '[contenteditable="true"], textarea'
async function composerIndex() {
  return await page.evaluate((sel) => {
    const all = [...document.querySelectorAll(sel)]
    let best = -1, area = 0
    all.forEach((el, i) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      if (!r.width || !r.height) return
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return
      if (r.width * r.height > area) { area = r.width * r.height; best = i }
    })
    return { index: best, total: all.length,
      chosen: best < 0 ? null : { tag: all[best].tagName.toLowerCase(), cls: (all[best].getAttribute('class') || '').slice(0, 120), aria: all[best].getAttribute('aria-label') } }
  }, CANDIDATES)
}

async function typeIn(text) {
  const pick = await composerIndex()
  if (pick.index < 0) throw new Error(`no visible composer among ${pick.total} candidates`)
  notes.composer = pick.chosen
  const c = page.locator(CANDIDATES).nth(pick.index)
  await c.click({ timeout: 15000 })
  await c.fill('').catch(async () => { await page.keyboard.press('Control+a'); await page.keyboard.press('Delete') })
  await page.keyboard.type(text, { delay: 4 })
}

/**
 * Submit, and RECORD WHICH PATH WORKED. Do not assume Enter submits: on one
 * of these two builds it does not, and that single assumption cost hours once
 * already. Try Enter, measure whether anything happened, fall back to a
 * button found by shape, and write down the answer either way.
 */
async function send() {
  const before = await page.evaluate(() => document.body.innerText.length)
  const composerText = async () => {
    const pick = await composerIndex()
    if (pick.index < 0) return ''
    return await page.locator(CANDIDATES).nth(pick.index).innerText().catch(() => '')
  }
  const had = (await composerText()).trim().length

  await page.keyboard.press('Enter')
  await settle(2500)
  const emptied = (await composerText()).trim().length < had
  const grew = (await page.evaluate(() => document.body.innerText.length)) > before + 20
  if (emptied || grew) { notes.submit = 'Enter key'; return 'enter' }

  const btn = page.locator(
    'button[aria-label*="send" i], button[aria-label*="enviar" i], button[data-testid*="send" i], button[type="submit"]'
  ).filter({ hasNot: page.locator('[aria-hidden="true"]') }).first()
  if (await btn.count()) {
    const label = await btn.getAttribute('aria-label').catch(() => null)
    const tid = await btn.getAttribute('data-testid').catch(() => null)
    await btn.click({ timeout: 10000 })
    notes.submit = `button (aria-label=${label}, data-testid=${tid}) - ENTER DID NOT SUBMIT`
    return 'button'
  }
  notes.submit = 'NOTHING WORKED'
  problem('could not submit: Enter did nothing and no send button matched')
  return null
}

async function settle(ms) { await new Promise((r) => setTimeout(r, ms)) }

/** Wait until the page stops changing size - a generic "generation finished". */
async function quiet(maxMs = 180000) {
  let last = -1, stable = 0
  const deadline = Date.now.call ? null : null // Date.now is fine here (plain node)
  const start = Number(process.hrtime.bigint() / 1000000n)
  while (Number(process.hrtime.bigint() / 1000000n) - start < maxMs) {
    const n = await page.evaluate(() => document.body.innerText.length).catch(() => -1)
    if (n === last) { stable += 1; if (stable >= 6) return true } else { stable = 0; last = n }
    await settle(700)
  }
  return false
}

// --- the walk ----------------------------------------------------------------

console.log(`\nsurveying ${ID} -> ${OUT}\n`)

await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' })
await settle(6000)
await snap('landing')

// Any modal that greets us is itself a surface worth recording.
await snap('landing-modals-if-any')

// Every step is guarded. A survey that dies at step 3 tells you less than a
// survey that records "step 3 failed" and keeps going - and the first run of
// this file died at step 3.
const step_ = async (label, fn) => {
  try { return await fn() } catch (e) { problem(`${label}: ${e.message.split('\n')[0]}`); return null }
}

await step_('first ask', async () => {
  await typeIn('Reply with the single word ALPHA.')
  await settle(800)
  await snap('composer-typed')

  // WHEN does the address bar start naming the real conversation? Sample it,
  // because a thread id read one second too early can be a placeholder that
  // the app later throws away.
  const trace = []
  const sampler = setInterval(async () => {
    const u = await page.url()
    if (!trace.length || trace[trace.length - 1].url !== u) trace.push({ atMs: trace.length ? undefined : 0, url: u })
  }, 400)

  const how = await send()
  note(`submit path: ${notes.submit}`)
  await settle(2500)
  await snap('generating')

  await quiet()
  clearInterval(sampler)
  notes.urlTrace = trace
  await settle(1500)
  await snap('answered')
  return how
})

// A model/mode picker, found by shape: a control whose label mentions model or mode.
try {
  const picker = page.locator('button[aria-label*="model" i], button[aria-label*="mode" i], button[data-testid*="model" i], button[aria-label*="modelo" i]').first()
  if (await picker.count()) {
    await picker.click({ timeout: 8000 })
    await settle(1500)
    await snap('picker-open')
    await page.keyboard.press('Escape')
    await settle(800)
  } else problem('no model/mode picker found by generic label search')
} catch (e) { problem(`picker: ${e.message.split('\n')[0]}`) }

// An attachment, through the file input the page already has.
try {
  const f = join(tmpdir(), `recon_annex_${ID}.csv`)
  writeFileSync(f, 'sample_id,value\nA1,3.14\nA2,2.71\n')
  const input = page.locator('input[type="file"]').first()
  if (await input.count()) {
    await input.setInputFiles(f)
    await settle(6000)
    await snap('attachment-staged')
    await typeIn('Reply with the single word BETA.')
    await settle(500)
    await send()
    await settle(3000)
    await snap('attachment-sending')
    await quiet()
    await settle(1500)
    await snap('attachment-answered')
  } else problem('no input[type=file] in the document')
} catch (e) { problem(`attachment: ${e.message.split('\n')[0]}`) }

// A generated file, which is a different surface again.
try {
  await typeIn('Create a downloadable CSV file named recon_out.csv with header "id,value" and two data rows. Provide it as a file I can download.')
  await settle(500)
  await send()
  await settle(3000)
  await quiet()
  await settle(4000)
  await snap('generated-file')
} catch (e) { problem(`generated file: ${e.message.split('\n')[0]}`) }

// The thread as it looks when REOPENED - a different DOM from the live one.
const liveUrl = page.url()
try {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' })
  await settle(4000)
  await snap('home-after-conversation')
  await page.goto(liveUrl, { waitUntil: 'domcontentloaded' })
  await settle(9000)
  await snap('thread-reopened')
} catch (e) { problem(`reopen: ${e.message.split('\n')[0]}`) }

writeFileSync(join(OUT, 'notes.json'), JSON.stringify({ ...notes, liveUrl }, null, 2))
console.log(`\ndone. ${notes.checkpoints.length} checkpoints, ${notes.problems.length} problems.`)
console.log(OUT)
process.exit(0)
