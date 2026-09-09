// GENERATED FILES, TAKEN OFF THE WIRE.
//
// A provider that runs code can emit a real file - a CSV, an xlsx, a plot -
// and for this project that is not a nicety: it is how a table of extracted
// trial data gets out of the chat and into the pipeline without anyone
// retyping it.
//
// WHY THE PAGE CLICKS AND WE ONLY READ:
//
// The download endpoints are NOT satisfied by cookies. Measured directly:
// an in-page `fetch(..., {credentials:'include'})` and Playwright's own
// APIRequestContext both come back
//     401 {"detail":{"message":"Unauthorized - Access token is missing"}}
// because the app adds an Authorization bearer header in its own JavaScript.
// Reproducing that would mean lifting the user's access token out of the
// session and replaying it, which this project does not do - the same rule
// that keeps us from forging the anti-bot tokens.
//
// So the page performs the download, exactly as a person clicking the link
// would, and the bytes are read from the response it receives. We never hold
// a credential, and the flow survives a UI restyling because the payload -
// not the pixels - is what is parsed.
//
// THE FILENAME COMES FROM THE SERVER. content-disposition carries the real
// name (and a UTF-8 form for non-ASCII), which beats scraping a label out of
// the DOM or trusting the model's prose. It is still sanitised, because a
// name that arrives as "../../.profiles/gemini/Cookies" would otherwise be a
// path-traversal write - and the model chooses that name.

import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { basename } from 'node:path'
import { reserveOutputFile } from '../core/output-file.mjs'

/**
 * Links the model wrote in a private scheme, e.g. sandbox:/mnt/data/x.csv.
 *
 * Pure, and driven off the ANSWER TEXT rather than the DOM: the text comes
 * from the stream, so this works before anything is rendered and cannot be
 * broken by a class name changing. Returns [{ label, path }], de-duplicated
 * by path, in the order the answer mentions them.
 */
export function parseSchemeLinks(text, scheme = 'sandbox') {
  const out = []
  const seen = new Set()
  // [label](scheme:/path) - the markdown the model emits for a file it made.
  const re = new RegExp(`\\[([^\\]]*)\\]\\(${scheme}:([^)\\s]+)\\)`, 'g')
  for (const m of (text ?? '').matchAll(re)) {
    const path = m[2]
    if (seen.has(path)) continue
    seen.add(path)
    out.push({ label: m[1], path })
  }
  return out
}

/**
 * The filename a server declares, or null.
 *
 * RFC 5987's `filename*=UTF-8''...` wins over plain `filename=` when both
 * are present, which is the case here and is the only form that survives an
 * accented name.
 */
export function filenameFromDisposition(disposition) {
  if (!disposition) return null
  const star = disposition.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim())
    } catch {
      return star[1].trim()
    }
  }
  const plain = disposition.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i)
  return plain ? (plain[2] ?? plain[1]).trim() : null
}

/**
 * Make a server- or model-supplied name safe to join onto a directory.
 *
 * The name is chosen by the model, so it is untrusted input on a write path.
 * Directory components are dropped, traversal cannot survive, and the
 * reserved Windows device names are avoided because this runs on Windows and
 * writing to "CON" or "NUL" fails in a confusing way.
 */
export function safeFileName(name, fallback = 'download.bin') {
  let n = basename(String(name ?? '').replace(/[\\/]+/g, '/')).trim()
  // Windows-forbidden characters and control characters. Filtered by code
  // point rather than with a regex escape: an escape written here was once
  // mangled into a literal control byte in the source, which is a worse bug
  // than the one it was fixing.
  n = [...n].filter((c) => c.charCodeAt(0) > 31 && !'<>:"|?*'.includes(c)).join('')
  n = n.replace(/^\.+/, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(n)) n = `_${n}`
  if (n.length > 180) {
    const dot = n.lastIndexOf('.')
    const ext = dot > 0 ? n.slice(dot, dot + 12) : ''
    n = n.slice(0, 180 - ext.length) + ext
  }
  return n || (fallback === 'download.bin' ? fallback : safeFileName(fallback))
}


/**
 * "Did the click land?" expressed as something visible on the page.
 *
 * Clicking a file control opens a preview panel, so the panel's appearance is
 * proof the click was received even when no request follows it (the bytes may
 * already have been fetched). Returns null when the provider has no MEASURED
 * panel selector - no signal is honest; a guessed one is worse than none,
 * because a selector that happens to match the page already would report
 * progress unconditionally and suppress every legitimate retry.
 */
export function previewProgressed(page, generatedFile = {}) {
  const sel = generatedFile?.previewPanel
  if (!sel) return null
  return () => page.locator(sel).first().isVisible().catch(() => false)
}

/**
 * Trigger a download in the page and keep the bytes the page received.
 *
 * `trigger` is whatever makes the app fetch the file - a click, in practice.
 * `contentPattern` matches the response carrying the bytes; `metaPattern`,
 * when given, matches a metadata response fetched first (it names the file
 * and its type, which is better than any DOM label).
 *
 * Returns { name, path, bytes, mime, source } or throws with a reason.
 */
