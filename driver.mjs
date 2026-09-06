// Drives one chat UI in one tab.
//
// Order of operations per request, and it is not arbitrary:
//   new chat -> pick model -> set mode -> attach files -> type -> submit -> read
// Gemini CAN sometimes swap model mid-thread, but it is unreliable (often only
// takes after a few turns - a Gemini-side bug). So each request opens a fresh
// chat and selects there, which is deterministic.
//
// The mode picker carries two independent dimensions: the model (Flash-Lite /
// Flash / Pro) and an "Extended thinking" toggle. Its aria-label reads
// "<Model> Extended" when thinking is on and "Gemini <Model>" when off - that
// label is the only reliable read-back of either setting.
//
// TIMING POLICY: there are no fixed sleeps anywhere in the request path.
// Every wait is a condition. Completion is detected from the stop control
// while it is visible; where that control cannot be identified, from the
// answer text having stopped changing for `settleChecks` consecutive polls.
// "Stopped changing" is the definition of done, not padding.

import { readFileSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { sleep } from './browser.mjs'

const MIME = {
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain',
  '.json': 'application/json', '.md': 'text/markdown', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const mimeFor = (p) => MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'

const cdpSessions = new WeakMap()
async function cdp(page) {
  if (!cdpSessions.has(page)) cdpSessions.set(page, await page.context().newCDPSession(page))
  return cdpSessions.get(page)
}

/**
 * Drop files onto the composer using a CDP-dispatched (TRUSTED) drag event.
 *
 * A synthetic `new DragEvent(...)` from page context does NOT work on Gemini -
 * verified by dispatching at document, window, body, input-area-v2,
 * input-container, rich-textarea, .ql-editor, chat-window and main: zero
 * attachments every time. The app ignores untrusted drops. CDP's
 * Input.dispatchDragEvent produces a real one and takes file PATHS, so no
 * base64 round-trip either.
 *
 * This is the primary path: no menu to navigate, no OS dialog to intercept.
 * The "Upload & tools -> Files" menu is only a fallback - it is flaky and its
 * Files button sometimes never renders.
 */
async function dropFiles(page, svc, files) {
  const target = page.locator(svc.dropTarget ?? svc.composer).first()
  const box = await target.boundingBox()
  if (!box) throw new Error('drop target has no bounding box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  const client = await cdp(page)
  const data = { items: [], files: files.map((f) => resolve(f)), dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await client.send('Input.dispatchDragEvent', { type, x, y, data })
  }
}

const poll = (svc) => svc.pollMs ?? 150

// The clipboard is a single shared resource: two tabs copying at once would
// read each other's text. Serialise copy+read across the whole process.
let clipboardLock = Promise.resolve()
function withClipboard(fn) {
  const run = clipboardLock.then(fn, fn)
  clipboardLock = run.then(() => {}, () => {})
  return run
}

/**
 * Faithful text via the message Copy button.
 *
 * Gemini's copy yields the ORIGINAL MARKDOWN. innerText does not: KaTeX comes
 * out as garbled glyphs, pipe tables collapse to tab-separated fragments, and
 * code loses its fence. Compared side by side on the same response:
 *   innerText : "t ^ 2 = C Q-(k-1)"            tab-separated table
 *   clipboard : "$\hat{\tau}^2 = \frac{Q-(k-1)}{C}$"  | PMID | drug | n |
 * So this is the primary path and innerText is only the fallback.
 */
async function copyText(page, svc, expectLen = 0) {
  if (!svc.copyButton) return null
  return withClipboard(async () => {
    try {
      const btn = page.locator(svc.copyButton).last()
      await btn.click({ timeout: 5000 })
      const until = Date.now() + 2500
      let text = ''
      while (Date.now() < until) {
        text = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')) 
        if (text && text.trim()) break
        await sleep(poll(svc))
      }
      if (!text || !text.trim()) return null
      // Sanity: a copy that is far shorter than what is on screen means we
      // read a stale or wrong clipboard - prefer the fallback then.
      if (expectLen && text.length < expectLen * 0.5) return null
      return text
    } catch {
      return null
    }
  })
}

/** Parse markdown pipe tables into structured rows. */
export function parseTables(md) {
  const out = []
  const lines = (md ?? '').split(String.fromCharCode(10))
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) continue
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    const header = cells(lines[i])
    const rows = []
    let j = i + 2
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const r = cells(lines[j])
      rows.push(Object.fromEntries(header.map((h, k) => [h, r[k] ?? ''])))
    }
    out.push({ header, rows })
    i = j - 1
  }
  return out
}

