// THE FILE CARD: the direct route to a generated file on a reloaded thread.
//
// ChatGPT shows every generated file twice: as the model's own link in the
// answer text (`button.behavior-btn`), and as a CARD under the message - a
// button labelled with the file's NAME, followed by a download control. This
// project was built around the link alone. The card was pointed out by the
// user on 2026-09-10, and measured the same day; see `_fileCard` in
// ../providers/chatgpt/selectors.json for the numbers.
//
// Why it matters: on a RELOADED thread the link issues no request at all - it
// only opens a preview panel - while the card's control fetches the file at
// once. One hover and one click, no panel to open and close, and the control
// is found from the file's NAME rather than from a label, so it does not
// depend on the UI language the way the panel's "Baixar" button does.

import { mkdirSync, statSync } from 'node:fs'
import { captureDownload } from './download.mjs'

// A value for a double-quoted CSS attribute selector. A file name can hold any
// character, and a quote or backslash in one must not end the selector early.
const BS = String.fromCharCode(92)
const cssString = (s) => String(s).split(BS).join(BS + BS).split('"').join(BS + '"')

/**
 * The file names of every card inside `scope`.
 *
 * `spec.card.control` matches each card's download control; the file's own
 * button is that control's wrapper's previous sibling - the measured shape
 * `button[aria-label=<name>] + div > span > button`.
 */
export async function cardNames(scope, spec) {
  if (!spec?.card?.control) return []
  return scope.locator(spec.card.control).evaluateAll((els) =>
    els.map((el) => el.parentElement?.parentElement?.previousElementSibling?.getAttribute('aria-label') ?? null)
  ).catch(() => [])
}

/**
 * Which card a file link refers to.
 *
 * The link's label is the model's own text ("Download guide_demo.csv"), so it
 * usually CONTAINS the file name - but it is prose, not an identifier. With a
 * single card there is nothing to choose. With several, a name the label
 * contains is accepted only when exactly one remains after dropping names
 * that are merely part of a longer match ("a.csv" inside "data.csv").
 * Anything else is null: guessing which file a link meant would put the
 * wrong bytes under the right name.
 */
export function cardFor(names, label) {
  const unique = [...new Set((names ?? []).filter(Boolean))]
  if (unique.length === 1) return unique[0]
  const text = String(label ?? '')
  const hits = unique.filter((n) => text.includes(n))
  const longest = hits.filter((h) => !hits.some((o) => o !== h && o.includes(h)))
  return longest.length === 1 ? longest[0] : null
}

/**
 * Download one generated file through its card.
 *
 * Two measured facts shape this:
 *   - the control's wrapper is pointer-events:none and opacity:0 until the
 *     card is HOVERED. A click without the hover timed out with no request;
 *     hovering the file's button first made the same click work.
 *   - the bytes arrive as a BROWSER download - the wire tap sees the request,
 *     then ERR_ABORTED - so they are taken from Chrome's download event. The
 *     metadata response before them IS an ordinary fetch, so when a tap is
 *     given it is read for the file's MIME type. Only `mime_type` is kept;
 *     the rest of that body is never logged.
 *
 * Returns a file entry, or null when there is no measured card, or no card for
 * that name: null means "not this route", so the caller tries the next one.
 */
export async function downloadFromCard(page, spec, { scope = page, name, tap = null, dir = 'downloads', downloadMs = 30000, log } = {}) {
  const card = spec?.card
  if (!card?.file || !card?.download || !name) return null
  const fill = (template) => template.split('{name}').join(cssString(name))
  const file = scope.locator(fill(card.file)).first()
  const control = scope.locator(fill(card.download)).first()
  if (!(await control.count().catch(() => 0))) return null

  const meta = tap && spec.metadataPattern ? tap.expect(spec.metadataPattern) : null
  try {
    mkdirSync(dir, { recursive: true })
    const saved = await captureDownload(page, async () => {
      await file.hover({ timeout: 5000 })
      await control.click({ timeout: 8000 })
    }, { dir, timeout: downloadMs })
    const bytes = statSync(saved.path).size
    let mime = null
    const described = await meta?.finished(3000).catch(() => null)
    if (described?.ok) {
      try { mime = JSON.parse(described.body).mime_type ?? null } catch { /* the bytes are what matter */ }
    }
    log?.debug(`saved generated file ${saved.name} (${bytes} bytes) from its file card`)
    return { name: saved.name, path: saved.path, bytes, mime, source: 'browser' }
  } finally {
    meta?.stop?.()
  }
}
