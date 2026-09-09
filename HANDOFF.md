# uibridge assessment handoff — 2026-09-07

## CDP incident assessed 2026-09-08

The independent CLI key `cli-durable-check-20260907` failed at browser attachment
after 30 seconds, before submission. Recovery correctly replayed that saved
failure; it did not initiate another attachment. HTTP `/health` is daemon liveness,
not proof that provider browser attachment works.

Reproduced: `/json/version` and `Browser.getVersion` responded immediately, but
Playwright's WebSocket connected then stalled initializing two existing page
targets (Gemini and Claude origins). Their Page/Runtime commands went unanswered.
Verified PID 28732 used this project's `.profiles/gemini` and port 9333. The reason
those renderers stopped responding is not established. No browser UI was inspected.

Added two bounded 8-second attachment attempts and typed HTTP 503
`browser_unavailable`, with `stage: browser_attach`, `submission_started: false`,
and an explicit new-key recovery instruction. No automatic browser kill/restart or
inference replay. Same-key recovery remains terminal and `retryable: false`.
Observed the new error after 16.04 seconds against the stalled instance.

After checking the daemon had zero active requests, closed only the verified
dedicated browser via CDP and reopened it. Profile retained; doctor passed in
4.3 seconds, signed in, clipboard working. Restarted daemon to load patched code.
Fresh Gemini Pro/thinking-on key `cdp-restart-check-20260908` completed in 18.95s,
canonical copy, both settings verified, thread `5bd37a8c9db5daa1`. CLI recovery
returned an identical response. Evidence: `.uibridge/cdp-restart-response.json`,
`.uibridge/cdp-recovered-response.json`. All 151 local tests pass in
`.uibridge/test-results-cdp.txt`. Original failed request record is preserved.

Remaining limitation: a persistently stalled Chrome still requires an idle-browser
restart; bounded retries improve handling but do not repair a stuck renderer.

## Latest user-report follow-up

The user clarified that transport/API behavior is the objective, not model
scientific benchmarking, then requested fixes from `ISSUES_AND_FEATURE_REQUESTS.md`.
That report now has a resolution table and exact evidence paths. Do not resume
model knowledge benchmarking. Preserve all earlier uncommitted work.

Implemented: response-scoped Gemini generated files; stable CDP download capture
with ephemeral popup opener tracking (`src/transports/download.mjs`); canonical
copy matching for short/non-Latin/hidden-code responses, focus emulation and
permission refresh; explicit extraction diagnostics and typed file failures;
allowlisted ledger provenance; durable CLI `ask`/`chat` keys printed to stderr,
`--key`, request status/recover/cancel, and GET `/v1/requests/result`; CLI profile
listing with last recorded authenticated use. No profile backups/copies made.

149 local tests pass, including terminated-CLI recovery without re-inference.
The successful six-turn live evidence is in
`.uibridge/continuations/2026-09-07T22-21-52-603Z/` (`results.json`, `verified.json`).
All six canonical copies, both CSV byte contents/hashes, no historical downloads,
and thinking off/on/off provenance were verified. A second read-only native
view and CDP client were present during continuations; a fresh file-generating
thread overlapped a continuation. This does not promise safety for external edits.
The usage interruption lost process handles; final saved evidence was independently
verified instead of repeating inference. `test/live-continuations.mjs` reproduces it.

## User objective and authority

The user needs accurate classification and generation for local scientific projects, often with long evidence inputs, without paid API access. Signed-in chatbot UI automation is acceptable, but clients should use an OpenAI-compatible HTTP interface. They authorized architectural/development changes and a thorough assessment. They explicitly requested this handoff and then asked work to continue after a usage interruption.

Do not call the project fully API-equivalent or scientifically validated. It implements a subset of Chat Completions with provider UI constraints. Accuracy and transport correctness are separate claims. No changes have been committed; the working tree contains this session's implementation and regression tests. Preserve it.

## Latest verified state

