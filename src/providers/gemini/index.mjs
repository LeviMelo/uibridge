// GEMINI
//
// Almost everything is the generic DOM flow; what is left here is what is
// genuinely Gemini-specific. Its selector contract is selectors.json, and
// that file plus this one are the only places in the codebase that know
// anything about Gemini.
//
// The quirks worth knowing:
//
//   Model and extended thinking share ONE control, and its aria-label
//   ("Open mode picker, currently Flash", gaining "Extended") is the only
//   readable state for either - hence picker strategy 'combined'.
//
//   Enter does not submit, so the send button is the only path.
//
//   Uploads need a trusted drag: synthetic DragEvents are ignored, and there
//   is no input[type=file] to set.
//
//   A fresh conversation per request, because switching model mid-thread is
//   unreliable on Gemini - it often only takes effect several turns later.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DomProvider } from '../dom-provider.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export default class GeminiProvider extends DomProvider {
  static id = 'gemini'
  static selectors = JSON.parse(readFileSync(resolve(HERE, 'selectors.json'), 'utf8'))

  /** Provider-specific defaults, overridable from config.json. */
  static defaults = {
    // Five identical reads. Gemini streams in bursts with visible pauses, and
    // fewer checks ends a read inside one of those pauses.
    settleChecks: 5,
    concurrency: 2,
    // Spacing between request starts; see the ChatGPT provider for why.
    minIntervalMs: 8000,
    // Gemini accepts a true headless browser with this profile's session
    // (verified live; ChatGPT does not - see its provider).
    headless: true,
  }
}
