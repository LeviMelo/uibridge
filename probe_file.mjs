// GENERATED-FILE PROBE
//
// Gemini can emit a REAL file, not just a code block. It renders as:
//   <generated-file> -> div.chip-lr[clickable]
//        img.file-icon-lr  (drive-thirdparty .../type/text/csv)
//        div[data-test-id="file-name"][title="pediatric_trial_data.csv"]
//        div.file-type-lr  "CSV"
//        gem-button.open-button  "Open"
//
// There is no <a download> and no blob: href anywhere, which is why a search
// for download affordances finds nothing. The bytes live behind "Open".
// This probe maps that path and tries to land the file on disk.

import { loadConfig, openContext, sleep } from './browser.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const cfg = loadConfig()
const svc = cfg.services.gemini
const OUT = 'testdata/dom'
const DL = 'testdata/downloads'
mkdirSync(OUT, { recursive: true })
mkdirSync(DL, { recursive: true })

const PROMPT =
  'Create a downloadable CSV file with 5 rows of pediatric anaesthesia trial ' +
  'data, columns: pmid,drug,n,effect. Give me the actual file.'

const ctx = await openContext(cfg, 'gemini')
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.setViewportSize({ width: 1500, height: 1000 }).catch(() => {})

const log = (...a) => console.log(...a)

// Capture anything the browser tries to download, from the moment we start.
const downloads = []
page.on('download', async (d) => {
  const name = d.suggestedFilename()
  const path = `${DL}/${name}`
  await d.saveAs(path).catch((e) => log('  saveAs failed', e.message))
  downloads.push({ name, path })
  log(`  >> DOWNLOAD EVENT: ${name} -> ${path}`)
})
ctx.on('page', (p) => log(`  >> new tab: ${p.url().slice(0, 90)}`))

log('asking for a file...')
await page.goto(svc.url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector(svc.composer, { timeout: 60000 })
await sleep(1200)
await page.locator(svc.composer).first().click()
await page.keyboard.insertText(PROMPT)
await page.locator(svc.sendButton).first().click({ timeout: 15000 })

// wait until generation stops AND a generated-file chip exists (the chip can
// appear seconds after the text settles - the file is built server-side)
let chip = 0
let doneAt = 0
for (let i = 0; i < 400; i++) {
  await sleep(500)
  const gen = await page.locator(svc.stopButton).first().isVisible().catch(() => true)
  chip = await page.locator('generated-file').count().catch(() => 0)
  if (!gen && i > 8 && !doneAt) doneAt = i
  if (chip > 0) break
  // The chip is built server-side and can lag the text by a long way; keep
  // watching for 90s after the stream stops before giving up.
  if (doneAt && i - doneAt > 180) break
}
log(`generation done. generated-file chips: ${chip}`)

if (!chip) {
  // Do not guess about what happened - report what the DOM actually holds.
  const what = await page.evaluate(() => {
    const mr = document.querySelectorAll('model-response')
    const el = mr[mr.length - 1]
    if (!el) return null
    const tags = {}
    for (const e of el.querySelectorAll('*')) {
      const t = e.tagName.toLowerCase()
      if (t.includes('-')) tags[t] = (tags[t] || 0) + 1
    }
    return {
      tags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 12),
      text: el.innerText.slice(0, 500),
      html: el.outerHTML,
    }
  })
  if (what) {
    writeFileSync(`${OUT}/nofile.html`, what.html)
    log('no chip. response elements:', what.tags.map(([t, n]) => `${t}x${n}`).join(' '))
    log('response text:')
    log(what.text)
  }
  await page.screenshot({ path: `${OUT}/nofile.png` }).catch(() => {})
  process.exit(0)
}

// --- what the chip itself tells us -----------------------------------------
const meta = await page.evaluate(() => {
  const g = document.querySelector('generated-file')
  const q = (s) => g.querySelector(s)
  return {
    filename: q('[data-test-id="file-name"]')?.getAttribute('title') ?? null,
    label: q('[data-test-id="file-name"]')?.textContent.trim() ?? null,
    type: q('.file-type-lr')?.textContent.trim() ?? null,
    icon: q('img')?.src ?? null,
    buttons: [...g.querySelectorAll('button')].map((b) => b.innerText.trim()),
    anchors: [...g.querySelectorAll('a')].map((a) => a.href),
  }
})
log('chip metadata:', JSON.stringify(meta))

// --- open it ---------------------------------------------------------------
log('clicking Open...')
await page.locator('generated-file button, generated-file .chip-lr').first().click({ timeout: 15000 })
await sleep(4000)
await page.screenshot({ path: `${OUT}/file_opened.png` }).catch(() => {})

// Whatever panel opened: inventory it, and find every control in it.
const panel = await page.evaluate(() => {
  const host =
    document.querySelector('immersive-editor, code-immersive-panel, [class*="immersive"]') ||
    document.querySelector('mat-sidenav-content') ||
    document.body
  const tags = {}
  for (const e of host.querySelectorAll('*')) {
    const t = e.tagName.toLowerCase()
    if (t.includes('-')) tags[t] = (tags[t] || 0) + 1
  }
  const controls = [...host.querySelectorAll('button,[role="button"],a')]
    .map((e) => ({
      tag: e.tagName.toLowerCase(),
      label: (e.getAttribute('aria-label') || e.getAttribute('arialabel') || e.innerText || '')
        .trim()
        .slice(0, 44),
      href: (e.getAttribute('href') || '').slice(0, 70),
      dl: e.getAttribute('download'),
    }))
    .filter((c) => c.label)
  return {
    host: host.tagName.toLowerCase(),
    tags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 14),
    controls,
    text: host.innerText.slice(0, 1500),
  }
})
log('\npanel host:', panel.host)
log('elements:', panel.tags.map(([t, n]) => `${t}x${n}`).join(' '))
log('\ncontrols mentioning export/download/share/copy:')
for (const c of panel.controls) {
  if (/download|export|baixar|share|copy|save|more|\.\.\./i.test(c.label)) {
    log('  ', JSON.stringify(c))
  }
}
writeFileSync(`${OUT}/file_panel.json`, JSON.stringify(panel, null, 2))
log(`\n(all ${panel.controls.length} controls -> ${OUT}/file_panel.json)`)
log('\npanel text (first 600):\n' + panel.text.slice(0, 600))

// --- try to actually download ----------------------------------------------
const tries = [
  'button[aria-label*="Download" i]',
  '[arialabel*="Download" i]',
  'button[aria-label*="Export" i]',
  'button:has-text("Download")',
  'button:has-text("Export")',
]
for (const sel of tries) {
  const n = await page.locator(sel).count().catch(() => 0)
  if (!n) continue
  log(`\nclicking ${sel} (${n} match)`)
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.locator(sel).first().click({ timeout: 8000 }).catch(() => null),
  ])
  await sleep(2500)
  if (dl) break
  // a menu may have opened instead
  const items = await page
    .locator('[role="menuitem"]')
    .allInnerTexts()
    .catch(() => [])
  if (items.length) log('  menu opened:', JSON.stringify(items))
}

await sleep(2000)
await page.screenshot({ path: `${OUT}/file_after_download.png` }).catch(() => {})
log('\ndownloads captured:', JSON.stringify(downloads))
process.exit(0)
