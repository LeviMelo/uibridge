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

/** Replace stale input and verify the complete prompt, including its tail. */
export async function fillComposer(composer, prompt) {
  try {
    await composer.fill(prompt, { timeout: 120000 })
  } catch {
    // Playwright includes the full fill() argument in its exception. Never
    // expose scientific input in daemon logs or error responses.
    throw new BridgeError('Could not place the complete prompt in the editor within 120s; nothing was submitted', {
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