/** Fenced code blocks, with their language. */
export function parseCodeBlocks(md) {
  const out = []
  const re = /```([a-zA-Z0-9_+-]*)\n([^]*?)```/g
  let m
  while ((m = re.exec(md ?? '')) !== null) out.push({ lang: m[1] || null, code: m[2] })
  return out
}

/**
 * Retrieve files Gemini GENERATED (not ones we uploaded).
 *
 * Gemini really does emit files - it is not just a code block. The response
 * renders a chip:
 *   <generated-file>
 *     <div class="chip-lr clickable">
 *       <img class="file-icon-lr" src=".../type/text/csv">
 *       <div data-test-id="file-name" title="pediatric_trial_data.csv">
 *       <div class="file-type-lr">CSV</div>
 *       <gem-button class="open-button">Open</gem-button>
 *
 * There is NO <a download> and no blob: href, so scanning for download
 * affordances finds nothing and it is easy to conclude wrongly that no file
 * exists. The bytes sit behind "Open", which opens a Drive-style viewer
 * OVERLAY in the same page whose toolbar is div[role=button] - Print,
 * Download, More actions. Clicking the Download div fires a genuine browser
 * download, which Playwright can save.
 *
 * WHEN we look: only if the response carries `contains-extensions-response`,
 * the class Gemini adds when its code/extension tool ran. Verified across six
 * probes: present for tool responses, absent for prose/tables/maths/code. So
 * ordinary replies pay nothing, and only tool responses wait for a chip.
 */
async function collectFiles(page, svc, log = () => {}) {
  if (!svc.generatedFile || !svc.fileDownload) return []

  const usedTool = await page
    .locator(svc.extensionsMarker ?? '.contains-extensions-response')
    .count()
    .catch(() => 0)
  if (!usedTool) return []

  // The chip is built server-side and can lag the text. Bounded wait, and a
  // tool response without a file (a computation, say) just falls through.
  const deadline = Date.now() + (svc.fileWaitMs ?? 20000)
  let n = 0
  while (Date.now() < deadline) {
    n = await page.locator(svc.generatedFile).count().catch(() => 0)
    if (n) break
    await sleep(poll(svc))
  }
  if (!n) return []

  mkdirSync(svc.downloadDir ?? 'downloads', { recursive: true })
  const out = []

  for (let i = 0; i < n; i++) {
    const chip = page.locator(svc.generatedFile).nth(i)
    const name = await chip
      .locator(svc.generatedFileName ?? '[data-test-id="file-name"]')
      .first()
      .getAttribute('title')
      .catch(() => null)

    try {
      await chip.locator(`${svc.fileOpenButton ?? 'button'}, .chip-lr`).first().click({ timeout: 15000 })
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: svc.fileDownloadTimeoutMs ?? 30000 }),
        page.locator(svc.fileDownload).first().click({ timeout: 15000 }),
      ])
      const filename = dl.suggestedFilename() || name || `generated-${i}`
      const path = resolve(svc.downloadDir ?? 'downloads', filename)
      await dl.saveAs(path)
      const size = statSync(path).size
      const entry = { name: filename, path, bytes: size, type: null, text: null }
      entry.type = await chip
        .locator(svc.generatedFileType ?? '.file-type-lr')
        .first()
        .innerText()
        .catch(() => null)
      // Small text-ish payloads are what a pipeline actually wants inline;
      // anything bigger or binary stays on disk only.
      if (size <= (svc.fileInlineMaxBytes ?? 262144) && /csv|json|txt|md|tsv|xml|ya?ml/i.test(filename)) {
        entry.text = readFileSync(path, 'utf8')
      }
      out.push(entry)
      log(`retrieved generated file ${filename} (${size} bytes)`)
    } catch (e) {
      log(`generated file ${name ?? i} could not be retrieved: ${e.message.split('\n')[0]}`)
      out.push({ name, path: null, bytes: null, error: 'retrieval failed' })
    }
    // Leave the viewer so the next chip (or the next request) starts clean.
    await page.locator(svc.fileViewerClose ?? '[aria-label="Close"]').first().click({ timeout: 5000 }).catch(() => {})
  }
  return out
}