- `npm test`: 149 passing tests; captured in `.uibridge/test-results.txt`. All 49 JavaScript modules pass syntax checks, and the package contains 46 files. Evidence: `.uibridge/syntax-check.json` and `.uibridge/package-check.json`; profiles, downloads and test artifacts stay excluded. `git diff --check` passes.
- Both providers passed formatting preservation, actual generated-text-file download with exact identifier, and 60/60 classification labels over 111,249 characters. These are synthetic fixtures, not a scientific accuracy estimate.
- Live idle-browser recovery passed: closing dedicated ChatGPT Chrome, then making a new SDK request, reopened it and returned the exact answer with verified model in 18.3 seconds. Evidence: `.uibridge/acceptance/recovery-results.json`.
- Both dedicated profiles authenticated using `node bin/uibridge.mjs status --json` after the user signed in. ChatGPT session endpoint verified; Gemini cookie-based verification plus successful real inference.
- Real SDK: `openai` JS 7.10.0 is a development dependency; `test/acceptance.mjs` uses it with `maxRetries: 0`, dummy local key, base URL `http://127.0.0.1:8477/v1`.
- Classification: six fictional scientific records, known include/exclude/unclear labels, all correct for `gemini-pro` and `chatgpt-5.6-medium`, with requested models verified.
- Both providers passed exact Unicode SSE reconstruction and requested usage-chunk handling.
- Both passed retrieval of three random identifiers from beginning/middle/end of 195,924 characters of synthetic evidence (196,180 including instructions). Large requests used temporary text attachments, NOT a demonstrated native 196K-character text context.
- Both passed text-file extraction of an exact random accession and two sample sizes, native-thread continuation, short active-branch export, and two isolated requests with different replies and different thread IDs.
- Gemini export and continuation were initially wrong because clipboard output was stale; fixed and retested.
- ChatGPT isolation initially returned duplicated thread IDs because identity fell back to an unrelated sidebar link; fixed and retested.

Current result directories (gitignored, contain only synthetic acceptance output):

| Run | What it establishes |
|---|---|
| `.uibridge/acceptance/2026-09-07T12-41-49-274Z-gemini-pro` | Classification and SDK streaming passes; original long/continuation failures |
| `.uibridge/acceptance/2026-09-07T12-42-00-609Z-chatgpt-5.6-medium` | Classification/streaming passes; original long/identity failures |
| `.uibridge/acceptance/2026-09-07T12-49-13-099Z-gemini-pro` | 5/5 long, attachment, continuation, export, isolation after fixes |
| `.uibridge/acceptance/2026-09-07T12-53-22-923Z-chatgpt-5.6-medium` | 5/5 same checks after fixes; long 52.9s, attachment 28.8s, continuation 6.8s, export 4.8s, isolation 45.7s |
| `.uibridge/acceptance/2026-09-07T16-24-27-584Z-gemini-pro` | 3/3 formatting, generated file, long classification; 60/60 labels |
| `.uibridge/acceptance/2026-09-07T16-24-39-417Z-chatgpt-5.6-medium` | 3/3 same checks; 60/60 labels, classification 103.5s |

The `12-49-24` ChatGPT run was interrupted to recover a stalled Chrome debugging session. Its later connection errors are consequences of stopping the test service, not independent inference failures. Earlier interrupted runs are not current acceptance results.

## Implemented changes

1. `src/core/pool.mjs`: reserve capacity while pages open; exclusive handoff; reject queued calls on shutdown; creation failure recovery; ignore duplicate release; reject invalid concurrency. Tests in `test/pool.mjs`.
2. `src/core/window.mjs` and Chrome/session integration: use CDP window positioning on attach and new pages, normalize maximized/minimized state first, await placement for pooled tabs, restore parked windows for headed login. Warnings on failures. This is ordinary Chrome offscreen, not true headless; taskbar entries/popups can remain.
3. `src/core/composer.mjs`: replace input instead of appending on retries; verify complete logical editor text. Quill/ProseMirror `<p>` lines must be joined with one newline; rendered `innerText` doubles paragraph spacing. Catch fill failures without leaking full prompts from Playwright call logs.
4. Submission retry: do not type the prompt twice. If the composer changed and acknowledgement is missing, throw `submit_uncertain` instead of blindly resending.
5. `src/api/request.mjs`: shared validation for streaming/non-streaming; reject unsupported controls, multimodal message parts, invalid modes/IDs, and missing attachment paths before opening a browser. `response_format` text/json_object/json_schema supported through prompting plus Ajv validation, not constrained decoding. Invalid structured output fails with 502; structured streams buffer until validation succeeds.
6. API returns errors for empty/provider-error answers; SSE IDs use UUIDs, timestamps stay stable, `stream_options.include_usage` produces the expected final empty-choices chunk. Usage remains zero placeholders, not measured tokens.
7. `currentThread` uses wire conversation ID or actual page URL, never sidebar history. New-chat action verifies a blank thread and falls back to root navigation if necessary.
8. Clipboard is cleared and verified before Copy, and Copy is scoped to the response being extracted. Prevents reading the previous answer while a new clipboard write is pending.
9. `maxComposerChars: 32000` default: oversized requests become temporary UTF-8 attachments, cleaned on success/failure. `_uibridge.input` and ledger record original character count/hash and transport. Gemini's editor was measured retaining only exactly 32,000 characters. ChatGPT retained a 185,610-character single paragraph but a 1400-line paste stalled. Avoid repeating that giant direct-paste probe.
10. `strictModel: true` default and strict wire model verification; failed mode application raises an error. Same-native-thread requests serialized in a Session. Each attempt has its own provider/log instance.
11. `src/core/output-file.mjs`: atomic exclusive reservation prevents generated filenames overwriting earlier requests/restarts. DOM download names now sanitized too. `ledger.mjs` drops inlined generated content and releases settled per-file queues.
12. Explicit CLI `--headed` / `--headless` now overrides provider defaults through `windowModeOverride`.
13. Server supports injected session factory for meaningful HTTP regression tests; closes sessions that finish opening during shutdown; shutdown has a 5s process-exit deadline so a stuck browser cannot block `stop` indefinitely. Unexpected errors omit full Playwright call logs.

