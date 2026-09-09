// SESSION DETECTION, and the prompt that follows from it.
//
// This is the single most consequential check in the bridge, for a reason
// that is easy to miss: THESE UIs WORK WHILE LOGGED OUT. chatgpt.com serves a
// whole anonymous application - its own bundle, its own composer, its own
// model - to a visitor with no account. So a request made against a signed-out
// browser does not fail. It succeeds, quietly, with a different and weaker
// model, and drops the result into a batch of two hundred rows where nothing
// distinguishes it.
//
// Two rules follow, and they shape everything below:
//
//   1. PROVE SIGNED IN. Never infer it from the absence of a login button.
//      The old check did exactly that - `if (!signedOutMarker) return true` -
//      which means an unknown page, a slow page, or a page in an unexpected
//      language all read as "signed in".
//
//   2. RANK THE EVIDENCE. A session token in an httpOnly cookie, or the app's
//      own session endpoint, is authoritative. Text on the page is a guess
//      about a translation. So the strong signals decide, and the weak ones
//      only speak when nothing else does.
//
// The evidence is also what the user is shown. "Not signed in" invites the
// reply "yes I am"; "no session cookie, and the app is serving its anonymous
// bundle" does not.

const NL = String.fromCharCode(10)

/**
 * Gather every signal, ask no questions about what they mean.
 *
 * Deliberately separate from the verdict so the decision is a pure function
 * over plain data - testable without a browser, and printable when a user
 * disagrees with it.
 */
export async function readSessionEvidence(page, auth = {}) {
  const ev = {
    url: page.url(),
    cookies: [],
    endpoint: null,
    anonAsset: null,
    accountMarker: 0,
    signedOutText: null,
    challengeText: null,
    error: null,
  }

  try {
    // COOKIES VIA THE BROWSER CONTEXT, not document.cookie. A session token
    // is always httpOnly, which is precisely what JS cannot read - so the
    // instrument everyone reaches for first is blind to the thing being
    // measured.
    const jar = await page.context().cookies(ev.url).catch(() => [])
    ev.cookies = jar.map((c) => ({ name: c.name, chars: (c.value ?? '').length, httpOnly: !!c.httpOnly }))
    if (auth.authCookiePattern) {
      const re = new RegExp(auth.authCookiePattern)
      ev.authCookies = ev.cookies.filter((c) => re.test(c.name) && c.chars > 0).map((c) => c.name)
    } else {
      ev.authCookies = []
    }

    // THE APP'S OWN SESSION ENDPOINT. Same-origin, called with the page's own
    // credentials - this is the app asking itself who it is, which is as
    // close to authoritative as anything gets from outside.
    if (auth.sessionEndpoint) {
      // THE RESPONSE IS NOT KEPT. chatgpt.com's /api/auth/session answers with
      // a banner of its own saying the payload is sensitive and grants
      // access - it carries a bearer token. This evidence object ends up in
      // logs, in `doctor` output and inside an HTTP error body, so the token
      // must never enter it. The field lookup happens in the page and only
      // the verdict comes back.
      const probe = await page
        .evaluate(
          async ({ ep, fields }) => {
            const dig = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o)
            try {
              const r = await fetch(ep, { credentials: 'include' })
              const text = await r.text()
              let json = null
              try {
                json = JSON.parse(text)
              } catch {}
              let account = null
              let field = null
              for (const f of fields ?? []) {
                const v = json && dig(json, f)
                if (v) {
                  // Return presence only. Even an email address is needless
                  // account data in logs and HTTP errors; authentication
                  // needs a verdict, not the identifier itself.
                  account = true
                  field = f
                  break
                }
              }
              return { url: ep, status: r.status, bytes: text.length, account, field }
            } catch (e) {
              return { url: ep, error: String(e && e.message).slice(0, 120) }
            }
          },
          { ep: auth.sessionEndpoint, fields: auth.sessionUserFields ?? [] }
        )
        .catch((e) => ({ url: auth.sessionEndpoint, error: String(e.message).slice(0, 120) }))

      ev.endpoint = probe
      if (probe?.account) {
        ev.account = probe.account
        ev.accountField = probe.field
      }
    }

    // WHICH APPLICATION IS BEING SERVED. An anonymous visitor gets different
    // bundles - chatgpt.com serves everything from /unauth-mweb/ - and that
    // is a fact about the server's response, not about a translated string.
    if (auth.anonAssetPattern) {
      ev.anonAsset = await page
        .evaluate((pattern) => {
          const re = new RegExp(pattern)
          for (const el of document.querySelectorAll('script[src], link[href]')) {
            const u = el.getAttribute('src') || el.getAttribute('href') || ''
            if (re.test(u)) return u.slice(0, 120)
          }
          return null
        }, auth.anonAssetPattern)
        .catch(() => null)
    }

    // Weak, last-resort DOM signals. Kept because they are sometimes all
    // there is, ranked low because they are a guess about wording.
    const body = await page.locator('body').innerText().catch(() => '')
    if (auth.challengePattern) {
      const m = body.match(new RegExp(auth.challengePattern, 'i'))
      ev.challengeText = m ? m[0] : null
    }
    if (auth.signedOutPattern) {
      const m = body.match(new RegExp(auth.signedOutPattern, 'i'))
      ev.signedOutText = m ? m[0] : null
    }
    if (auth.accountMarker) {
      ev.accountMarker = await page.locator(auth.accountMarker).count().catch(() => 0)
    }
  } catch (e) {
    ev.error = String(e.message).slice(0, 160)
  }
  return ev
}

