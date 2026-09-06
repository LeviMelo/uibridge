// UI RENDERING SURVEY
//
// Not a model test. This maps how the Gemini UI *structures* different kinds
// of model output, so extraction can be built against what the DOM actually
// does instead of against a guess.
//
//   node survey.mjs
//
// For each probe it records:
//   - the custom-element inventory inside model-response
//   - what the CURRENT responseText selector extracts, vs the full innerText
//   - any download affordance (generated files)
//   - the full outerHTML, saved to testdata/dom/<probe>.html for grepping
//
// Output is a comparison table: where "extracted" is materially shorter than
// "rendered", the selector is losing content.

import { loadConfig, openContext, sleep } from './browser.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const cfg = loadConfig()
const svc = cfg.services.gemini
const OUT = 'testdata/dom'
mkdirSync(OUT, { recursive: true })

const PROBES = [
  ['table', 'Give me a markdown table of 3 pediatric anaesthesia trials with columns: PMID, drug, n, effect size. Table only.'],
  ['code', 'Write a Python function that parses a PRISMA flow diagram count dict. Code block only, no explanation.'],
  ['csvfile', 'Create a downloadable CSV file containing 5 rows of pediatric trial data (columns: pmid,drug,n,effect). Give me the actual file to download.'],
  ['math', 'Show the formula for the DerSimonian-Laird random-effects variance estimator using LaTeX.'],
  ['list', 'List the 7 PRISMA 2020 section headings as a numbered list. List only.'],
  ['thinking', 'Think step by step: if 40 of 120 children needed rescue sedation, what is the failure rate and its 95% CI? Show your reasoning.'],
]

const ctx = await openContext(cfg, 'gemini')
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.setViewportSize({ width: 1400, height: 1000 }).catch(() => {})

const rows = []

for (const [name, prompt] of PROBES) {
  process.stdout.write(`\n[${name}] `)
  await page.goto(svc.url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(svc.composer, { timeout: 60000 })
  await sleep(1500)

  await page.locator(svc.composer).first().click()
  await page.keyboard.insertText(prompt)
  await page.locator(svc.sendButton).first().click({ timeout: 15000 })

  // wait for completion: stop control gone + a response turn present
  for (let i = 0; i < 240; i++) {
    await sleep(500)
    const gen = await page.locator(svc.stopButton).first().isVisible().catch(() => false)
    const n = await page.locator(svc.responseBlocks).count().catch(() => 0)
    if (!gen && n > 0 && i > 8) break
  }
  await sleep(3000)
  process.stdout.write('captured ')

  const info = await page.evaluate(
    ({ blockSel, textSel }) => {
      const mr = document.querySelectorAll(blockSel)
      const el = mr[mr.length - 1]
      if (!el) return null

      const tags = {}
      for (const e of el.querySelectorAll('*')) {
        const t = e.tagName.toLowerCase()
        if (t.includes('-')) tags[t] = (tags[t] || 0) + 1
      }

      const inner = el.querySelector(textSel.split(',')[0].trim())
      const extracted = inner ? inner.innerText : ''

      // download affordances anywhere on the page
      const dl = [
        ...document.querySelectorAll(
          'a[download], a[href^="blob:"], a[href*="download"], button[aria-label*="Download" i], button[aria-label*="Baixar" i]'
        ),
      ].map((e) => ({
        tag: e.tagName.toLowerCase(),
        label: (e.getAttribute('aria-label') || e.innerText || '').trim().slice(0, 40),
        href: (e.getAttribute('href') || '').slice(0, 60),
        download: e.getAttribute('download') || null,
      }))

      return {
        tags: Object.entries(tags).sort((a, b) => b[1] - a[1]),
        renderedLen: el.innerText.length,
        extractedLen: extracted.length,
        tables: el.querySelectorAll('table').length,
        pre: el.querySelectorAll('pre, code').length,
        katex: el.querySelectorAll('.katex, math, mjx-container, [class*="math" i]').length,
        images: el.querySelectorAll('img').length,
        downloads: dl,
        html: el.outerHTML,
      }
    },
    { blockSel: svc.responseBlocks, textSel: svc.responseText }
  )

  if (!info) {
    rows.push([name, 'NO RESPONSE', '', '', '', ''])
    continue
  }

  writeFileSync(`${OUT}/${name}.html`, info.html)
  const notable = info.tags
    .filter(([t]) => !/^(mat-icon|gem-icon|gem-icon-button|mat-menu|gem-popover)/.test(t))
    .slice(0, 6)
    .map(([t, n]) => `${t}${n > 1 ? '×' + n : ''}`)
    .join(' ')

  rows.push([
    name,
    `${info.extractedLen}/${info.renderedLen}`,
    `tbl:${info.tables} pre:${info.pre} math:${info.katex} img:${info.images}`,
    info.downloads.length ? JSON.stringify(info.downloads.slice(0, 2)) : '-',
    notable,
  ])
  process.stdout.write(`ext ${info.extractedLen}/${info.renderedLen}`)
}

console.log('\n\n=============== RENDERING SURVEY ===============')
console.log('probe      extracted/rendered  richness                    downloads')
for (const r of rows) {
  console.log(`${r[0].padEnd(10)} ${String(r[1]).padEnd(19)} ${String(r[2]).padEnd(27)} ${r[3]}`)
  if (r[4]) console.log(`           elements: ${r[4]}`)
}
console.log(`\nfull HTML per probe saved under ${OUT}/`)
process.exit(0)