Added tests: `test/api.mjs`, `test/session.mjs`, `test/window.mjs`, `test/pool.mjs`; existing `test/unit.mjs` extended. Runtime dependency `ajv`; dev dependency `openai`.

Final additions: stale/closed idle sessions are replaced before the next request, without resending interrupted inference; `UIBRIDGE_HEADED` overrides provider defaults; `config.example.json` is valid JSON; Gemini's observed canned service non-answer is classified as an error; fallback download filenames are sanitized. Windows actually clamps parked ChatGPT windows to approximately -21845 at this display scaling, so headed restoration detects coordinates below -10000. Gemini was observed truly headless; ChatGPT was headed and parked offscreen. README compatibility cleanup is complete.

## Follow-up implementation: cancellation, durability and real evidence

The user explicitly requested addressing the remaining gaps and resumed after another usage interruption. The following work is implemented, not a proposal:

- `src/core/cancel.mjs` scopes AbortSignals through provider waits with AsyncLocalStorage. Mutex, Pacer, TabPool and wire-capture polling support cancellation. Queued work does not later submit; active cancellation closes/discards only its tab. Session shutdown aborts pacing too. Export shares the per-thread mutex and cancellation.
- HTTP disconnect cancels unkeyed work. Keyed work survives disconnect and can be stopped with `POST /v1/requests/cancel`, or inspected with `GET /v1/requests/status`, both using the `Idempotency-Key` header. Default total request budget is 900000ms; admitted inference limit is 64.
- `src/api/idempotency.mjs` persists an exclusive, fsynced claim before inference, then atomically writes full response or terminal error. Concurrent duplicates share a promise. Successful responses replay after restart. Different input under the same key returns409. Cancelled keys return499. A crashed pending claim returns409 `outcome_unknown`, NEVER an automatic resend. Keyed streams buffer and replay saved results.
- Attachment snapshots freeze bytes before queuing; hashes participate in identity. Cleanup follows shared work, not a disconnected subscriber. Preserve original attachment paths/contents for replay identity checks. Records store responses, not original prompts; no automatic expiry.
- `test/reliability.mjs` covers cancellation, active-tab isolation, actual killed worker, restart replay, attachment mutation, corruption, bounded queue/timeout, 200 HTTP requests with injected failures and Python checkpoint resumption.
- `examples/durable_batch.py` is a stdlib-only sequential JSONL batch client with stable per-experiment keys, fsynced checkpoints and conservative failure handling. It is packaged. The optional Python test skips when Python is absent.
- `test/scientific.mjs` downloads pinned PubMedQA PQA-L data to gitignored cache and scores 12 deterministic, balanced real records in short/long contexts. Reference answers are withheld. It accepts an adjudicated custom JSONL corpus. `test/support/biomedical.mjs` computes confusion matrices, macro-F1, quote fidelity and mismatches.

New evidence:

| Path under `.uibridge/` | Result |
|---|---|
| `reliability/2026-09-07T16-43-43-503Z-gemini-pro` | Active cancellation + 4 paced inferences with concurrent duplicates and replay: all passed |
| `reliability/2026-09-07T16-43-55-127Z-chatgpt-5.6-medium` | Same, all passed |
| `reliability/restart-replay.json` | All 8 saved live responses replayed after restart; health showed no opened provider sessions |
| `scientific/2026-09-07T16-45-20-657Z-gemini-pro` | 10/12 short, 10/12 long; 12/12 exact source quotes each; 12/12 consistent labels |
| `scientific/2026-09-07T16-47-43-356Z-chatgpt-5.6-medium` | 8/12 short, 9/12 long; 12/12 exact quotes each; 9/12 consistent labels |
| `acceptance/2026-09-07T16-52-26-911Z-chatgpt-5.6-medium` | Live snapshot survived mutation; changed file conflicts; restored file replays |
| `acceptance/2026-09-07T16-52-15-382Z-gemini-pro` | Correct identifier plus unwanted filename; strict text test failed, preserved |
| `acceptance/2026-09-07T21-24-50-548Z-gemini-pro` | Schema-validated JSON snapshot/mutation/conflict/replay test passed |

