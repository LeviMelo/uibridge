import { BridgeError } from './errors.mjs'

export const normalizeComposerText = (text) => text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim()

export async function readComposer(composer) {
  return composer.evaluate((el) => {
    if (typeof el.value === 'string') return el.value
    // Quill and ProseMirror represent input lines with <p> blocks. innerText
    // includes their visual paragraph spacing, which is not submitted text.
    const nodes = [...el.childNodes]
    if (nodes.length && nodes.every((n) => n.nodeName === 'P')) {
      return nodes.map((p) => p.childNodes.length === 1 && p.firstChild.nodeName === 'BR' ? '' : p.innerText).join('\n')
    }
    return el.innerText
  })
}

/**
 * Write the prompt as the editor's own paragraphs, where the composer is a
 * ProseMirror editor, and announce the change; true when it did.
 *
 * MEASURED 2026-09-18 on ChatGPT: fill() goes through the editor at about
 * 0.1 s per LINE, whatever the line's length - one 28 KB line took 0.1 s, the
 * same 28 KB in 330 lines 35 s in a quiet tab, and past 120 s under a busy
 * browser (compose_failed on long multi-line follow-up turns). Written as
 * <p> nodes, 342 lines took 0.6 s, the editor kept them (a key typed after
 * appends to them), and a prompt sent this way was in the provider's own
 * transcript exactly: indentation, repeated spaces, < and &, blank lines,
 * tabs. The caller still reads the composer back before anything is sent.
 */
async function placeAsParagraphs(composer, prompt) {
  const placed = await composer.evaluate((el, text) => {
    if (!el?.isContentEditable || !el.classList?.contains('ProseMirror')) return false
    const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    el.focus()
    el.innerHTML = text.split('\n').map((l) => (l ? `<p>${esc(l)}</p>` : '<p><br></p>')).join('')
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    return true
  }, prompt.replace(/\r\n?/g, '\n')).catch(() => false)
  return placed === true
}

const holds = async (composer, prompt) =>
  normalizeComposerText((await readComposer(composer).catch(() => '')) ?? '') === normalizeComposerText(prompt)

/** Replace stale input and verify the complete prompt, including its tail. */
export async function fillComposer(composer, prompt) {
  if (await placeAsParagraphs(composer, prompt)) {
    // the editor takes the change in on its next tick
    for (let i = 0; i < 10; i++) {
      if (await holds(composer, prompt)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  // Typing through the editor: its time grows with the lines (see above).
  const timeout = Math.max(120000, 400 * prompt.split('\n').length)
  try {
    await composer.fill(prompt, { timeout })
  } catch {
    // Playwright includes the full fill() argument in its exception. Never
    // expose scientific input in daemon logs or error responses.
    throw new BridgeError(`Could not place the complete prompt in the editor within ${Math.round(timeout / 1000)}s; nothing was submitted`, {
      status: 502, code: 'compose_failed', retryable: true,
      detail: { expected_characters: prompt.length },
    })
  }
  const actual = await readComposer(composer)
  if (normalizeComposerText(actual ?? '') !== normalizeComposerText(prompt)) {
    throw new BridgeError('The composer did not retain the complete prompt; nothing was submitted', {
      status: 502, code: 'compose_failed', retryable: true,
      detail: { expected_characters: prompt.length, actual_characters: actual?.length ?? 0 },
    })
  }
}
