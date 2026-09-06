// Markdown structuring.
//
// Pure functions, no browser, unit-tested. They exist because a research
// pipeline wants ROWS, not prose: the caller should not have to re-parse a
// table out of a string that a provider already handed us in a known format.
//
// This only works because extraction returns real markdown. Scraping rendered
// DOM gives tab-separated fragments for a table and, for maths, KaTeX glyphs
// with the LaTeX source discarded - Gemini's rendered output keeps no
// <annotation> and no data-latex, so the source is genuinely unrecoverable
// from the DOM. See transports/dom.mjs.

const NL = String.fromCharCode(10)

/**
 * Parse GitHub-style pipe tables.
 *
 * A table is a header row followed by a delimiter row (|---|---|); requiring
 * the delimiter is what stops ordinary prose containing a pipe from being
 * mistaken for a table.
 */
export function parseTables(md) {
  const out = []
  const lines = (md ?? '').split(NL)
  const isRow = (l) => /^\s*\|/.test(l ?? '')
  const isDelim = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l ?? '')
  const cells = (l) =>
    l
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim())

  for (let i = 0; i < lines.length; i++) {
    if (!isRow(lines[i]) || !isDelim(lines[i + 1])) continue
    const header = cells(lines[i])
    const rows = []
    let j = i + 2
    for (; j < lines.length && isRow(lines[j]); j++) {
      const r = cells(lines[j])
      rows.push(Object.fromEntries(header.map((h, k) => [h, r[k] ?? ''])))
    }
    out.push({ header, rows })
    i = j - 1
  }
  return out
}

/** Fenced code blocks with their language tag. */
export function parseCodeBlocks(md) {
  const out = []
  const re = /```([a-zA-Z0-9_+-]*)\n([^]*?)```/g
  let m
  while ((m = re.exec(md ?? '')) !== null) {
    out.push({ lang: m[1] || null, code: m[2] })
  }
  return out
}

/**
 * Best-effort JSON extraction.
 *
 * Callers that asked for JSON should not have to strip a code fence or a
 * "Here you go:" preamble. Order matters: a fenced block is the most reliable
 * signal, so try it before brace scanning.
 */
export function extractJSON(text) {
  if (!text) return null
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([^]*?)```/g)].map((m) => m[1])
  for (const c of fenced) {
    try {
      return JSON.parse(c.trim())
    } catch {
      /* try the next candidate */
    }
  }
  const first = Math.min(
    ...[text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0).concat(Infinity)
  )
  if (!Number.isFinite(first)) return null
  const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (last <= first) return null
  try {
    return JSON.parse(text.slice(first, last + 1))
  } catch {
    return null
  }
}

/** Inline LaTeX/display maths, so a caller can check fidelity or re-render. */
export function parseMath(md) {
  const out = []
  const display = /\$\$([^]*?)\$\$|\\\[([^]*?)\\\]/g
  const inline = /(?<!\$)\$([^$\n]+?)\$(?!\$)|\\\(([^]*?)\\\)/g
  let m
  while ((m = display.exec(md ?? '')) !== null) out.push({ display: true, tex: (m[1] ?? m[2]).trim() })
  while ((m = inline.exec(md ?? '')) !== null) out.push({ display: false, tex: (m[1] ?? m[2]).trim() })
  return out
}
