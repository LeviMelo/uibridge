// Retrieve the BYTES of a Gemini-generated file.
//
// Path, all verified from the live DOM:
//   1. <generated-file> chip carries the real name in
//      [data-test-id="file-name"]@title  ("pediatric_anaesthesia_trial_data.csv")
//   2. clicking the chip (or its "Open" gem-button) opens a Drive-style
//      viewer OVERLAY inside the same page - a spreadsheet grid plus a
//      toolbar: print / download / kebab
//   3. the download control is a DIV with aria-label/data-tooltip
//      "Download" - NOT a <button> and with no href, which is why
//      button[aria-label*=Download] only ever matched "Download code"
//   4. clicking it fires a genuine browser download -> page.on('download')

import { loadConfig, openContext, sleep } from './browser.mjs'
import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs'

const CHAT = process.argv[2] ?? 'https://gemini.google.com/app/77dbb4ce241b5ec6'
const DL = 'testdata/downloads'
const OUT = 'testdata/dom'
mkdirSync(DL, { recursive: true })
mkdirSync(OUT, { recursive: true })

const cfg = loadConfig()
const ctx = await openContext(cfg, 'gemini')
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.setViewportSize({ width: 1500, height: 1000 }).catch(() => {})

const got = []
page.on('download', async (d) => {
  const path = `${DL}/${d.suggestedFilename()}`
  await d.saveAs(path)
  got.push(path)
  console.log(`  >> saved ${path} (${statSync(path).size} bytes)`)
})

console.log(`opening ${CHAT}`)
await page.goto(CHAT, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('generated-file', { timeout: 60000 })

const meta = await page.evaluate(() => {
  const g = document.querySelector('generated-file')
  return {
    filename: g.querySelector('[data-test-id="file-name"]')?.getAttribute('title'),
    type: g.querySelector('.file-type-lr')?.textContent.trim(),
  }
})
console.log('chip:', JSON.stringify(meta))

await page.locator('generated-file .chip-lr, generated-file button').first().click({ timeout: 15000 })
console.log('opened viewer, waiting for the toolbar...')

// Map every control the overlay adds, however it is tagged.
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('[aria-label],[data-tooltip]')].some((e) =>
      /^download$/i.test(e.getAttribute('aria-label') || e.getAttribute('data-tooltip') || '')
    ),
  null,
  { timeout: 30000 }
)

const toolbar = await page.evaluate(() =>
  [...document.querySelectorAll('[aria-label],[data-tooltip],[role="button"]')]
    .map((e) => ({
      tag: e.tagName.toLowerCase(),
      role: e.getAttribute('role'),
      aria: e.getAttribute('aria-label'),
      tip: e.getAttribute('data-tooltip'),
    }))
    .filter((c) => /download|print|more actions|more sheets|close/i.test(`${c.aria} ${c.tip}`))
)
console.log('viewer toolbar controls:')
for (const c of toolbar) console.log('  ', JSON.stringify(c))
writeFileSync(`${OUT}/viewer_toolbar.json`, JSON.stringify(toolbar, null, 2))

const DOWNLOAD = '[aria-label="Download"], [data-tooltip="Download"]'
console.log(`clicking ${DOWNLOAD}`)
const [dl] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }).catch(() => null),
  page.locator(DOWNLOAD).first().click({ timeout: 10000 }),
])

await sleep(2500)
await page.screenshot({ path: `${OUT}/viewer.png` }).catch(() => {})

if (!dl && !got.length) {
  const items = await page.locator('[role="menuitem"]').allInnerTexts().catch(() => [])
  console.log('no download event. menu items:', JSON.stringify(items))
  process.exit(1)
}

for (const p of got) {
  const body = readFileSync(p, 'utf8')
  console.log(`\n--- ${p} ---`)
  console.log(body.slice(0, 600))
}
process.exit(0)
