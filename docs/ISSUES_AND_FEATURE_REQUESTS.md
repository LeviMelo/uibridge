# Test Findings, Issues, and Feature Requests

## 2026-09-21 — an answer that lost content was reported complete (0.5.1)

Found by auditing this repository for a defect shape a caller had hit all
night: **a verdict reached before the evidence, and a lesson applied where it
was learned but not to the sibling that shares the hazard.** Both instances
here are at the transport, which makes them the most expensive kind - the
caller files uibridge's output as scientific data, so an answer that quietly
lost content is worse than an error. An error retries; a short answer is
indistinguishable, downstream, from the model having written less.

**Fixed.**

| path | what was lost | why nothing saw it |
|---|---|---|
| `stripMarkers` (`sse-openai.mjs`) | everything from an unterminated citation marker to the end of the answer | the branch is correct for a progress read of an **open** stream and the same branch runs on the final decode of a **closed** body |
| `decodeDeltaStream` `malformed` | whole frames, i.e. content from the **middle** of an answer | counted since the decoder was written, asserted in a unit test, and read by no caller |

Both left `finished` true, so `#extractWire` reported `truncated: false`.
`truncated` now covers either, and the result carries `malformed_frames` and
`dropped_characters`. The characters are still dropped in the marker case -
half a sentinel must not escape into a CSV - but the count travels with them.

The malformed case is worse than plain loss: a delta inherits `o` and `p` from
the frame before it, so dropping one frame can mis-route the *next* frame's
text. The module header already records what getting that inheritance wrong
costs - "recovered 29 characters of a 2KB answer and looked like it had
worked".

**Open, from the same audit, in priority order.** Not addressed here.

1. **A completed answer is destroyed by five throws before it is recorded**
   (`session.mjs:476-597`). The answer exists at `:476`; the only durable
   write is at `:587`; between them sit `thread_unidentified`,
   `thread_mismatch`, `model_unverified` and `model_not_applied`, two of them
   non-retryable, with `strictModel: true` the default. The turn was spent on
   the user's subscription and a re-ask is a different generation. The repo
   already records this shape costing 5 of 67 calls on 2026-09-20; the fix
   applied then was to soften the comparison, not to record before judging.
   `ledger.mjs` is already append-serialised and torn-line-tolerant, so a
   provisional row at `:476` plus an outcome row is safe by construction.
2. **The ledger is written on success only** (`session.mjs:586-597` is its
   sole call site), so a failed request leaves no durable row at all and
   `listThreads` reports successes as turns.
3. **Chunk assembly has no ordering assertion** (`wire.mjs:132-159`):
   `bufferedData` is appended after an `await` while the synchronous
   `dataReceived` handler appends to the same array, and `content-length` is
   captured and never compared. A reordered body yields malformed frames at
   the seam and correctly-parsed frames applied in the wrong order. Unverified
   against Chrome - a risk to test, not a confirmed defect.
4. **A stale cached attachment allowance can refuse uploads for the daemon's
   lifetime** (`chatgpt/index.mjs:92-129`): when `resets_after` is null or
   unparseable the self-expiry guard never fires, and the refusal is issued
   without attempting the upload.
5. **`setMode` fails un-retryably where `selectModel` retries**
   (`dom-provider.mjs:860-890` against `:781-799`), on the same popover
   reached the same way, with the incident that justified the retry recorded
   inline on the sibling only.
6. **`waitStable` counts a failed read as evidence of stability**
   (`async.mjs:54-67`) - the inverse of the rule written two files away in
   `dom.mjs:52-69`. Latent: today's callers catch their own errors first.
7. **No request-level tracing and no per-request id on the `[api]` failure
   line**, so with `concurrency: 12` twelve interleaved failures cannot be
   joined to the work that produced them. `captureComparison`
   (`dom-provider.mjs:1595-1605`) is a working template for the artefact
   capture the recurring failures lack.


## Patch assessment and verification

The original findings below are preserved. The following changes address them:

