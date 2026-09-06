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

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'

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
  return n || fallback
}

/** Avoid clobbering: a.csv, a (2).csv, a (3).csv - like a browser would. */
function uniquePath(dir, name, taken) {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  let n = 2
  while (taken.has(candidate.toLowerCase())) candidate = `${stem} (${n++})${ext}`
  taken.add(candidate.toLowerCase())
  return resolve(dir, candidate)
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
    ackMs = 4000,
    log,
  } = {}
) {
  // ARMED BEFORE THE CLICK. A capture opened afterwards can only ever see
  // the next download, which on a turn with two files means the wrong bytes
  // under the right name.
  const meta = metaPattern ? tap.expect(metaPattern) : null
  const content = tap.expect(contentPattern)
  try {
    // VERIFY THE EFFECT, NOT THE CLICK. A click that Playwright reports as
    // successful can still be swallowed - measured repeatedly here, right
    // after a modal was dismissed, where the app re-renders the message and
    // the first click reaches a node with no handler yet. The observable
    // that matters is the page ISSUING the request, so wait a moment for
    // that and click again if it never came.
    let sent = null
    for (let i = 1; i <= attempts && !sent; i++) {
      await trigger()
      sent = await content.request(ackMs).catch(() => null)
      if (!sent && i < attempts) log?.debug(`the click did not make the page fetch the file; trying again (${i}/${attempts})`)
    }
    if (!sent) {
      throw new Error(
        `${attempts} clicks on the download link produced no request - the page never asked for the file`
      )
    }
    const res = await content.finished(timeoutMs)
    if (!res.ok) {
      throw new Error(`the site answered HTTP ${res.status ?? res.error} for the file itself`)
    }

    let declared = null
    let mime = res.headers['content-type'] ?? res.mime ?? null
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
    const path = uniquePath(dir, name, taken)
    writeFileSync(path, res.buffer)
    log?.debug(`saved generated file ${name} (${res.buffer.length} bytes) from the wire`)
    return { name, path, bytes: res.buffer.length, mime, source: 'wire' }
  } finally {
    content.stop()
    meta?.stop()
  }
}