async function turnCount(page, svc) {
  return page.locator(svc.responseBlocks).count().catch(() => 0)
}

async function turnText(page, svc, index) {
  const block = page.locator(svc.responseBlocks).nth(index)
  if ((await block.count().catch(() => 0)) === 0) return ''
  const inner = block.locator(svc.responseText).first()
  const target = (await inner.count().catch(() => 0)) > 0 ? inner : block
  return (await target.innerText().catch(() => '')) ?? ''
}

/**
 * Transient status line ("Pesquisando na internet", "Thinking", ...) rather
 * than an answer. Without this, a status string that sits still for a few
 * polls gets returned as the model's reply - which is exactly how a batch
 * run ends up with half its JSON extractions empty.
 */
function isTransient(text, svc) {
  const t = text.trim()
  if (!t) return true
  if (t.length > 160) return false
  return (svc.transientText ?? []).some((m) => t.toLowerCase().startsWith(m.toLowerCase()))
}

/**
 * Is the model still producing output?
 *
 * isVisible() is an immediate state read - do NOT pass a timeout. With one,
 * a busy page makes the call time out, throw, and fall into the catch; if the
 * catch then answers "not generating", the driver truncates the reply
 * mid-stream and you get half-written JSON. So: no timeout, and on any error
 * assume generation IS still running. The response deadline still bounds it,
 * and "wait too long" is a recoverable mistake where "return early" is not.
 */
async function generating(page, svc) {
  if (!svc.stopButton) return false
  try {
    return await page.locator(svc.stopButton).first().isVisible()
  } catch {
    return true
  }
}

/**
 * Sources cited in one answer turn, plus whether the model actually browsed.
 *
 * Gemini frequently answers from its own weights even when told to search, so
 * `browsed` is reported rather than assumed. Sources come from anchors inside
 * the turn - NOT from `sources-list`, which is the collapsed carousel and
 * always has empty innerText.
 */
async function collectSources(page, svc, index, sawSearch = false) {
  if (!svc.sourceLink) return { browsed: sawSearch, sources: [] }
  // Source anchors and chips are appended a beat AFTER the answer finishes,
  // so a single read right at completion finds nothing. Poll briefly.
  const until = Date.now() + (svc.sourceTimeoutMs ?? 2500)
  let best = { browsed: sawSearch, sources: [] }
  while (Date.now() < until) {
    const got = await readSources(page, svc, index).catch(() => null)
    if (got) {
      best = { browsed: sawSearch || got.browsed, sources: got.sources, chipCount: got.chipCount }
      if (got.sources.length || got.chipCount) break
    }
    await sleep(poll(svc))
  }
  // Chips present but no anchors in the body: the URLs are only behind the
  // "View sources" panel, so go get them.
  if (best.browsed && !best.sources.length) {
    best.sources = await readSourcePanel(page, svc)
  }
  return best
}