| Finding | Resolution |
|---|---|
| Generated-file retrieval | Current-response-only chip lookup prevents historical downloads. A bridge-owned download directory and CDP popup/opener tracking avoid dependence on Playwright's temporary artifact path. Typed file failures retain request ID and artifact-state evidence where available. |
| Clipboard degradation | Fixed matching failures for short responses, non-Latin text, and answers whose canonical copy includes hidden code. Copy operations refresh clipboard permissions and emulate focus while holding the clipboard mutex. Fallback still reports extraction tier, lossy math and a phase/reason diagnostic. |
| CLI disconnect ambiguity | Daemon-backed `ask` and `chat` are durable by default and print the key before waiting. Added `--key`, `request status`, `request recover`, and `request cancel`. Recovery does not submit another turn or need the original attachment files. |
| Missing model/mode audit data | New ledger events retain allowlisted provenance, requested/applied/verified settings and final picker state. Historical entries cannot be backfilled as verified. |
| Concurrent native access | Bridge requests remain serialized per thread. The live test included a second read-only native view and a short-lived CDP client. Concurrent human/other-client modifications cannot be locked by this bridge; the documented limitation remains. |
| Session-profile management | Added `profiles --json`: configured paths, directory existence and last successful authenticated use from the ledger. It reads no cookies, opens no browser and makes no credential copies. Existing persistent profiles remain the sign-in mechanism. Optional backup/restore was not added. |

**Verification:** 149 local tests pass. The six-turn Gemini live regression saved
both CSVs, preserved their hashes, kept all six responses on canonical `copy`,
reported zero historical re-downloads, retained one thread for continuations,
and persisted verified thinking off/on/off state. It also overlapped a
continuation with file generation on a separate thread. The second native view
was read-only; this is not a guarantee against concurrent editing from another
browser. Tests assessed transport and API behavior, not scientific knowledge.

Evidence: `.uibridge/continuations/2026-09-07T22-21-52-603Z/results.json`,
`verified.json` in the same directory, corresponding thread ledgers, and
`.uibridge/test-results.txt`. The final process handle was lost during the usage
interruption, so the saved responses, file contents/hashes and ledger records
were independently rechecked. Earlier failed development runs remain saved.

The CLI regression terminates a client during generation, then recovers and
checks status by key while asserting exactly one inference. A cancellation
test also exposed a Windows read/rename contention; active status now reads
in-memory metadata instead of opening the record during its atomic replacement.

Commands:

```powershell
uibridge profiles --json
uibridge ask gemini --model=gemini-pro --thinking=off --key=my-turn-1 --json "..."
uibridge request status my-turn-1 --json
uibridge request recover my-turn-1 --json
uibridge request cancel my-turn-1 --json
```

## Scope

This is a CLI-only live test record for uibridge. No source code was changed
while producing it. Tests used Gemini with an existing authenticated uibridge
profile and a synthetic biomedical-literature conversation.

## Session persistence and sign-in

### Finding: session persistence is already supported

uibridge uses a dedicated, persistent Chrome user-data directory per provider:

- Default configuration: `profileDir: ".profiles"`.
- Effective provider profile: `.profiles/<provider>`; for example,
  `.profiles/gemini` and `.profiles/chatgpt`.
- `uibridge login <provider>` opens that dedicated profile for a user to sign
  in. The browser profile, including its authenticated session material, is
  reused by later CLI/API/daemon invocations.
- `uibridge paths` reports the effective profile location. The project README
  and sign-in workflow state that the session persists across restarts.

This should normally avoid repeated MFA while the provider keeps the session
valid. It cannot guarantee indefinite login persistence: the provider may
expire/revoke a session, require re-authentication, or require a new MFA
challenge. Deleting, replacing, corrupting, or moving the profile directory
also removes access to that saved browser session.

### Security and operational requirements

- Treat `.profiles/` as credential-equivalent sensitive data. It contains live
  browser-session material and must not be committed, shared, copied to an
  untrusted host, or included in support bundles.
- Keep `UIBRIDGE_HOME` stable if it is used. Changing it changes the location
  of the profiles and can look like a lost login.
- Do not run multiple independent uibridge processes against the same provider
  profile. The project itself warns that one process must drive a profile;
  prefer `uibridge serve` plus CLI/API clients using that daemon.
- `uibridge logout <provider>` deliberately clears the dedicated profile's
  cookies/session storage and will require another user-managed sign-in.
- ChatGPT must use the documented offscreen/normal browser mode rather than
  true headless mode: the code documents that true headless can present an
  anonymous session despite existing cookies.

### Feature request: explicit session-profile management

Add safe CLI support for listing configured profile locations and reporting
last successful authenticated use without exposing cookie values. Consider an
explicit, opt-in backup/restore workflow that refuses unsafe destinations,
warns prominently that profile data is credential-equivalent, and never
includes profiles in ordinary exports or diagnostic bundles.

## Controlled live test

### Successful baseline

Thread: `0ee21d09821877c4`

- Five successful user turns / approximately ten native chat messages.
- Each CLI request explicitly supplied `--model=gemini-pro --thinking=off`.
- The ledger records `model: "gemini-pro"` and `modes: {"thinking": false}`
  on every turn.
