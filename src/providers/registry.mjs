// Provider registry.
//
// The only place that knows which providers exist. Adding one means adding a
// directory and one line here - nothing else in the codebase changes, which
// is the property the whole redesign is for.

import GeminiProvider from './gemini/index.mjs'
import ChatGPTProvider from './chatgpt/index.mjs'
import EchoProvider from './echo/index.mjs'

// The scripted provider is only reachable when a process asks for it. It is
// how the HTTP contract, the CLI and the durable request layer are certified
// without sending anything to a real site - see its own file for why that
// matters - and it must never appear in an ordinary run, where a caller who
// picked it by accident would get answers from nothing at all.
const CLASSES = [GeminiProvider, ChatGPTProvider, ...(process.env.UIBRIDGE_TEST_PROVIDER ? [EchoProvider] : [])]

export const providerIds = CLASSES.map((C) => C.id)

export function providerClass(id) {
  return CLASSES.find((C) => C.id === id) ?? null
}

/**
 * Model ids the API advertises, e.g. "gemini-flash", "chatgpt-4o".
 *
 * A provider's own id is also accepted as a model ("gemini"), meaning
 * "whatever the UI is already on" - useful when you do not care.
 */
export function modelCatalogue() {
  const out = []
  for (const C of CLASSES) {
    // An uncalibrated provider is NOT advertised. /v1/models is a promise
    // that these ids work; listing one whose selectors are still
    // placeholders means a caller picks it, gets a 501, and reasonably
    // concludes the bridge is broken. It exists in the tree, not in the
    // catalogue - `uibridge doctor` is where you see it and its state.
    if (C.selectors?.calibrated === false && C !== EchoProvider) continue
    out.push({ id: C.id, provider: C.id, model: null })
    for (const model of Object.keys(C.selectors?.models ?? {})) {
      out.push({ id: model, provider: C.id, model })
    }
  }
  return out
}

/** Resolve a requested model id to { provider, model }. */
export function resolveModel(requested, fallbackProvider) {
  const hit = modelCatalogue().find((m) => m.id === requested)
  if (hit) return { provider: hit.provider, model: hit.model, matched: true }
  // Resolution remains pure; the HTTP boundary rejects matched:false. A
  // silent fallback would run a systematic-review row on an unintended
  // provider/model, which provenance can report but cannot undo.
  return { provider: fallbackProvider, model: null, matched: false }
}
