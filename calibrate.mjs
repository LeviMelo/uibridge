// Inspect a live chat page and report which configured selectors actually
// match, plus candidates for the ones that do not.
//
//   node calibrate.mjs gemini
//
// Run this whenever a provider reshuffles their DOM and the bridge breaks.
// Paste the output back and the fix is a config.json edit, not a rewrite.

import { loadConfig, serviceConfig, openContext, firstPage, sleep } from './browser.mjs'

const service = process.argv[2] ?? 'gemini'
const cfg = loadConfig()
const svc = serviceConfig(cfg, service)

const ctx = await openContext(cfg, service, { headless: false })
const page = await firstPage(ctx, svc.url)

console.log(`\nCalibrating ${service} at ${svc.url}`)
console.log('Waiting 8s for the page to settle...\n')
await sleep(8000)

const keys = ['composer', 'sendButton', 'stopButton', 'responseBlocks', 'responseText', 'fileInput']
console.log('CONFIGURED SELECTORS')
console.log('--------------------')
for (const k of keys) {
  const sel = svc[k]
  let n = 0
  try {
    n = await page.locator(sel).count()
  } catch {
    n = -1
  }
  const mark = n > 0 ? 'OK  ' : n === 0 ? 'MISS' : 'ERR '
  console.log(`${mark} ${k.padEnd(16)} ${n} match(es)   ${sel}`)
}

console.log('\nCANDIDATES FOUND ON PAGE')
console.log('------------------------')
const found = await page.evaluate(() => {
  const out = { editables: [], buttons: [], fileInputs: [], repeated: [] }

  for (const el of document.querySelectorAll('[contenteditable="true"]')) {
    out.editables.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: (el.className || '').toString().slice(0, 90),
      placeholder: el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || null,
    })
  }

  for (const el of document.querySelectorAll('button')) {
    const label = (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 40)
    if (!label) continue
    out.buttons.push({
      label,
      testid: el.getAttribute('data-testid') || null,
      cls: (el.className || '').toString().slice(0, 60),
    })
  }

  for (const el of document.querySelectorAll('input[type="file"]')) {
    out.fileInputs.push({ accept: el.getAttribute('accept') || 'any', multiple: el.multiple })
  }

  // Custom elements appearing more than once are usually the message turns.
  const counts = {}
  for (const el of document.querySelectorAll('*')) {
    const t = el.tagName.toLowerCase()
    if (t.includes('-')) counts[t] = (counts[t] || 0) + 1
  }
  out.repeated = Object.entries(counts)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)

  return out
})

console.log('\nContenteditable (composer candidates):')
for (const e of found.editables) console.log('  ', JSON.stringify(e))

console.log('\nFile inputs:')
for (const e of found.fileInputs) console.log('  ', JSON.stringify(e))

console.log('\nButtons (send/stop candidates):')
for (const b of found.buttons.slice(0, 30)) console.log('  ', JSON.stringify(b))

console.log('\nRepeated custom elements (message-turn candidates):')
for (const [tag, n] of found.repeated) console.log(`   ${tag}  x${n}`)

console.log('\nLeave the window open and send one message by hand, then re-run')
console.log('this to see which elements appear for an assistant turn.\n')

await ctx.close()
process.exit(0)