Do not tune prompts against this tiny answer key or represent these results as a model ranking. Both models agreed incorrectly on two reference `maybe` cases. Exact quotes establish source fidelity, not entailment. Real biomedical results are the reason to keep an explicit review step in scientific pipelines.

## Running and recovering

Workspace: `C:\Users\Galaxy\LEVI\projects\uibridge`. Dedicated profiles are under `.profiles`, generated files under `downloads`, audits under `.uibridge/threads`.

```powershell
npm test
node bin/uibridge.mjs status --json
node bin/uibridge.mjs serve
node test/acceptance.mjs gemini-pro
node test/acceptance.mjs chatgpt-5.6-medium
# Optional individual cases follow the model name.
node bin/uibridge.mjs stop
```

The server was running on 8477, idle, at handoff initialization. It keeps loaded code: stop/start after source edits before live validation. Check `/health` before starting a rival daemon. Browser ports: Gemini 9333, ChatGPT 9334.

The Codex execution sandbox caused Chrome startup connection resets. Running the server outside that sandbox with the existing approved `node bin/uibridge.mjs serve` escalation worked. Use a workspace npm cache (`--cache .uibridge/npm-cache`) because the default AppData cache is not writable in the sandbox.

If login is needed: stop the service, then `node bin/uibridge.mjs login chatgpt` or `... login gemini`. The user signs in. The service must stay stopped so it does not move login windows offscreen. Never read credentials, cookie values, or unrelated browser profiles.

One stuck dedicated ChatGPT browser was recovered by sending `Browser.close` over its own debugging websocket on 9334, then restarting the service; do not kill all Chrome processes. A retained login survived this. Avoid unsupported stealth/headless workarounds.

Keep provider pacing (ChatGPT 20s, Gemini 8s) and stop live traffic on 401/challenge/429. Do not infer that a passed UI click means a submitted request or that an opened profile means authenticated inference.

## Remaining assessment / known limits

- Read `ASSESSMENT.md` for the completed assessment. Formatting, generated files, long classification, configuration, packaging and documentation checks are complete. Do not rerun them without a reason.
- Cancellation, persistent idempotency, resumable batch support and a real biomedical diagnostic benchmark are now implemented/tested. Next priorities are longer paced endurance runs, representative user-adjudicated evidence, provider failure/drift monitoring and the intrinsic limitations below. Do not repeat green tests without a new concern.
- Legacy live checks passed 7/9 assertions. One Gemini comparison request returned an actual canned service non-answer (now detected as an error); another lacked requested code fences. Later controlled formatting tests passed both providers. Citation testing verified truthful absence only, not successful external citation retrieval. ChatGPT PDF testing was interrupted by the stale-browser problem and was not successfully rerun; generated text files passed later.
- Keep artifacts private/local. No commits were made. Check the running service's `/health`; stop/start after future source changes.
- `test/live.py` is legacy and has weak assertions (e.g. any digit in a PDF answer), historical wording, and Gemini-centric defaults. Treat as supplementary UI checks, not a scientific benchmark.
- No native system/developer priority: roles are labels in one UI turn. Native conversation history plus supplied messages may duplicate history; only send new content with `thread_id`.
- No temperature/top_p/token caps/tool calls/Responses endpoint/embeddings/batch API. Unsupported non-null request parameters now fail explicitly rather than being ignored. Multimodal OpenAI content parts are unsupported; local attachments are an extension.
- Token counts, actual context window/truncation inside provider file processing, service availability and model weights are not controlled by this bridge. Gemini model verification is picker-based; ChatGPT can verify wire slug/effort.
- Local cancellation cannot guarantee termination of provider-side compute. Durable pending claims after a crash deliberately stay uncertain. Records are retained indefinitely; removing one removes duplicate protection. There is no provider-backed exactly-once execution or automatic requeue after crashes. Unkeyed SDK requests still need automatic retries disabled.
- Export verified here was short; prior project handoff records longer history tests, but do not count those as rerun today. All model/effort variants, OS login/autostart/reinstallation, all file types, provider outages and actual rate limits have not been comprehensively live-tested.
- Defaults changed for correctness. Review compatibility impacts and document them; do not weaken validation just to make a failing test green.

Official references already consulted: OpenAI Chat Completions create reference (`https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create`); Chrome CDP Browser domain (`https://chromedevtools.github.io/devtools-protocol/tot/Browser/`); Ajv JSON Schema (`https://ajv.js.org/json-schema.html`). No API keys are needed for these local-backend tests.