/**
 * Turn evidence into a verdict. Pure, so it can be tested exhaustively.
 *
 * Returns { state, authority, because[] } where state is one of:
 *   'in'        proven signed in
 *   'anonymous' proven signed out
 *   'challenge' a human verification is showing - not ours to touch
 *   'unknown'   nothing conclusive; treated as NOT signed in
 *
 * 'unknown' exists so that ignorance cannot masquerade as a session. The old
 * code had no such state and defaulted to "signed in", which is the one
 * answer that fails silently.
 */
export function decideSession(ev, auth = {}) {
  const because = []

  if (ev.challengeText) {
    return {
      state: 'challenge',
      authority: 'the page is showing a verification challenge',
      because: [`the page reads "${ev.challengeText}"`],
    }
  }

  if (ev.account) {
    return {
      state: 'in',
      authority: `the app's own session endpoint (${ev.endpoint?.url})`,
      because: [`${ev.accountField} is present`],
    }
  }

  if (ev.authCookies?.length) {
    return {
      state: 'in',
      authority: 'a session cookie is present',
      because: [`cookies: ${ev.authCookies.join(', ')}`],
    }
  }

  if (ev.anonAsset) {
    because.push(`the page is serving its ANONYMOUS bundle (${ev.anonAsset})`)
    return { state: 'anonymous', authority: 'the server is serving the signed-out application', because }
  }

  // An endpoint that answered, with no user in it, is a real negative - but
  // only if it answered. A network error says nothing either way.
  if (ev.endpoint && !ev.endpoint.error && !ev.account) {
    because.push(`${ev.endpoint.url} returned ${ev.endpoint.status} with no account in it`)
    return { state: 'anonymous', authority: "the app's own session endpoint", because }
  }

  if (ev.signedOutText) {
    return {
      state: 'anonymous',
      authority: 'the page is offering a sign-in (weak evidence)',
      because: [`the page reads "${ev.signedOutText}"`],
    }
  }

  return {
    state: 'unknown',
    authority: 'nothing conclusive was found',
    because: [
      'no session cookie matched and no authenticated session endpoint answered',
      ...(ev.accountMarker > 0
        ? [`${ev.accountMarker} account-like DOM control(s) were ignored because DOM is not proof of a session`]
        : []),
      'treated as SIGNED OUT: proceeding would risk running against an anonymous session',
    ],
  }
}

export async function sessionState(page, auth = {}) {
  const evidence = await readSessionEvidence(page, auth)
  const verdict = decideSession(evidence, auth)
  return { ...verdict, evidence }
}

/**
 * The message a person actually reads.
 *
 * It must survive being seen in three places - a terminal, an HTTP error
 * body, and a log - so it is plain text, and it answers the three questions
 * someone in this position has: what is wrong, why do you say so, and what do
 * I type. The password promise is stated every time because it is the thing
 * a user is right to worry about when a tool asks them to log in.
 */
export function signedOutMessage(providerId, verdict, { command = `uibridge login ${providerId}` } = {}) {
  const lines = [
    `${providerId}: not signed in, so this request was not sent.`,
    '',
    `Why: ${verdict?.authority ?? 'no session was found'}.`,
    ...(verdict?.because ?? []).map((b) => `  - ${b}`),
    '',
    'These sites answer while logged out, with a different and weaker model, so',
    'running anyway would put an anonymous answer into your results with nothing',
    'to mark it. It is refused instead.',
    '',
    'To fix it, run:',
    `    ${command}`,
    '',
    'A browser window opens on the site and waits while you sign in yourself.',
    'uibridge never sees or types your password. The session is then stored in',
    'the profile and persists across restarts - you do this once.',
  ]
  return lines.join(NL)
}
