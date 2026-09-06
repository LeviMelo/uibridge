// WIRE TRANSPORT: OpenAI's "v1" delta stream.
//
// This is the payoff for looking at the network instead of the pixels.
// chatgpt.com answers over text/event-stream, and the body carries the
// assistant's MARKDOWN SOURCE - the same characters the model produced. So on
// this provider extraction needs no clipboard, no DOM reconstruction, and no
// KaTeX guesswork: the three-tier ladder Gemini needs exists only because
// Gemini's generation never surfaces in page-level traffic at all.
//
// THE FORMAT, as observed on a real exchange rather than assumed:
//
//   event: delta_encoding
//   data: "v1"
//   data: {"type":"resume_conversation_token", ...}      <- control frame
//   event: delta
//   data: {"p":"","o":"add","c":0,"v":{"message":{...}}} <- new channel
//   data: {"c":1,"v":{"message":{...}}}                  <- o,p INHERITED
//   data: {"o":"append","p":"/message/content/parts/0","v":"| PMID | Drug"}
//   data: {"v":"| n |\n"}                                <- o,p INHERITED
//   data: {"o":"patch","v":[{...},{...}]}                <- several at once
//
// THE ONE RULE THAT MATTERS: a delta with no `o` and no `p` inherits both
// from the delta before it. That is the whole compression scheme, and missing
// it is not a subtle bug - a first pass that treated every frame as
// self-describing recovered 29 characters of a 2KB answer and looked like it
// had worked.
//
// `c` selects a channel: one conversation turn carries many messages (user,
// several system, tool calls, assistant reasoning, and the final assistant
// text), each added on its own channel and then patched independently.
//
// CITATIONS arrive inline as private-use sentinels around a marker, with the
// URLs in message.metadata.content_references. That is strictly better than
// scraping chips out of the DOM: they come with the character offsets of the
// span they support, so a claim can be tied to its source.

const SENTINEL_LO = 0xe200
const SENTINEL_HI = 0xe206
const PUA = new RegExp(
  String.fromCharCode(91) +
  String.fromCharCode(SENTINEL_LO) + String.fromCharCode(45) + String.fromCharCode(SENTINEL_HI) +
  String.fromCharCode(93),
  'g'
)

/** Split an SSE body into frames. Tolerates \r\n and missing trailing blank. */
export function parseSSE(raw) {
  const text = (raw ?? '').split(String.fromCharCode(13)).join('')
  const frames = []
  let event = null
  for (const line of text.split(String.fromCharCode(10))) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) {
      frames.push({ event, data: line.slice(5).trim() })
      event = null
    }
  }
  return frames
}

/** Walk a JSON-pointer path, creating nothing: returns [parent, key]. */
function locate(root, path) {
  const parts = (path ?? '').split('/').filter(Boolean)
  let node = root
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i].replace(/~1/g, '/').replace(/~0/g, '~')
    if (node == null) return [null, null]
    node = node[k]
  }
  const last = parts.length ? parts[parts.length - 1].replace(/~1/g, '/').replace(/~0/g, '~') : null
  return [node, last]
}

/**
 * Decode a whole (or partial) stream into the assistant's answer.
 *
 * Written to work on a PARTIAL body too, so the same function can be used
 * while the stream is still open - that is what makes streaming responses
 * possible later without a second implementation.
 */
