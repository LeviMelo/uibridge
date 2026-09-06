// OpenAI wire-format mapping. Pure functions - no browser, no I/O.
//
// Kept separate from the server so the shape of the contract is testable
// without starting anything, and so a second API dialect could be added
// without touching request handling.

import { RequestError } from '../core/errors.mjs'
import { extractJSON } from '../core/markdown.mjs'

/**
 * Flatten OpenAI messages into one prompt.
 *
 * These UIs have no system role and no real multi-turn API, so a
 * conversation has to arrive as a single turn. Roles are labelled rather than
 * dropped: losing "system" silently changes what the caller asked for.
 */
export function flattenMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new RequestError('messages must be a non-empty array')
  }
  const parts = []
  for (const m of messages) {
    const content =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c) => c.text ?? '').filter(Boolean).join('\n')
          : ''
    if (!content.trim()) continue
    if (m.role === 'user' || messages.length === 1) parts.push(content)
    else if (m.role === 'system') parts.push(`[system]\n${content}`)
    else parts.push(`[${m.role}]\n${content}`)
  }
  if (!parts.length) throw new RequestError('no message content to send')
  return parts.join('\n\n')
}

/** Attachments: local paths. Validated later, against the filesystem. */
export function readAttachments(body) {
  const raw = body.attachments ?? body.files ?? []
  if (!Array.isArray(raw)) throw new RequestError('attachments must be an array of file paths')
  if (raw.some((f) => typeof f !== 'string')) throw new RequestError('each attachment must be a path string')
  return raw
}

/** Modes, e.g. {"thinking": true}. Unknown ones are reported, not ignored. */
export function readModes(body) {
  const modes = body.modes ?? {}
  if (typeof modes !== 'object' || Array.isArray(modes)) throw new RequestError('modes must be an object')
  return Object.fromEntries(Object.entries(modes).map(([k, v]) => [k, !!v]))
}

/**
 * Build the response.
 *
 * The OpenAI envelope is standard so existing clients work unchanged.
 * Everything specific lives under `_uibridge`, which is where the honesty is:
 * what the UI was actually set to, whether the text is real markdown or a
 * lossy fallback, whether it really browsed, and what files came back.
 */
export function completionResponse({ modelId, result, provider }) {
  return {
    id: `chatcmpl-${result.request_id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      { index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' },
    ],
    // Token counts are not observable through a UI. Present and zero so
    // clients that read usage do not crash; never invented.
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _uibridge: {
      provider,
      request_id: result.request_id,
      elapsed_ms: result.elapsed_ms,
      // PROVENANCE: what the UI was actually on, read back from its own
      // controls after model and modes were applied. Requested is not
      // applied, and for a systematic review the difference is the audit
      // trail - it belongs in a methods section.
      provenance: result.provenance,
      // WHICH extraction tier produced the text:
      //   copy         the provider's own canonical markdown (best)
      //   dom-markdown rebuilt from elements - tables/fences/lists intact,
      //                used when the system clipboard is unavailable
      //   rendered     innerText, structure lost (last resort)
      extraction: result.extraction ?? 'copy',
      markdown: result.markdown,
      // True when maths was rendered but its source is not in the DOM, so the
      // formula is glyphs rather than LaTeX. Never silently pretended.
      lossy_math: result.lossy_math ?? false,
      // TRUE when the delivered text is the provider's own error notice
      // ("Sorry, something went wrong...") rather than an answer. It is
      // still returned as content and still a 200: the UI produced a message
      // and the bridge retrieved it, which is all this layer promises. What
      // to do about it - retry, skip the row, log it - is the caller's
      // policy, and this flag is so that policy needn't match on prose.
      provider_error: result.provider_error ?? false,
      tables: result.tables,
      code_blocks: result.code_blocks,
      // Files the PROVIDER generated, already on disk.
      files: result.files,
      // What it actually did, not what it was told to do. These are two
      // different facts: `searched` means a search was attempted, `browsed`
      // means the answer carries citations. A reply can do the first without
      // the second, and reporting them as one claimed citations that were
      // never there.
      browsed: result.browsed,
      searched: result.searched ?? false,
      sources: result.sources,
      // On a wire transport each citation carries `at`: the character offset
      // in `content` where the claim it supports is made.
      citations: result.citations ?? [],
      // The stream ended before the site said it was done.
      truncated: result.truncated ?? false,
      json: extractJSON(result.text),
    },
  }
}

export function modelsResponse(catalogue) {
  return {
    object: 'list',
    data: catalogue.map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: m.provider,
    })),
  }
}
