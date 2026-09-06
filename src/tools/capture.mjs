// CAPTURE: record one real exchange, in full, for calibration.
//
// This replaces the pile of one-off probe scripts. It exists because the
// single biggest waste in building this was working from assumptions about
// the page instead of from the page: guessed selectors, an assumed submit
// key, an assumed download link. Each cost hours and each would have been a
// two-minute answer with a capture in hand.
//
//   uibridge capture gemini ["prompt"]
//
// It writes, under testdata/capture/<provider>-<stamp>/:
//   response.html    the answer turn's full outerHTML
//   elements.json    custom-element inventory + affordances found
//   text.md          rendered text vs copied text, side by side
//   net/*.txt        every request with body, and whether it holds the answer
//   page.png         a screenshot
//
// The net/ dump is how a WIRE transport gets built: if a provider's own
// payload contains the answer, extraction can stop touching the DOM. For
// Gemini it does not appear to be reachable that way - the generation call
// never surfaces in page-level CDP traffic, there is no service worker, and
// the visible RPCs are obfuscated positional arrays behind an `at` token. For
// another provider it may well be, which is why this looks rather than
// assumes.

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT, portFor, providerSettings } from '../core/config.mjs'
import { logger } from '../core/log.mjs'
import { attachBrowser } from '../core/chrome.mjs'
import { sleep, waitFor } from '../core/async.mjs'
import { copyMarkdown, count, isGenerating, readRenderedText } from '../transports/dom.mjs'
import { providerClass, providerIds } from '../providers/registry.mjs'

const DEFAULT_PROMPT =
  'Give a markdown table of 3 paediatric anaesthesia trials (columns PMID, drug, ' +
  'n, effect size), the DerSimonian-Laird variance estimator in LaTeX, a short ' +
  'Python function, and a downloadable CSV of the table. All four.'

