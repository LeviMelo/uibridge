// DOM TRANSPORT
//
// Extraction by reading the rendered page. Generic primitives, driven by a
// provider's selector contract - no provider names in here.
//
// WHAT WAS LEARNED THE HARD WAY, because it dictates the shape of this file:
//
// 1. innerText IS LOSSY, and not marginally. Measured on one response:
//      innerText : "t ^ 2 = C Q-(k-1)"  and a table as tab-separated runs
//      copy      : "$\hat{\tau}^2 = \frac{Q-(k-1)}{C}$"  and "| PMID | n |"
//    KaTeX keeps NO <annotation> and NO data-latex in Gemini's output, so the
//    LaTeX source is genuinely unrecoverable from rendered DOM. The message
//    "Copy" button returns the provider's own canonical markdown. So copy is
//    the primary path and innerText only the fallback, and we always report
//    which one produced the text.
//
// 2. THE CLIPBOARD IS ONE SHARED BUFFER for the whole machine. Two tabs
//    copying at once read each other's answer, which under concurrency looks
//    exactly like the model replying to the wrong prompt. Hence the mutex,
//    and hence a length sanity-check against what is on screen.
//
// 3. A "GENERATED FILE" IS NOT A LINK. There is no <a download> and no blob:
//    href anywhere in the response, so searching for download affordances
//    finds nothing and it is easy to conclude - wrongly - that the provider
//    only produced a code block. The bytes sit behind an "Open" control that
//    opens a viewer overlay whose toolbar is div[role=button]. Clicking its
//    Download control fires a real browser download.

import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Mutex, waitFor } from '../core/async.mjs'
import { ContractError } from '../core/errors.mjs'

// Process-wide: the clipboard is a machine resource, not a per-tab one.
const clipboard = new Mutex()

/** Number of matches, without throwing on a mid-render detach. */
export const count = (page, sel) =>
  page
    .locator(sel)
    .count()
    .catch(() => 0)

/** Assert a selector still matches something, so UI drift fails loudly. */
export async function requireSelector(page, provider, key, sel) {
  if (!(await count(page, sel))) throw new ContractError(provider, key, sel)
}

/**
 * Is the provider still generating?
 *
 * isVisible() is an IMMEDIATE state read - never give it a timeout. With one,
 * a busy page makes the call time out and throw; if the catch then answers
 * "not generating", the driver stops reading mid-stream and returns half an
 * answer (this produced truncated JSON until it was fixed). So: no timeout,
 * and on any error assume generation IS still running. Being wrong in that
 * direction costs one more poll; being wrong the other way corrupts output.
 */
export async function isGenerating(page, stopSelector) {
  if (!stopSelector) return false
  try {
    return await page.locator(stopSelector).first().isVisible()
  } catch {
    return true
  }
}

/** innerText of the nth response turn. Lossy - see the header. */
export async function readRenderedText(page, { blocks, text }, index) {
  const block = page.locator(blocks).nth(index)
  if (!(await block.count().catch(() => 0))) return ''
  const inner = block.locator(text).first()
  const target = (await inner.count().catch(() => 0)) > 0 ? inner : block
  return (await target.innerText().catch(() => '')) ?? ''
}

/**
 * Canonical markdown via the message Copy button.
 *
 * `expectLen` is the on-screen length: a copy far shorter than that means we
 * read a stale clipboard (or another tab's), so we reject it and let the
 * caller fall back rather than return someone else's text.
 */
export async function copyMarkdown(page, { copyButton }, { expectLen = 0, pollMs = 150, log } = {}) {
  if (!copyButton) return null
  return clipboard.run(async () => {
    try {
      await page.locator(copyButton).last().click({ timeout: 5000 })
      const text = await waitFor(
        async () => {
          const t = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
          return t && t.trim() ? t : null
        },
        { timeout: 2500, poll: pollMs, what: 'clipboard to fill' }
      )
      if (expectLen && text.length < expectLen * 0.5) {
        log?.warn(`clipboard returned ${text.length} chars for a ${expectLen}-char response; using rendered text`)
        return null
      }
      return text
    } catch {
      return null
    }
  })
}

/**
 * Download files the provider GENERATED, returning bytes on disk.
 *
 * `spec` names the contract:
 *   toolMarker   class present only when the provider's code/file tool ran.
 *                Gating on it means ordinary answers cost nothing - measured
 *                across six output types: present for file and computation
 *                responses, absent for prose, tables, maths and plain code.
 *   chip/name/type/open   the response-side chip and its controls
 *   download/close        the viewer overlay's toolbar controls
 */
export async function downloadGeneratedFiles(page, spec, { dir = 'downloads', waitMs = 20000, downloadMs = 30000, inlineMaxBytes = 262144, pollMs = 150, log } = {}) {
  if (!spec?.chip || !spec?.download) return []
  if (spec.toolMarker && !(await count(page, spec.toolMarker))) return []

  // The chip is built server-side and lags the text. Bounded wait; a tool
  // response that produced no file simply falls through.
  let n = 0
  try {
    n = await waitFor(async () => (await count(page, spec.chip)) || null, {
      timeout: waitMs,
      poll: pollMs,
      what: 'a generated-file chip',
    })
  } catch {
    return []
  }

  mkdirSync(dir, { recursive: true })
  const out = []

  for (let i = 0; i < n; i++) {
    const chip = page.locator(spec.chip).nth(i)
    const declared = spec.name
      ? await chip.locator(spec.name).first().getAttribute('title').catch(() => null)
      : null
    const kind = spec.type
      ? await chip.locator(spec.type).first().innerText().catch(() => null)
      : null

    try {
      await chip.locator(spec.open ?? 'button').first().click({ timeout: 15000 })
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: downloadMs }),
        page.locator(spec.download).first().click({ timeout: 15000 }),
      ])
      const name = dl.suggestedFilename() || declared || `generated-${i}`
      const path = resolve(dir, name)
      await dl.saveAs(path)
      const bytes = statSync(path).size
      const entry = { name, path, bytes, type: kind?.trim() ?? null, text: null }
      // Inline small text payloads: a pipeline usually wants the rows, not a
      // path. Anything large or binary stays on disk only.
      if (bytes <= inlineMaxBytes && /\.(csv|tsv|json|txt|md|xml|ya?ml)$/i.test(name)) {
        entry.text = readFileSync(path, 'utf8')
      }
      out.push(entry)
      log?.info(`retrieved generated file ${name} (${bytes} bytes)`)
    } catch (e) {
      log?.warn(`generated file ${declared ?? i} not retrievable: ${e.message.split('\n')[0]}`)
      out.push({ name: declared, path: null, bytes: null, type: kind, error: 'retrieval failed' })
    }
    // Dismiss the overlay, or it hides the composer for the NEXT request -
    // which surfaces as a composer that exists but never becomes visible.
    if (spec.close) {
      await page.locator(spec.close).first().click({ timeout: 5000 }).catch(() => {})
    }
  }
  return out
}