export function decodeDeltaStream(raw) {
  const channels = new Map()
  let lastOp = null
  let lastPath = null
  let current = null // channel index most recently added/patched
  const out = {
    text: '',
    citations: [],
    conversationId: null,
    title: null,
    messageId: null,
    model: null,
    finished: false,
    frames: 0,
    malformed: 0,
  }

  const apply = (d) => {
    const o = d.o ?? lastOp
    const p = d.p ?? lastPath
    if (d.o != null) lastOp = d.o
    if (d.p != null) lastPath = d.p
    if (d.c != null) current = d.c

    if (o === 'add' || (o == null && d.v && typeof d.v === 'object')) {
      // A new message object on this channel. Root path only, in practice.
      if (!p) {
        channels.set(current ?? channels.size, structuredCloneish(d.v))
        return
      }
    }
    const target = channels.get(current)
    if (!target) return

    if (o === 'patch' && Array.isArray(d.v)) {
      // A batch. Each entry is a full op against the SAME channel, and it
      // must not disturb the inherited op/path of the outer stream.
      const savedOp = lastOp
      const savedPath = lastPath
      for (const sub of d.v) applyInner(target, sub)
      lastOp = savedOp
      lastPath = savedPath
      return
    }
    applyInner(target, { o, p, v: d.v })
  }

  const applyInner = (target, op) => {
    const [parent, key] = locate(target, op.p)
    if (parent == null || key == null) return
    if (op.o === 'append' || op.o == null) {
      if (typeof op.v === 'string') parent[key] = (parent[key] ?? '') + op.v
      else if (Array.isArray(op.v)) parent[key] = [...(parent[key] ?? []), ...op.v]
      else if (op.v && typeof op.v === 'object') parent[key] = { ...(parent[key] ?? {}), ...op.v }
    } else if (op.o === 'replace' || op.o === 'add') {
      parent[key] = op.v
    }
  }

  for (const f of parseSSE(raw)) {
    if (!f.data) continue
    if (f.data === '[DONE]') {
      out.finished = true
      continue
    }
    let j
    try {
      j = JSON.parse(f.data)
    } catch {
      // A partial final line is expected while the stream is still open.
      out.malformed++
      continue
    }
    out.frames++
    if (typeof j !== 'object' || j === null) continue

    // Control frames describe the turn rather than mutating it.
    if (j.type) {
      if (j.conversation_id) out.conversationId = j.conversation_id
      if (j.type === 'title_generation' && j.title) out.title = j.title
      continue
    }
    apply(j)
  }

  // THE ANSWER is the last assistant message whose content is plain text. A
  // turn also carries system messages, tool calls and the assistant's own
  // reasoning channels; taking "the last assistant message" without checking
  // the content type returns a tool call or a thought.
  let best = null
  for (const msg of channels.values()) {
    const m = msg?.message
    if (m?.author?.role !== 'assistant') continue
    if (m?.content?.content_type !== 'text') continue
    const text = (m.content.parts ?? []).filter((x) => typeof x === 'string').join('')
    if (text.trim()) best = { m, text }
  }

  if (best) {
    out.messageId = best.m.id ?? null
    // THE MODEL, FROM THE SERVER. Not a picker label read back off a button:
    // the slug the backend says answered. This is the provenance a methods
    // section needs, and it is the one thing the DOM could never give
    // honestly - on Gemini the same fact costs a retry loop and still ends up
    // "unverified" when the UI drops a switch.
    out.model = best.m.metadata?.model_slug ?? null

    // Citation markers are protocol, not prose. Removing only the sentinels
    // leaves "citeturn638403search2" sitting in the middle of a table cell.
    // The whole span goes, and the position it occupied is remembered so a
    // citation can still be tied to the point in the text it supports -
    // offsets into the RAW text would be wrong the moment anything is
    // stripped.
    const { text, marks } = stripMarkers(best.text)
    out.text = text
    const refs = best.m.metadata?.content_references ?? []
    out.citations = refs
      .map((r) => {
        const url = r?.url ?? r?.safe_urls?.[0] ?? r?.refs?.[0]?.url ?? null
        if (!url || r.invalid) return null
        const at = marks.find((mk) => mk.matched === r.matched_text)
        return {
          at: at ? at.index : null,
          title: r.title ?? r.alt ?? null,
          url,
        }
      })
      .filter(Boolean)
    // Markers whose reference was withheld (the server marks them invalid
    // with no URL) are counted rather than silently forgotten: the answer
    // claimed a source that was not delivered, and a caller weighing the text
    // deserves to know that happened.
    out.unresolved_markers = marks.length - out.citations.length
  }
  return out
}

/**
 * Remove citation marker spans, remembering where each one stood.
 *
 * A marker looks like <PUA200>cite<PUA202>turn638403search2<PUA201> in the
 * raw text. Stripping only the sentinel characters - the obvious first
 * implementation - leaves "citeturn638403search2" inside a table cell, which
 * then travels all the way into a CSV as if the model had written it.
 */
export function stripMarkers(raw) {
  const LO = String.fromCharCode(SENTINEL_LO)
  const HI = String.fromCharCode(0xe201)
  const marks = []
  let text = ''
  let i = 0
  while (i < raw.length) {
    const start = raw.indexOf(LO, i)
    if (start === -1) {
      text += raw.slice(i)
      break
    }
    let end = raw.indexOf(HI, start)
    if (end === -1) {
      // An unterminated marker means the stream is still open mid-marker.
      // Drop the tail rather than emitting half a sentinel.
      text += raw.slice(i, start)
      break
    }
    text += raw.slice(i, start)
    marks.push({ matched: raw.slice(start, end + 1), index: text.length })
    i = end + 1
  }
  // Any stray sentinel outside a well-formed span still has to go.
  return { text: text.replace(PUA, ''), marks }
}

/** structuredClone is not available in every runtime this may run in. */
function structuredCloneish(v) {
  try {
    return structuredClone(v)
  } catch {
    return JSON.parse(JSON.stringify(v))
  }
}