async function readSources(page, svc, index) {
  try {
    return await page.evaluate(
      ({ blockSel, idx, linkSel, chipSel }) => {
        const blocks = document.querySelectorAll(blockSel)
        const mr = blocks[idx] ?? blocks[blocks.length - 1]
        if (!mr) return { browsed: false, sources: [] }
        const seen = new Map()
        for (const a of mr.querySelectorAll(linkSel)) {
          const href = a.href
          if (!href || !/^https?:/i.test(href)) continue
          if (!seen.has(href)) seen.set(href, (a.innerText || '').trim().slice(0, 120))
        }
        const chips = chipSel ? mr.querySelectorAll(chipSel).length : 0
        const sources = [...seen].map(([url, title]) => ({ url, title }))
        return { browsed: chips > 0, sources, chipCount: chips }
      },
      { blockSel: svc.responseBlocks, idx: index, linkSel: svc.sourceLink, chipSel: svc.sourceChip ?? null }
    )
  } catch {
    return { browsed: false, sources: [] }
  }
}

/**
 * Read the real source URLs from the message menu -> "View sources".
 *
 * A browsing answer carries source CHIPS but no anchors in the body, so the
 * URLs simply are not in the DOM until that panel is opened. The panel yields
 * text-fragment URLs (#:~:text=...) that pinpoint the passage actually cited -
 * strictly better provenance than a bare domain.
 */
async function readSourcePanel(page, svc) {
  if (!svc.moreButton || !svc.viewSourcesItem) return []
  const ignore = svc.sourceIgnoreHosts ?? []
  try {
    await page.locator(svc.moreButton).last().click({ timeout: 5000 })
    const item = page.locator(svc.viewSourcesItem).first()
    await item.waitFor({ state: 'visible', timeout: 4000 })
    await item.click({ timeout: 4000 })

    // Links populate asynchronously; poll for something that is not Google chrome.
    const until = Date.now() + (svc.sourceTimeoutMs ?? 4000)
    let out = []
    while (Date.now() < until) {
      out = await page.evaluate(
        ({ sel, ignore }) =>
          [...document.querySelectorAll(sel)]
            .map((a) => ({ url: a.href, title: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120) }))
            // Panel chrome (Google product / sign-out links) has EMPTY text;
            // real sources always carry a title. That filter is what a host
            // blocklist alone misses (e.g. google.com.br/intl).
            .filter((s) => s.title.length > 0)
            .filter((s) => !ignore.some((h) => s.url.includes(h)))
            .filter((s, i, arr) => arr.findIndex((x) => x.url === s.url) === i),
        { sel: svc.sourcePanelLink ?? "a[href^='http']", ignore }
      )
      if (out.length) break
      await sleep(poll(svc))
    }
    return out
  } catch {
    return []
  } finally {
    await page.keyboard.press('Escape').catch(() => {})
  }
}

/** Provider anti-bot interstitial - surface it rather than time out. */
async function checkBlocked(page) {
  const u = page.url()
  if (u.includes('/sorry/') || u.includes('/challenge') || u.includes('captcha')) {
    throw new Error(
      'BLOCKED: provider served an unusual-traffic / bot check. Open the Chrome ' +
        'window and clear it yourself, then lower services.*.concurrency.'
    )
  }
}

/**
 * Attach local files. Two shapes are supported:
 *   1. a real input[type=file]  (simple, if the UI has one)
 *   2. a button that opens the OS dialog (Gemini) -> filechooser interception
 * Waits for the attachment to actually register before returning.
 */
