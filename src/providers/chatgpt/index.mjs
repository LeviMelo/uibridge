// CHATGPT
//
// Structurally complete, deliberately NOT enabled: its selectors are
// placeholders rather than values read off the live page.
//
// It refuses to run until calibrated, instead of appearing to work. That is
// the direct lesson from the Gemini work, where guessed selectors always
// surfaced as a timeout somewhere else and cost hours of looking in the wrong
// place. A clear "not calibrated" beats a plausible-looking hang.
//
// Note what is NOT here: no request flow, no completion detection, no
// extraction, no upload logic. All of that is generic and inherited. Bringing
// this provider up is a calibration job (selectors.json), not a coding one -
// which is the whole point of the redesign.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DomProvider } from '../dom-provider.mjs'
import { BridgeError } from '../../core/errors.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export default class ChatGPTProvider extends DomProvider {
  static id = 'chatgpt'
  static selectors = JSON.parse(readFileSync(resolve(HERE, 'selectors.json'), 'utf8'))
  static defaults = { settleChecks: 4, concurrency: 2 }

  capabilities() {
    return { ...super.capabilities(), calibrated: !!this.sel.calibrated }
  }

  async open(page) {
    if (!this.sel.calibrated) {
      throw new BridgeError(
        'The chatgpt provider is not calibrated yet: its selectors are placeholders, ' +
          'not values read from the live page. Run "uibridge capture chatgpt", fill in ' +
          'src/providers/chatgpt/selectors.json, and set calibrated:true.',
        { status: 501, code: 'not_calibrated' }
      )
    }
    return super.open(page)
  }
}