export async function captureDownload(
  tap,
  trigger,
  {
    contentPattern,
    metaPattern = null,
    dir,
    timeoutMs = 60000,
    fallbackName = 'download.bin',
    taken = new Set(),
    attempts = 3,
    ackMs = 8000,
    standing = null,
    progressed = null,
    log,
  } = {}
) {
  // WHICH of the standing bodies is THIS file? The collector is per-tab and
  // long-lived, so its queue holds unrelated bodies from the same endpoint -
  // measured: a user's uploaded `_input.csv` sitting in front of the
  // requested `audit_totals.csv`. The server names every body in
  // content-disposition, and the control we are about to click is labelled
  // with the same name, so that is the correlation. When we have no
  // meaningful name to expect, no standing body is used at all: clicking and
  // waiting is slower than guessing, and correct.
  const expected = /^download(-\d+)?\.bin$/i.test(fallbackName) ? null : safeFileName(fallbackName).toLowerCase()
  const isWanted = expected
    ? (rec) => safeFileName(filenameFromDisposition(rec.headers['content-disposition']) ?? '', '').toLowerCase() === expected
    : () => false
  // BYTES MAY ALREADY BE HERE. `standing` is a long-lived collector armed
  // when the tab's tap was created, so it holds any copy of the file that
  // crossed the wire before this call - and on ChatGPT that is the common
  // case, not an edge case: MEASURED 2026-09-08, opening a conversation
  // pre-fetches its generated artifact during page load
  // (files/download -> interpreter/download -> estuary/content), after which
  // clicking the file control issues NO further request. The old code armed
  // a fresh capture, clicked, waited 4s for a request that could never come,
  // clicked twice more and reported "the page never asked for the file"
  // while the bytes sat in the tab it was holding.
  let res = standing?.take(isWanted) ?? null
  const meta = res ? null : metaPattern ? tap.expect(metaPattern) : null
  const content = res ? null : tap.expect(contentPattern)
  try {
    if (res) {
      log?.debug('the file was already on the wire (pre-fetched by the page); no click needed')
    } else {
      // VERIFY THE EFFECT, NOT THE CLICK. A click that Playwright reports as
      // successful can still be swallowed - measured repeatedly here, right
      // after a modal was dismissed, where the app re-renders the message and
      // the first click reaches a node with no handler yet. The observable
      // that matters is the page ISSUING the request, so wait a moment for
      // that and click again if it never came.
      //
      // BUT A RE-CLICK IS NOT FREE. The same control now opens a preview
      // panel, so clicking it again can toggle that panel shut. Between
      // attempts we therefore also accept bytes arriving on the standing
      // collector, and `progressed` lets a caller say "something is
      // happening, keep waiting" instead of clicking into a moving UI.
      let sent = null
      for (let i = 1; i <= attempts && !sent; i++) {
        await trigger()
        sent = await content.request(ackMs).catch(() => null)
        if (!sent && standing?.available(isWanted)) { res = standing.take(isWanted); break }
        if (!sent && i < attempts && (await progressed?.().catch(() => false))) {
          log?.debug('the page reacted but has not fetched yet; waiting instead of clicking again')
          sent = await content.request(ackMs).catch(() => null)
          if (!sent && standing?.available(isWanted)) { res = standing.take(isWanted); break }
        }
        if (!sent && i < attempts) log?.debug(`the click did not make the page fetch the file; trying again (${i}/${attempts})`)
      }
      if (!sent && !res) {
        throw new Error(
          `${attempts} clicks on the download link produced no request - the page never asked for the file`
        )
      }
      if (!res) res = await content.finished(timeoutMs)
    }
    if (!res.ok) {
      throw new Error(`the site answered HTTP ${res.status ?? res.error} for the file itself`)
    }

    let declared = null
    let mime = res.headers['content-type'] ?? res.mime ?? null
    // With pre-fetched bytes there is no paired metadata response to read a
    // server-chosen filename from, so the caller's expected name is used.
    if (meta) {
      // Best-effort: the bytes are what matter, the JSON only names them.
      const m = await meta.finished(5000).catch(() => null)
      if (m?.ok) {
        try {
          const j = JSON.parse(m.body)
          declared = j.file_name ?? null
          mime = j.mime_type ?? mime
        } catch {
          /* not the JSON we expected; the headers still name the file */
        }
      }
    }

    const name = safeFileName(declared ?? filenameFromDisposition(res.headers['content-disposition']) ?? fallbackName, fallbackName)
    mkdirSync(dir, { recursive: true })
    const path = reserveOutputFile(dir, name, taken)
    try { writeFileSync(path, res.buffer) } catch (err) {
      try { unlinkSync(path) } catch {}
      throw err
    }
    log?.debug(`saved generated file ${name} (${res.buffer.length} bytes) from the wire`)
    return { name, path, bytes: res.buffer.length, mime, source: 'wire' }
  } finally {
    content?.stop()
    meta?.stop()
  }
}
