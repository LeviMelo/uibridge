// Is this text an ANSWER, or the provider's own failure wearing an answer's
// clothes?
//
// WHY THIS EXISTS AS ITS OWN MODULE. The judgement used to be one regex,
// duplicated in the DOM and wire extraction paths, and it decided whether a
// turn is data or an error. On 2026-09-08 Gemini produced two different
// failure texts within minutes:
//
//     "Sorry, something went wrong. Please try your request again."
//     "I encountered an error doing what you asked. Could you try again?"
//
// The first was in the pattern; the second was not, so it was returned to
// the caller as a normal 200 answer. In a systematic review that is a row of
// "evidence" that is actually an apology.
//
// WHAT WAS RULED OUT FIRST. A structural marker would be better than
// matching prose, so the rendered HTML of both failures was captured and
// compared against successful answers from the same account. There is none:
// an errored Gemini turn is an ordinary `model-response` with an ordinary
// `<p>`. The `regenerate-button` present on both failures is also present on
// the newest successful answer in a healthy thread, so it marks "latest
// turn", not "failed turn". Text is the only signal the UI gives, and
// pretending otherwise would be worse than saying so.
//
// So the classification is deliberately two-tier:
//
//   RECOGNISED  measured, per-provider wording (selectors `errorText`, plus
//               anything the operator adds in config). A verdict: the turn
//               is an error.
//   SUSPECTED   a short answer that OPENS like a first-person failure. Not a
//               verdict - a flag, reported as `provider_error_suspected` so
//               a pipeline can quarantine it, and never silently promoted to
//               an error unless the operator asks for that.
//
// The suspicion patterns are anchored to the START of the text on purpose.
// "The standard error was 1.2" is a legitimate sentence in this domain and
// must not be mistaken for a failure.

/**
 * Generic first-person failure openings.
 *
 * Modelled on the two variants observed live, kept narrow, and anchored so
 * they can only match text that BEGINS as an apology or a failure report.
 */
export const SUSPECT_OPENINGS = [
  /^\s*(?:sorry|we're sorry|desculpe|desculpa)\b/i,
  /^\s*i\s+(?:encountered|ran into|hit)\s+(?:an?\s+)?(?:error|problem|issue)/i,
  /^\s*(?:something|algo)\s+(?:went wrong|deu errado)/i,
  /^\s*i\s+(?:couldn'?t|could not|can'?t|cannot|was unable to)\s+(?:complete|process|do|finish|fulfil|fulfill|generate)/i,
  /^\s*n[ãa]o\s+(?:consegui|foi poss[íi]vel)\b/i,
  /^\s*(?:oops|whoops)\b/i,
]

/**
 * Classify one answer.
 *
 * `patterns` are the measured, provider-specific ones; matching any of them
 * is a verdict. `maxChars` bounds both tiers: a long, substantive answer that
 * happens to contain an apology somewhere is an answer, not a failure.
 */
export function classifyAnswer(text, { patterns = [], maxChars = 400 } = {}) {
  const body = typeof text === 'string' ? text : ''
  const short = body.trim().length > 0 && body.length < maxChars

  let matched = null
  if (short) {
    for (const pattern of patterns) {
      if (!pattern) continue
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i')
      if (re.test(body)) { matched = re.source; break }
    }
  }
  if (matched) return { error: true, matched, suspected: false, suspected_by: null }

  let suspectedBy = null
  if (short) {
    for (const re of SUSPECT_OPENINGS) {
      if (re.test(body)) { suspectedBy = re.source; break }
    }
  }
  return { error: false, matched: null, suspected: !!suspectedBy, suspected_by: suspectedBy }
}

/**
 * The measured patterns for a provider, plus any the operator has added.
 *
 * Operators meet new wording before we do - a provider can change its error
 * text at any time - so adding one must not require editing source or
 * waiting for a release.
 */
export function errorPatterns(selectors = {}, settings = {}) {
  const out = []
  if (selectors.errorText) out.push(selectors.errorText)
  const extra = settings.errorTextExtra
  if (Array.isArray(extra)) out.push(...extra.filter((p) => typeof p === 'string' && p))
  else if (typeof extra === 'string' && extra) out.push(extra)
  return out
}