- The initial 41,783-byte PDF upload succeeded.
- The first generated-file transfer succeeded: `controlled_trial.csv`, 325
  bytes, SHA-256
  `15a836f2abed95e2912246c35b7a0f798fae6b44b98ab35a0605bfa989799a44`.
- The first answer used the canonical `copy` extraction path and was not
  truncated.

## Issues observed

### P1 — generated-file retrieval becomes unreliable after the initial turn

After the first successful CSV receipt, each later continuation successfully
received its text response but recorded the pre-existing generated CSV as
`retrieval failed`. A separate overlapping controlled request failed to save
its newly generated CSV as well.

The daemon log records the direct failure mechanism:

```
download.saveAs: ENOENT: no such file or directory, copyfile
'...playwright-artifacts...'<artifact> -> <downloads target>
```

Impact: the bridge cannot truthfully claim reliable generated-file transfer.
The response/ledger reports the error, which is good, but the central feature
is not dependable under this workload.

Suggested investigation:

1. Determine why the temporary Playwright download artifact disappears before
   `saveAs`.
2. Avoid re-downloading historical file controls on every continuation unless
   requested.
3. Add a regression test that generates a file, continues the same thread
   several times, and checks both that the original file remains available and
   that no duplicate historical retrieval is attempted.
4. Preserve typed failure information (`ENOENT`, source artifact path state,
   request id) in machine-readable response provenance.

### P1 — clipboard extraction degrades during continuations

The first controlled answer used `copy`; later turns used `dom-markdown` and
the daemon reported `clipboard unavailable`. The fallback preserves a usable
answer but can be lossy (notably rendered mathematical notation).

Impact: answer fidelity changes within one thread without an explicit caller
choice. Generated-file failure and clipboard degradation appeared together in
the observed continuations.

Suggested investigation:

1. Identify whether clipboard ownership/contention, browser focus, or the
   native chat UI causes the unavailability.
2. Keep `extraction` and `lossy_math` prominent in every API/CLI response.
3. Add a multi-turn concurrency test that asserts the canonical copy path when
   the OS clipboard is healthy, then tests fallback behavior deterministically.

### P1 — unkeyed CLI requests have ambiguous outcomes on client disconnect

An earlier CLI invocation exceeded the surrounding command runner's short
wait window. The bridge logged `request_cancelled`; provider-side work could
already have started. The native thread later contained a response, making it
unclear to the caller whether a retry would duplicate a turn.

Impact: callers using the CLI or short-lived HTTP clients can observe a
timeout/disconnect while the provider may still process the prompt.

Suggested investigation:

1. Document CLI use of durable/idempotent requests, or add a CLI idempotency
   option that maps to the existing HTTP `Idempotency-Key` support.
2. Make the CLI return a durable request identifier before waiting for a long
   result, with explicit status/recovery commands.
3. Add a test that disconnects a client mid-generation and verifies the
   resulting ledger/request status is unambiguous.

### P2 — model/mode audit data is not persisted in the thread ledger

The project reads final UI picker state after applying the requested model and
thinking mode, but the durable thread ledger recorded only the requested
`model` and `modes`. It did not retain the authoritative final picker state or
per-setting verification result from response provenance.

Impact: a later assessor can see what was requested, but cannot prove from the
ledger alone which model/mode the UI reported as applied for a past turn.

Suggested investigation:

1. Store a redacted `provenance` object in each ledger event, including model
   requested/applied/verified, thinking requested/applied/verified, and final
   picker state.
2. Add tests for both `--thinking=on` and `--thinking=off` on a pinned Gemini
   model and assert durable provenance, not only live CLI output.

### P2 — concurrent browser/thread access remains an uncontrolled variable

The user accessed the same native Gemini thread in a normal browser during an
earlier test. No captured error directly attributes the failures to that
access: the observed concrete errors were client disconnect, clipboard
unavailability, and missing temporary download artifacts. However, concurrent
access can affect rendered history, active conversation state, controls, and
timing.

Suggested investigation:

1. Run an A/B test: bridge-only access versus active normal-browser access to
   the same thread, with identical pinned model/mode and generated-file steps.
2. Document whether the provider's native conversation may be open elsewhere
   while uibridge drives it, and what guarantees are or are not provided.
3. Consider per-thread activity detection/warnings where feasible; do not
   silently assume exclusive native-thread ownership.

## Relevant evidence

- Controlled thread ledger:
  `.uibridge/threads/gemini/0ee21d09821877c4.jsonl`
- Successful received artifact:
  `downloads/controlled_trial.csv`
- Runtime warnings and errors:
  `.uibridge/daemon.log`
- Earlier comparison thread:
  `.uibridge/threads/gemini/aa12290b9357eae1.jsonl`
