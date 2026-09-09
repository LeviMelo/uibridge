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

/**
 * The machine cannot reach the site (or the browser died). Retrying may work.
 */
export class NetworkError extends BridgeError {
  constructor(message, { code = 'network', retryable = true, detail } = {}) {
    super(message, { status: 503, code, retryable, detail })
  }
}

// Chrome's own net error names, grouped by what the operator should DO.
// MEASURED 2026-09-08: Playwright surfaces these as a plain Error whose first
// line is e.g. "page.goto: net::ERR_NAME_NOT_RESOLVED at https://...", with
// name === "Error" - indistinguishable, to a `catch`, from a bug in this
// code. Untranslated they became HTTP 500 "internal", which tells a caller
// that uibridge is broken when the truth is that the wifi dropped.
const TRANSIENT_NET = /ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_[A-Z_]+|ADDRESS_UNREACHABLE|SOCKET_NOT_CONNECTED|EMPTY_RESPONSE|TIMED_OUT|TOO_MANY_REDIRECTS|HTTP2_[A-Z_]+|QUIC_PROTOCOL_ERROR|SSL_PROTOCOL_ERROR|ABORTED)\b/
// Not transient: something on this machine decided the request may not go.
const BLOCKED_NET = /ERR_(UNSAFE_PORT|BLOCKED_BY_[A-Z_]+|CERT_[A-Z_]+|PROXY_[A-Z_]+|TUNNEL_CONNECTION_FAILED)\b/
const BROWSER_GONE = /(Target|Browser|Page) (page, context or browser )?(has been )?(closed|crashed)|browserType\.launch|Target closed/i

/**
 * Translate a foreign error (Playwright, CDP, Chrome) into a typed one.
 *
 * Returns the original when it is already typed, and null when it is not
 * recognisable - an unrecognised error must stay a 500, because pretending
 * to know what a bug is would hide it.
 */
export function classifyBrowserError(err) {
  if (err instanceof BridgeError) return err
  const message = String(err?.message ?? err ?? '')
  const first = message.split(/[\r\n]/)[0]
  const net = message.match(TRANSIENT_NET)
  if (net) {
    return new NetworkError(
      `The browser could not reach the site (${net[0]}). Check this machine's ` +
        'network connection, then try again.',
      { detail: { chrome_error: net[0] } }
    )
  }
  const blocked = message.match(BLOCKED_NET)
  if (blocked) {
    return new NetworkError(
      `The browser refused the connection (${blocked[0]}) - a proxy, certificate ` +
        'or policy on this machine is blocking it, so retrying will not help.',
      { code: 'network_blocked', retryable: false, detail: { chrome_error: blocked[0] } }
    )
  }
  if (BROWSER_GONE.test(message)) {
    return new NetworkError('The browser closed while the request was running.', {
      code: 'browser_gone',
      detail: { detail: first.slice(0, 200) },
    })
  }
  // Playwright marks its own waits, and they mean the same thing ours do.
  if (err?.name === 'TimeoutError') {
    return new BridgeError(first, { status: 504, code: 'timeout', retryable: true })
  }
  return null
}
