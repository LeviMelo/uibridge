// Typed errors.
//
// The point is that a caller can BRANCH on them. The prototype threw bare
// Error with prose, so the HTTP layer could not tell "you are signed out"
// (fix: log in) from "Gemini is slow" (fix: retry) from "that file does not
// exist" (fix: your bug), and answered 502 for all three.
//
// `status` is the HTTP code the API layer should use. `retryable` says whether
// trying again could plausibly work.

export class BridgeError extends Error {
  constructor(message, { status = 500, code = 'bridge_error', retryable = false, detail } = {}) {
    super(message)
    this.name = this.constructor.name
    this.status = status
    this.code = code
    this.retryable = retryable
    if (detail !== undefined) this.detail = detail
  }

  toJSON() {
    return {
      error: { message: this.message, type: this.code, retryable: this.retryable, ...(this.detail ? { detail: this.detail } : {}) },
    }
  }
}

/** The provider needs a human to sign in. No amount of retrying fixes it. */
export class SignedOutError extends BridgeError {
  /**
   * Carries the EVIDENCE, not just the verdict.
   *
   * "Not signed in" invites the reply "yes I am, look at my browser". Naming
   * what was actually observed - no session cookie, the anonymous bundle
   * being served - turns an argument into an instruction. The message is
   * built by signedOutMessage() so the terminal, the HTTP body and the log
   * all say exactly the same thing.
   */
  constructor(provider, message) {
    super(message ?? `Not signed in to ${provider}. Run: uibridge login ${provider}`, {
      status: 401,
      code: 'signed_out',
    })
    this.provider = provider
    this.action = `uibridge login ${provider}`
  }

  toJSON() {
    const base = super.toJSON()
    if (base?.error) base.error.action = this.action
    return base
  }
}

/** An interstitial (unusual traffic, consent wall, CAPTCHA) is in the way. */
export class ChallengeError extends BridgeError {
  constructor(provider, what) {
    super(
      `${provider} is showing a verification challenge (${what}). ` +
        'Open the browser window and clear it yourself, then retry.',
      { status: 503, code: 'challenge', retryable: true }
    )
  }
}

/** The caller's request is wrong: bad model, missing file, empty messages. */
export class RequestError extends BridgeError {
  constructor(message, detail) {
    super(message, { status: 400, code: 'invalid_request', detail })
  }
}

/** A wait exceeded its budget. */
export class TimeoutError extends BridgeError {
  constructor(what, ms) {
    super(`Timed out after ${(ms / 1000).toFixed(0)}s waiting for ${what}`, {
      status: 504,
      code: 'timeout',
      retryable: true,
    })
  }
}

/**
 * A DOM contract we depend on is gone - the UI changed under us.
 *
 * This exists to make UI drift LOUD and specific. In the prototype a moved
 * selector surfaced as a generic timeout, so debugging started from
 * "something is slow" instead of "sendButton no longer matches".
 */
export class ContractError extends BridgeError {
  constructor(provider, key, selector) {
    super(
      `${provider}: UI contract "${key}" no longer matches anything ` +
        `(selector: ${selector}). The UI has changed - update the provider's selectors.`,
      { status: 502, code: 'ui_contract' }
    )
    this.key = key
    this.selector = selector
  }
}
