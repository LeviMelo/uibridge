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
import { downloadFromPreview } from './dom.mjs'

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

  await unfold(scope, file, card.fold)
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

/**
 * Open the fold a card is hidden behind.
 *
 * A turn shows its first three cards and folds the rest into `div[hidden]`
 * behind a toggle ("Mais 3"), measured 2026-09-18 on a six-file turn. The
 * toggle is found by what it controls, not by its words: `fold` matches a
 * collapsed toggle, and the one whose `aria-controls` element holds this
 * card is clicked. A visible card, or no such toggle, is left alone.
 */
async function unfold(scope, file, fold) {
  if (!fold || (await file.isVisible().catch(() => false))) return
  const id = await file.evaluate((el, sel) => {
    for (const t of document.querySelectorAll(sel)) {
      if (document.getElementById(t.getAttribute('aria-controls'))?.contains(el)) return t.getAttribute('aria-controls')
    }
    return null
  }, fold).catch(() => null)
  if (!id) return
  await scope.locator(`button[aria-controls="${cssString(id)}"]`).first().click({ timeout: 5000 }).catch(() => {})
  await file.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
}

/**
 * A live turn's file whose link fetched nothing: its file card, then the
 * preview panel - the routes `export --files` takes on a reloaded thread.
 *
 * A link can stop fetching on a LIVE turn too. Measured 2026-09-18 on a
 * ChatGPT manuscript turn, the ninth of a long conversation whose earlier
 * turns had made files of the same names: both DOCX links issued no request
 * in three clicks each (the page's last requests were the documents' own
 * embedded images, a preview rendering), while the turn's six file cards
 * stood under it with the plain names. `turn` is the last turn holding a
 * response block. Three clicks on the link can leave its preview open over
 * the turn, so an open panel is closed first. Returns null when neither
 * route yields the file, so the caller reports the link's failure.
 * `routes` is for tests.
 */
export async function fileFromTurn(page, spec, {
  responseBlocks, link = {}, fallbackName, control = null, tap = null, dir = 'downloads', downloadMs = 30000, log,
} = {}, routes = { card: downloadFromCard, preview: downloadFromPreview }) {
  const panel = spec?.previewPanel ? page.locator(spec.previewPanel).first() : null
  if (panel && spec.previewClose && (await panel.isVisible().catch(() => false))) {
    await panel.locator(spec.previewClose).first().click({ timeout: 4000 }).catch(() => {})
  }
  const turn = spec?.card?.scope && responseBlocks
    ? page.locator(spec.card.scope).filter({ has: page.locator(responseBlocks) }).last()
    : null
  const names = turn ? await cardNames(turn, spec) : []
  const name = cardFor(names, fallbackName) ?? cardFor(names, link.label)
  const viaCard = name
    ? await routes.card(page, spec, { scope: turn, name, tap, dir, downloadMs, log }).catch((err) => {
      log?.debug(`the file card did not yield ${name}: ${err.message.split('\n')[0]}`)
      return null
    })
    : null
  if (viaCard) {
    log?.info(`${fallbackName}: its link fetched nothing; taken from its file card`)
    return viaCard
  }
  const viaPreview = await routes.preview(page, spec, { control, dir, downloadMs, log }).catch((err) => {
    log?.debug(`the preview panel did not yield ${fallbackName} either: ${err.message.split('\n')[0]}`)
    return null
  })
  if (viaPreview) log?.info(`${fallbackName}: its link fetched nothing; taken from the preview panel`)
  return viaPreview
}