export async function captureExchange(cfg, id, promptArg, { continueConversation = false } = {}) {
  const log = logger(`capture:${id}`)
  const Class = providerClass(id)
  const sel = Class.selectors
  const settings = providerSettings(cfg, id, Class.defaults)
  const prompt = promptArg?.trim() || DEFAULT_PROMPT

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = resolve(ROOT, 'testdata', 'capture', `${id}-${stamp}`)
  mkdirSync(resolve(dir, 'net'), { recursive: true })

  const { ctx } = await attachBrowser({
    port: portFor(cfg, id, providerIds.indexOf(id)),
    userDataDir: settings.profileDir,
    headless: false,
    clipboardOrigins: [new URL(sel.url).origin],
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.setViewportSize({ width: 1500, height: 1000 }).catch(() => {})

  // --- network recording ---------------------------------------------------
  const client = await ctx.newCDPSession(page)
  await client.send('Network.enable', {
    maxResourceBufferSize: 128 * 1024 * 1024,
    maxTotalBufferSize: 512 * 1024 * 1024,
  })
  const reqs = new Map()
  const dec = (b64) => Buffer.from(b64, 'base64').toString('utf8')

  client.on('Network.requestWillBeSent', (e) => {
    reqs.set(e.requestId, {
      id: e.requestId,
      url: e.request.url,
      method: e.request.method,
      postData: e.request.postData ?? null,
      hasPostData: !!e.request.hasPostData,
      chunks: [],
      streamed: false,
    })
  })
  client.on('Network.responseReceived', async (e) => {
    const r = reqs.get(e.requestId)
    if (!r) return
    r.status = e.response.status
    r.mime = e.response.mimeType
    // Subscribe NOW. A streamed body is not retained, so asking after the
    // fact returns nothing for exactly the response worth having.
    try {
      const s = await client.send('Network.streamResourceContent', { requestId: e.requestId })
      r.streamed = true
      if (s.bufferedData) r.chunks.push(dec(s.bufferedData))
    } catch {
      /* not streamable; getResponseBody below */
    }
  })
  client.on('Network.dataReceived', (e) => {
    const r = reqs.get(e.requestId)
    if (r && e.data) r.chunks.push(dec(e.data))
  })

  // --- run one exchange ----------------------------------------------------
  const provider = new Class({ selectors: sel, settings: { ...settings, url: sel.url }, log })
  await provider.open(page)
  if (!continueConversation) await provider.newConversation(page).catch(() => {})
  await provider.dismissNotices?.(page).catch(() => [])
  const before = await count(page, sel.responseBlocks)

  log.info('sending prompt')
  const ctxState = { turnsBefore: before }
  await provider.submit(page, prompt, ctxState)
  await provider.awaitCompletion(page, ctxState)
  // Wire completion does not need a DOM index, but this calibration tool
  // deliberately records both surfaces. Wait for the corresponding rendered
  // turn before taking its HTML and screenshot.
  if (ctxState.index == null) {
    const total = await waitFor(async () => {
      const n = await count(page, sel.responseBlocks)
      return n > before ? n : null
    }, {
      timeout: settings.submitAckMs ?? 60000,
      poll: settings.pollMs,
      what: 'the captured response turn to render',
    })
    ctxState.index = total - 1
  }
  // Generated files land after the text; give the chip a bounded chance to
  // appear so the capture records it.
  await waitFor(async () => (await count(page, sel.generatedFile?.chip ?? 'nothing')) || null, {
    timeout: 20000,
    poll: settings.pollMs,
    what: 'a generated-file chip',
  }).catch(() => {})
  await sleep(1000)

  const index = ctxState.index
  log.info('capturing DOM')

  const rendered = await readRenderedText(page, { blocks: sel.responseBlocks, text: sel.responseText }, index)
  const copied = await copyMarkdown(page, sel, {
    expectLen: rendered.length,
    rendered,
    pollMs: settings.pollMs,
    log,
  })

  const dom = await page.evaluate(
    ({ blockSel }) => {
      const all = document.querySelectorAll(blockSel)
      const el = all[all.length - 1]
      if (!el) return null
      const tags = {}
      for (const e of el.querySelectorAll('*')) {
        const t = e.tagName.toLowerCase()
        if (t.includes('-')) tags[t] = (tags[t] || 0) + 1
      }
      // Look for download affordances the way a naive search would, AND the
      // way that actually works: div[role=button] toolbars, not just <a
      // download> and <button>. Missing that is precisely how a real
      // generated file gets mistaken for a code block.
      const affordances = [
        ...document.querySelectorAll(
          'a[download], a[href^="blob:"], button[aria-label], [role="button"][aria-label], [data-tooltip]'
        ),
      ]
        .map((e) => ({
          tag: e.tagName.toLowerCase(),
          role: e.getAttribute('role'),
          label: (e.getAttribute('aria-label') || e.getAttribute('data-tooltip') || '').trim().slice(0, 44),
          href: (e.getAttribute('href') || '').slice(0, 60),
          download: e.getAttribute('download'),
        }))
        .filter((c) => /download|export|open|copy|baixar|save/i.test(c.label))
      return {
        tags: Object.entries(tags).sort((a, b) => b[1] - a[1]),
        renderedLen: el.innerText.length,
        tables: el.querySelectorAll('table').length,
        codeBlocks: el.querySelectorAll('pre, code').length,
        // KaTeX with no <annotation> means the LaTeX source is NOT in the DOM.
        katex: el.querySelectorAll('.katex, mjx-container, math').length,
        katexAnnotations: el.querySelectorAll('annotation, [data-latex]').length,
        images: el.querySelectorAll('img').length,
        affordances,
        html: el.outerHTML,
      }
    },
    { blockSel: sel.responseBlocks }
  )

  writeFileSync(resolve(dir, 'response.html'), dom?.html ?? '')
  writeFileSync(
    resolve(dir, 'elements.json'),
    JSON.stringify({ prompt, ...dom, html: undefined }, null, 2)
  )
  writeFileSync(
    resolve(dir, 'text.md'),
    [
      `# capture ${id} ${stamp}`,
      '',
      `prompt: ${prompt}`,
      '',
      `## copied (${copied?.length ?? 0} chars) - the provider's own markdown`,
      copied ?? '(copy button produced nothing)',
      '',
      `## rendered innerText (${rendered.length} chars) - lossy`,
      rendered,
    ].join('\n')
  )
  await page.screenshot({ path: resolve(dir, 'page.png'), fullPage: false }).catch(() => {})

  // --- network dump --------------------------------------------------------
  // Every request, not only finished ones: the generation response is a
  // long-lived chunked stream that is often still open when the answer is
  // already complete, so filtering on "finished" drops it.
  log.info('collecting network')
  const probe = (copied ?? rendered).slice(0, 60).replace(/\s+/g, ' ').trim()
  const answerWords = probe
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
    const tag = u.searchParams.get('rpcids') ?? u.pathname.split('/').filter(Boolean).pop() ?? 'root'
    const safe = tag.replace(/[^\w.-]/g, '_').slice(0, 50)
    const holdsAnswer = answerWords.length ? answerWords.every((w) => body.includes(w)) : false
    const sentPrompt = (r.postData ?? '').includes(prompt.slice(0, 24)) ||
      decodeURIComponent(r.postData ?? '').includes(prompt.slice(0, 24))

    writeFileSync(
      resolve(dir, 'net', `${safe}-${r.id.replace(/[^\w]/g, '')}.txt`),
      [
        `URL: ${r.url}`,
        `METHOD: ${r.method}  STATUS: ${r.status}  MIME: ${r.mime}  STREAMED: ${r.streamed}`,
        `HOLDS_ANSWER: ${holdsAnswer}  CARRIES_PROMPT: ${sentPrompt}`,
        '',
        '===== REQUEST BODY =====',
        r.postData ?? '(none)',
        '',
        '===== RESPONSE BODY =====',
        body,
      ].join('\n')
    )
    rows.push({ tag, method: r.method, bytes: body.length, holdsAnswer, sentPrompt })
  }

  // --- report --------------------------------------------------------------
  console.log(`\n=== capture: ${id} ===`)
  console.log(`text      : copied=${copied?.length ?? 0} rendered=${rendered.length} ` +
    `markdown=${!!copied}`)
  console.log(`structure : tables=${dom?.tables} codeBlocks=${dom?.codeBlocks} ` +
    `katex=${dom?.katex} katexAnnotations=${dom?.katexAnnotations} images=${dom?.images}`)
  if (dom?.katex && !dom?.katexAnnotations) {
    console.log('            -> KaTeX carries NO LaTeX source: rendered maths is lossy,')
    console.log('               so the copy path is the only faithful one.')
  }
  const elements = dom?.tags.filter(([t]) => !/^(mat-icon|gem-icon)/.test(t)).slice(0, 8)
  console.log(`elements  : ${elements?.map(([t, n]) => `${t}${n > 1 ? '×' + n : ''}`).join(' ')}`)
  console.log(`affordances (download/open/export):`)
  for (const a of (dom?.affordances ?? []).slice(0, 10)) console.log(`            ${JSON.stringify(a)}`)

  const wire = rows.filter((r) => r.holdsAnswer)
  const sent = rows.filter((r) => r.sentPrompt)
  console.log(`network   : ${rows.length} requests recorded`)
  console.log(`            requests carrying the prompt : ${sent.length ? sent.map((r) => r.tag).join(', ') : 'NONE FOUND'}`)
  console.log(`            payloads containing the answer: ${wire.length ? wire.map((r) => `${r.tag} (${r.bytes}b)`).join(', ') : 'NONE FOUND'}`)
  if (!wire.length) {
    console.log('            -> no wire transport available from page-level traffic;')
    console.log('               DOM extraction is the only route for this provider.')
  }
  console.log(`\nsaved to ${dir}\n`)

  // Close the tab we opened. The throwaway probe scripts this replaces left
  // tabs accumulating in the automation browser until connectOverCDP itself
  // started timing out - a slow failure with no obvious cause.
  await client.detach().catch(() => {})
  await page.close().catch(() => {})
}
