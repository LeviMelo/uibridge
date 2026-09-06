// STRUCTURED FALLBACK: rebuild markdown from the rendered DOM.
//
// Why this exists, and why it is not optional:
//
// The faithful path is the provider's own Copy button, which returns
// canonical markdown. But that path runs through the SYSTEM CLIPBOARD - one
// buffer belonging to the whole machine, which can fail for reasons that have
// nothing to do with this code. Observed directly on this machine: every
// clipboard write reported success and every read came back empty, and
// PowerShell's own Get-Clipboard failed at the same time with a clipboard
// operation error. Windows had simply stopped serving clipboard requests.
//
// With only innerText as a fallback, that outage silently downgrades every
// answer: pipe tables collapse into tab-separated runs and structure is gone.
// For a systematic-review pipeline that is worse than an error, because the
// output still looks plausible.
//
// So this walks the response block and reconstructs markdown from the actual
// elements. Tables, code fences, lists and headings all survive. LaTeX does
// NOT: Gemini's KaTeX output carries no <annotation> and no data-latex, so
// the source is genuinely absent from the DOM - it is marked, not invented.

/**
 * Rebuild markdown for one response turn.
 * Returns { text, lossyMath } - lossyMath is true when maths was rendered but
 * its source could not be recovered, so a caller can flag the answer.
 */
export async function reconstructMarkdown(page, { blocks, text }, index) {
  const block = page.locator(blocks).nth(index)
  if (!(await block.count().catch(() => 0))) return null
  const inner = block.locator(text).first()
  const target = (await inner.count().catch(() => 0)) > 0 ? inner : block

  return target
    .evaluate((root) => {
      let lossyMath = false

      const inlineOf = (node) => {
        let out = ''
        for (const n of node.childNodes) {
          if (n.nodeType === 3) {
            out += n.textContent
            continue
          }
          if (n.nodeType !== 1) continue
          const tag = n.tagName.toLowerCase()
          const cls = n.className?.toString?.() ?? ''

          // Maths: recover the source if the renderer kept it anywhere.
          if (cls.includes('katex') || tag === 'mjx-container' || tag === 'math') {
            const tex =
              n.querySelector('annotation')?.textContent ??
              n.getAttribute('data-latex') ??
              n.querySelector('[data-latex]')?.getAttribute('data-latex')
            if (tex) {
              out += `$${tex.trim()}$`
            } else {
              // Rendered glyphs only. Keep them, but say so rather than
              // passing a mangled formula off as the source.
              lossyMath = true
              out += `$${n.textContent.trim()}$`
            }
            continue
          }
          if (tag === 'code' && !n.closest('pre')) {
            out += '`' + n.textContent + '`'
            continue
          }
          if (tag === 'strong' || tag === 'b') {
            out += '**' + inlineOf(n).trim() + '**'
            continue
          }
          if (tag === 'em' || tag === 'i') {
            out += '*' + inlineOf(n).trim() + '*'
            continue
          }
          if (tag === 'a') {
            const href = n.getAttribute('href')
            const label = inlineOf(n).trim()
            out += href ? `[${label}](${href})` : label
            continue
          }
          if (tag === 'br') {
            out += '\n'
            continue
          }
          out += inlineOf(n)
        }
        return out
      }

      const cell = (el) => inlineOf(el).replace(/\s+/g, ' ').trim().replace(/\|/g, '\|')

      const tableOf = (t) => {
        const rows = [...t.querySelectorAll('tr')]
        if (!rows.length) return ''
        const head = rows[0]
        const headCells = [...head.querySelectorAll('th, td')].map(cell)
        const body = rows
          .slice(1)
          .map((r) => [...r.querySelectorAll('td, th')].map(cell))
          .filter((cs) => cs.length)
        const line = (cs) => `| ${cs.join(' | ')} |`
        return [
          line(headCells),
          `| ${headCells.map(() => '---').join(' | ')} |`,
          ...body.map(line),
        ].join('\n')
      }

      const codeOf = (el) => {
        const pre = el.querySelector('pre') ?? el
        // Gemini's code-block shows its language in a small header; fall back
        // to a class like language-python.
        const label =
          el.querySelector('.code-block-decoration, .header, [class*="lang"]')?.textContent?.trim() ?? ''
        const fromClass = (pre.querySelector('code')?.className ?? '').match(/language-([\w+-]+)/)?.[1]
        const lang = (fromClass ?? label.split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z0-9+-]/g, '')
        const body = (pre.querySelector('code') ?? pre).textContent.replace(/\s+$/, '')
        return '```' + lang + '\n' + body + '\n```'
      }

      const listOf = (el, depth = 0) => {
        const ordered = el.tagName.toLowerCase() === 'ol'
        const pad = '  '.repeat(depth)
        return [...el.children]
          .filter((li) => li.tagName.toLowerCase() === 'li')
          .map((li, i) => {
            const nested = [...li.children].filter((c) => /^(ul|ol)$/i.test(c.tagName))
            const own = inlineOf(li)
              .replace(/\s+/g, ' ')
              .trim()
            const marker = ordered ? `${i + 1}.` : '-'
            const sub = nested.map((n) => listOf(n, depth + 1)).join('\n')
            return `${pad}${marker} ${own}` + (sub ? '\n' + sub : '')
          })
          .join('\n')
      }

      const parts = []
      const walk = (node) => {
        for (const el of node.children) {
          const tag = el.tagName.toLowerCase()
          if (tag === 'table') {
            parts.push(tableOf(el))
          } else if (tag === 'code-block' || tag === 'pre') {
            parts.push(codeOf(el))
          } else if (tag === 'ul' || tag === 'ol') {
            parts.push(listOf(el))
          } else if (/^h[1-6]$/.test(tag)) {
            parts.push('#'.repeat(Number(tag[1])) + ' ' + inlineOf(el).trim())
          } else if (tag === 'p') {
            const t = inlineOf(el).trim()
            if (t) parts.push(t)
          } else if (tag === 'blockquote') {
            parts.push(
              inlineOf(el)
                .trim()
                .split('\n')
                .map((l) => '> ' + l)
                .join('\n')
            )
          } else if (el.querySelector('table, code-block, pre, ul, ol, p, h1, h2, h3, h4, h5, h6')) {
            walk(el)
          } else {
            const t = inlineOf(el).trim()
            if (t) parts.push(t)
          }
        }
      }
      walk(root)

      return { text: parts.filter(Boolean).join('\n\n').trim(), lossyMath }
    })
    .catch(() => null)
}
