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
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new RequestError('each message must be an object')
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(m.role)) throw new RequestError('Unsupported message role')
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) throw new RequestError('message content must be text or text parts')
    if (m.tool_calls || m.function_call || m.name || m.refusal || m.audio) throw new RequestError('Only unnamed text messages are supported')
    if (Array.isArray(m.content) && m.content.some((c) =>
      !c || typeof c !== 'object' || c.type !== 'text' || typeof c.text !== 'string'
    )) throw new RequestError('message content parts must be objects with string text')
    const content =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c) => c.text ?? '').filter(Boolean).join('\n')
          : ''
    if (!content.trim()) continue
    if (m.role === 'user' && messages.length === 1) parts.push(content)
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
  if (Object.values(modes).some((v) => typeof v !== 'boolean')) throw new RequestError('mode values must be booleans')
  return { ...modes }
}

export function readThreadId(body) {
  // `threadId` too: three sibling routes accepted three different
  // spellings of the same field, so a caller that worked against one
  // endpoint silently started a new conversation on another.
  const value = body.thread_id ?? body.threadId ?? body._uibridge?.thread_id ?? null
  if (value !== null && typeof value !== 'string') throw new RequestError('thread_id must be a string')
  if (value !== null && !/^[A-Za-z0-9_-]+$/.test(value)) throw new RequestError('thread_id must be a non-empty native identifier')
  return value
}

/**
 * Build the response.
 *
 * The OpenAI envelope is standard so existing clients work unchanged.
 * Everything specific lives under `_uibridge`, which is where the honesty is:
 * what the UI was actually set to, whether the text is real markdown or a
 * lossy fallback, whether it really browsed, and what files came back.
 */
export function completionResponse({ modelId, result, provider, unsupported = [] }) {
  return {
    id: `chatcmpl-${result.request_id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: result.truncated ? 'length' : 'stop',
      },
    ],
    // Token counts are not observable through a UI. Present and zero so
    // clients that read usage do not crash; never invented.
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _uibridge: {
      provider,
      request_id: result.request_id,
      // Parameters the caller sent that a chat UI has no control for. Empty
      // in the ordinary case; never silently dropped.
      unsupported_parameters: unsupported,
      input: result.input ?? null,
      thread_id: result.thread_id,
      ledger: result.ledger ?? null,
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
      extraction_warning: result.extraction_warning ?? null,
      markdown: result.markdown,
      // True when maths was rendered but its source is not in the DOM, so the
      // formula is glyphs rather than LaTeX. Never silently pretended.
      lossy_math: result.lossy_math ?? false,
      // Session/CLI results retain this flag. The HTTP boundary rejects
      // recognised provider error notices with 502 instead of success.
      provider_error: result.provider_error ?? false,
      // A short answer that opens like a provider failure but matches no
      // MEASURED pattern. Reported, never silently promoted to an error:
      // quarantine it, or set providers.<id>.failOnSuspectedProviderError.
      provider_error_suspected: result.provider_error_suspected ?? false,
      provider_error_match: result.provider_error_match ?? null,
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
      // The site's own "too many requests" notice, when it was showing. The
      // request still went through (new chats work while it shows); a batch
      // seeing this should slow down.
      throttle_notice: result.throttle_notice ?? null,
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

/**
 * One model, the way `client.models.retrieve(id)` expects it.
 *
 * The official SDKs have this call, so a client that uses it to check a model
 * exists before sending got a 404 from a server that does in fact serve that
 * model. Same records as the list, addressed singly.
 */
export function modelResponse(catalogue, id) {
  const found = catalogue.find((m) => m.id === id)
  if (!found) return null
  return { id: found.id, object: 'model', created: 0, owned_by: found.provider }
}

/** OpenAI-compatible SSE chunks. Metadata is attached to the final chunk. */
export function completionChunk({ id, modelId, delta = {}, finishReason = null, bridge = undefined }) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  if (bridge !== undefined) chunk._uibridge = bridge
  return chunk
}

/**
 * Turn a cumulative text snapshot into an append-only SSE delta.
 * OpenAI content chunks have no replace operation, so a rewrite must be
 * surfaced instead of emitting bytes that reconstruct a false answer.
 */
export function contentDelta(previous, current) {
  if (!current.startsWith(previous)) return { delta: '', next: previous, rewritten: true }
  return { delta: current.slice(previous.length), next: current, rewritten: false }
}