async function attach(page, svc, files, log = () => {}) {
  const t0 = Date.now()

  if (svc.fileInput) {
    const input = page.locator(svc.fileInput).first()
    if ((await input.count().catch(() => 0)) > 0) {
      await input.setInputFiles(files)
      await waitForAttachReady(page, svc, files.length)
      log(`attached ${files.length} file(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      return
    }
  }

  // Primary: drag-and-drop.
  if (svc.dropTarget) {
    try {
      await dropFiles(page, svc, files)
      await waitForAttachReady(page, svc, files.length)
      log(`dropped ${files.length} file(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      return
    } catch (err) {
      log(`drag-drop failed (${err.message.slice(0, 60)}); trying the upload menu`)
    }
  }

  if (!svc.uploadButton || !svc.uploadFilesOption) {
    throw new Error('No upload path configured for this service')
  }

  await page.locator(svc.uploadButton).first().click({ timeout: 10000 })
  const filesOption = page.locator(svc.uploadFilesOption).first()
  await filesOption.waitFor({ state: 'visible', timeout: 8000 })

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    filesOption.click(),
  ])
  await chooser.setFiles(files)

  await waitForAttachReady(page, svc, files.length)
  log(`attached ${files.length} file(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

/**
 * Wait until the upload has actually registered.
 *
 * NOT the send button: it is enabled the entire time during upload, so using
 * it means typing and submitting before the file lands - the model then
 * answers about a file it never received, which looks like a plausible answer
 * rather than an error. Verified by DOM probe.
 *
 * Real signal: one attachment chip per file AND the "Uploading file" status
 * gone.
 */
async function waitForAttachReady(page, svc, expected = 1) {
  if (!svc.attachmentChip) return
  const until = Date.now() + (svc.uploadTimeoutMs ?? 180000)
  const chips = page.locator(svc.attachmentChip)
  const busyRe = svc.uploadingText ? new RegExp(svc.uploadingText, 'i') : null

  while (Date.now() < until) {
    const n = await chips.count().catch(() => 0)
    if (n >= expected) {
      const busy = busyRe
        ? await page.evaluate((re) => new RegExp(re, 'i').test(document.body.innerText), svc.uploadingText).catch(() => false)
        : false
      if (!busy) return
    }
    await sleep(poll(svc))
  }
  throw new Error(
    `Attachment never registered (expected ${expected} "${svc.attachmentChip}" element(s))`
  )
}

/** Start a fresh conversation as cheaply as possible. */
async function newChat(page, svc) {
  if (svc.newChatButton) {
    const btn = page.locator(svc.newChatButton).first()
    if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click().catch(() => {})
      const until = Date.now() + 5000
      while (Date.now() < until) {
        if ((await turnCount(page, svc)) === 0) return
        await sleep(poll(svc))
      }
      return
    }
  }
  await page.goto(svc.url, { waitUntil: 'domcontentloaded' })
}

/**
 * Pick a model in the UI. Returns the label actually in effect, so the caller
 * can report real provenance instead of what was merely requested.
 *
 * Never throws on a missing control: a UI detail must not kill a pipeline run.
 * It reports what happened and continues on the account default.
 */
/** Picker aria-label, e.g. "Open mode picker, currently Pro Extended". */
async function pickerLabel(page, svc) {
  const p = page.locator(svc.modelPicker).first()
  const l = await p.getAttribute('aria-label').catch(() => null)
  return (l ?? (await p.innerText().catch(() => ''))).replace(/\s+/g, ' ').trim()
}

/** Open the mode menu and wait for its options. Idempotent-ish. */
async function openPicker(page, svc) {
  const picker = page.locator(svc.modelPicker).first()
  // click() auto-waits; count() does not. Use the waiting one.
  await picker.click({ timeout: svc.pickerTimeoutMs ?? 8000 })
  await page
    .locator(svc.modelOption ?? "[role='menuitem']")
    .first()
    .waitFor({ state: 'visible', timeout: svc.pickerTimeoutMs ?? 8000 })
}

/**
 * Select a model. `match` picks the menu option; `verify` is checked against
 * the picker label afterwards.
 *
 * VERIFY, DO NOT INFER: "the label changed" is not "the model I asked for is
 * active" - the label passes through transition states. Reports what is
 * actually in effect so a caller can trust provenance.
 */
export async function selectModel(page, svc, modelKey, log = () => {}) {
  const spec = svc.models?.[modelKey]
  if (!spec) return { requested: modelKey, applied: null, note: 'no mapping configured' }

  const verify = new RegExp(spec.verify ?? spec.match, 'i')
  let label = await pickerLabel(page, svc)
  if (verify.test(label)) return { requested: modelKey, applied: label, note: 'already active' }

  try {
    await openPicker(page, svc)
  } catch {
    log('mode picker did not open; staying on account default')
    return { requested: modelKey, applied: label || null, note: 'picker not available' }
  }

  const option = page
    .locator(svc.modelOption ?? "[role='menuitem']")
    .filter({ hasText: new RegExp(spec.match, 'i') })
    .first()

  try {
    await option.click({ timeout: 4000 })
  } catch {
    await page.keyboard.press('Escape').catch(() => {})
    log(`model "${modelKey}" (/${spec.match}/) not in the menu; using default`)
    return { requested: modelKey, applied: label || null, note: 'option not found' }
  }

  const until = Date.now() + (svc.pickerTimeoutMs ?? 8000)
  while (Date.now() < until) {
    label = await pickerLabel(page, svc)
    if (verify.test(label)) return { requested: modelKey, applied: label, note: 'verified' }
    await sleep(poll(svc))
  }
  log(`model "${modelKey}" NOT applied - picker reads "${label}"`)
  return { requested: modelKey, applied: label || null, note: 'verification failed' }
}

/**
 * Toggle a mode (Gemini's "Extended thinking") that lives as an entry in the
 * same menu. State is read from the picker label: "<Model> Extended" means on.
 */
export async function setMode(page, svc, modeKey, want, log = () => {}) {
  if (want === undefined || want === null) return null
  const spec = svc.modes?.[modeKey]
  if (!spec) return { mode: modeKey, note: 'no mapping configured' }

  const onRe = new RegExp(spec.onLabel, 'i')
  let label = await pickerLabel(page, svc)
  if (onRe.test(label) === !!want) {
    return { mode: modeKey, applied: !!want, note: 'already set', label }
  }

  try {
    await openPicker(page, svc)
    await page
      .locator(svc.modelOption ?? "[role='menuitem']")
      .filter({ hasText: new RegExp(spec.option, 'i') })
      .first()
      .click({ timeout: 4000 })
  } catch {
    await page.keyboard.press('Escape').catch(() => {})
    log(`mode "${modeKey}" control not found; left as-is`)
    return { mode: modeKey, note: 'control not found', label }
  }

  const until = Date.now() + (svc.pickerTimeoutMs ?? 8000)
  while (Date.now() < until) {
    label = await pickerLabel(page, svc)
    if (onRe.test(label) === !!want) {
      return { mode: modeKey, applied: !!want, note: 'verified', label }
    }
    await sleep(poll(svc))
  }
  log(`mode "${modeKey}" NOT applied - picker reads "${label}"`)
  return { mode: modeKey, applied: null, note: 'verification failed', label }
}

/**
 * Run one prompt in one tab and return { text, model }.
 *
 * @param {import('playwright').Page} page
 * @param {object} svc     service config block
 * @param {object} opts    { prompt, files, model, modes }
 * @param {(s:string)=>void} log
 */
export async function ask(page, svc, opts, log = () => {}) {
  const { prompt, files = [], model = null, modes = {} } = opts

  if (page.url() === 'about:blank' || !page.url().startsWith(svc.url.split('?')[0])) {
    await page.goto(svc.url, { waitUntil: 'domcontentloaded' })
  } else if (svc.newChatPerRequest) {
    await newChat(page, svc)
  }

  await checkBlocked(page)
  try {
    await page.waitForSelector(svc.composer, { timeout: svc.readyTimeoutMs })
  } catch {
    await checkBlocked(page)
    throw new Error('Composer not found - probably signed out. Run: node login.mjs <service>')
  }

  // --- model + modes, before the first turn (cannot change mid-thread) -----
  let modelInfo = null
  const modeInfo = {}
  if (model) modelInfo = await selectModel(page, svc, model, log)
  for (const [k, v] of Object.entries(modes)) {
    modeInfo[k] = await setMode(page, svc, k, v, log)
  }
  // Authoritative provenance: read the picker AFTER model and modes are both
  // applied. The label captured during model selection is stale by then.
  if (modelInfo || Object.keys(modeInfo).length) {
    const finalLabel = await pickerLabel(page, svc).catch(() => null)
    if (modelInfo) modelInfo.final_label = finalLabel
    else modeInfo._final_label = finalLabel
  }

  const before = await turnCount(page, svc)
  const sendBtn = () => page.locator(svc.sendButton).first()

  // --- attachments ---------------------------------------------------------
  // Gemini exposes no input[type=file]; the "Files" entry opens the OS file
  // dialog, so we intercept the filechooser event. setInputFiles cannot work
  // here - verified against the live DOM.
  if (files.length) {
    await attach(page, svc, files, log)
  }

  // --- type + submit ------------------------------------------------------
  const composer = page.locator(svc.composer).first()
  await composer.click()
  await page.keyboard.insertText(prompt)

  // Enter does NOT submit on this Gemini build - verified against the live
  // page. The send button is the only path; click() auto-waits for it.
  try {
    await sendBtn().click({ timeout: 15000 })
  } catch {
    await composer.press('Enter') // last resort for other UIs
  }
  const tSubmit = Date.now()

  // --- wait for the answer turn to exist ----------------------------------
  const deadline = tSubmit + svc.responseTimeoutMs
  while (Date.now() < deadline) {
    if ((await turnCount(page, svc)) > before) break
    await sleep(poll(svc))
  }
  const total = await turnCount(page, svc)
  if (total <= before) {
    await checkBlocked(page)
    throw new Error('No response turn appeared before timeout')
  }
  const index = total - 1

  // --- wait for it to finish ----------------------------------------------
  // Done when: not generating, text is a real answer, and it has been
  // identical for `settleChecks` consecutive polls. All conditions.
  const need = svc.settleChecks ?? 3
  const searchRe = svc.searchTransient ? new RegExp(svc.searchTransient, 'i') : null
  let sawSearch = false
  let last = null
  let same = 0
  while (Date.now() < deadline) {
    const text = await turnText(page, svc, index)
    if (searchRe && !sawSearch && searchRe.test(text)) sawSearch = true
    same = text === last ? same + 1 : 0
    last = text

    if (same >= need && !isTransient(text, svc) && !(await generating(page, svc))) {
      const copied = await copyText(page, svc, text.length)
      const final = copied ?? text
      log(
        `done in ${((Date.now() - tSubmit) / 1000).toFixed(1)}s (${final.length} chars` +
          `${copied ? ', markdown via copy' : ', innerText fallback'})`
      )
      const cited = await collectSources(page, svc, index, sawSearch)
      const generated = await collectFiles(page, svc, log)
      if (cited.sources.length) log(`${cited.sources.length} source(s) cited`)
      return {
        text: final,
        markdown: !!copied,
        tables: parseTables(final),
        code_blocks: parseCodeBlocks(final),
        files: generated,
        model: modelInfo,
        modes: modeInfo,
        ...cited,
      }
    }
    await sleep(poll(svc))
  }

  await checkBlocked(page)
  if (last && !isTransient(last, svc)) {
    log(`timed out; returning ${last.length} chars captured so far`)
    return { text: last, model: modelInfo, modes: modeInfo, ...(await collectSources(page, svc, index, sawSearch)) }
  }
  throw new Error('Response never completed before timeout')
}

/** Pull the first valid JSON out of a reply. Returns null if there is none. */
export function extractJSON(text) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  const direct = tryParse(text.trim())
  if (direct !== null) return direct

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    const parsed = tryParse(fence[1].trim())
    if (parsed !== null) return parsed
  }
  const span = text.match(/[{[][\s\S]*[}\]]/)
  return span ? tryParse(span[0]) : null
}
