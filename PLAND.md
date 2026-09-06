# uibridge - project handover

Everything another engineer (or model) needs to finish this project: what it
is for, how it is built, what has been measured, what is unverified, and the
rules that are not up for renegotiation.

Read this before touching code. Most of the expensive mistakes in this
repo's history were made by assuming something that was cheap to measure.

## Historical handoff — superseded

The 19:16 handoff below records the state before the work in section 11. It
is retained as an investigation log, not current status. Thread export was
subsequently live-verified on a 34-message virtualized ChatGPT thread and on
Gemini; the current status and remaining work are in section 11.

### Handoff at 19:16 America/Sao_Paulo

The user requested a full-history/virtualization test and asked that the next
agent continue it. At that time, thread export was not finished. The tree was
syntactically valid and all 68 unit tests pass, but the new export path has
not passed live acceptance because ChatGPT temporarily stopped serving prior
conversation history after the test traffic.

### What was measured in this final session

- Reused native ChatGPT thread:
  `6a9ddcb5-37f8-83e9-90a2-69c6b9d5833f`.
- Initial thread load exposed 6 stable DOM nodes (3 user, 3 assistant), each
  with `data-message-id`; assistant nodes also had
  `data-message-model-slug`.
- The current ChatGPT frontend does **not** return history from the old
  guessed `GET /backend-api/conversation/<id>` route. Loading the native URL
  sends `POST /backend-api/f/conversation/prepare`; its request carries
  `conversation_id`, `parent_message_id`, model/client state, and its response
  is only `{status, conduit_token}` (385 bytes). The subsequent history is
  delivered through the app's conduit/runtime and materializes in the DOM.
  `/backend-api/conversation/<id>/textdocs` returned an empty array. Do not
  invent a direct JSON-history endpoint without measuring it.
- Five additional same-thread turns completed before traffic was stopped:
  `LONG_01` read the attached format-agnostic fixture and returned
  `FORMAT_AGNOSTIC_260906`; the next turn generated and uibridge downloaded
  `long_thread_artifact.txt`; `LONG_03`, `LONG_04`, and `LONG_05` were exact.
- Repeated one-shot CLI calls were observed to open/close a temporary tab.
  The user correctly rejected that for ongoing conversation use.
- A subsequent persistent `uibridge chat --jsonl` attempt made no chatbot
  turn: it timed out after 60 seconds waiting for existing history. This is
  consistent with the already-measured ChatGPT data-protection lock that
  temporarily blocks previous conversations. Live traffic was stopped rather
  than retrying or creating more chats. Wait for the lock to clear.

### Code added immediately before handoff

- `uibridge chat <provider> [--thread=<native-id>] [--model=...] [--jsonl]`
  keeps one `Session`, one pooled browser tab, and updates/reuses the native
  thread ID. On a retained tab, `Session.ask` now skips `resumeThread` when it
  is already at the requested UUID, avoiding reload/history rehydration.
- Fresh-thread pacing and continuation pacing are separate:
  `minIntervalMs` remains conservative; `continuationIntervalMs` defaults to
  zero because the observed lock was caused by creating/accessing many chats,
  not ordinary turns within one thread.
- `uibridge export <provider> <native-id> [--output=...] [--json]` is wired to
  `Session.exportThread`. The current DOM exporter sweeps bottom→top and
  top→bottom, deduplicates stable message IDs, records roles/text/model/link/
  media/file-control metadata, and emits boundary/completeness evidence.
- Important architecture cleanup for the next agent: the exporter currently
  lives in `DomProvider` but uses ChatGPT-specific
  `[data-message-author-role][data-message-id]`. Move it into
  `ChatGPTProvider` or make the message selector/identity fields an explicit
  provider selector contract before calling it provider-generic. Gemini has
  not been calibrated for full-thread export and must not be advertised as
  supporting it yet.

### Steps recorded at that time (now completed or superseded)

1. Let ChatGPT's previous-conversation lock clear. Do not create a new chat.
2. Run `uibridge export chatgpt
   6a9ddcb5-37f8-83e9-90a2-69c6b9d5833f --json` once. Verify at least the
   16 known messages (8 pairs: original 3 plus 5 successful additions), exact
   order, unique IDs, the uploaded fixture reference, sandbox/generated-file
   reference, and `complete:true` with both boundaries reached.
3. Move/calibrate the exporter contract as noted above, add pure tests for
   deduplication/order/completeness, and make an inaccessible-history state a
   typed `thread_history_unavailable` error that reports any matched notice.
4. Continue growth through **one** persistent `uibridge chat` process only.
   Use unique markers, then export again after enough turns to force actual
   virtualization. Compare the ID set before/after and against the number of
   successful ledger events. Do not use one-shot loops.
5. Add the export route to the HTTP API only after CLI live acceptance. Update
   README/package version/tests, remove any scratch probe, and rerun package
   dry-run.

Scratch `_measure-thread.mjs` was measurement-only and has been removed. The
durable local ledger and downloads are gitignored.

---

## 1. What this is, and the goal behind it

A local, OpenAI-compatible HTTP API backed by **chat UIs the user already
pays for** (Gemini, ChatGPT). A pipeline calls
`http://127.0.0.1:8477/v1/chat/completions`; a real Chrome, signed in as the
user, does what their hands would have done; the answer returns as JSON with
its tables parsed, citations resolved, and any generated file already on
disk.

**The problem it replaces**, in the user's words: "plugging in my fingers to
move .csvs and pdfs in and out of these chatbot UIs."

**Why not the vendor APIs**: hard daily request caps are structurally
unacceptable for this workload, and per-token billing on a corpus-scale
literature review is not viable. The subscription is the budget.

**Downstream consumer**: LitScape, the user's medical-literature project -
systematic review, meta-analysis, research-landscape work. That context
drives requirements that would otherwise look like over-engineering:

- **Provenance is not optional.** A row in a systematic review must be
  attributable to the model that actually produced it. "Requested" is not
  "applied", and the difference belongs in a methods section.
- **Silent wrongness is the worst failure mode.** An answer from an
  anonymous session, or from a different model than requested, or a
  "something went wrong" notice mistaken for content, poisons a batch of two
  hundred rows with nothing to mark it.
- **Structure must survive.** Tables as rows, LaTeX as source, CSVs as
  bytes. A pipe table arriving tab-separated is a silent data-quality bug.

---

## 2. Non-negotiable rules

These come from the user directly and from expensive lessons. Do not
relitigate them.

### Engineering discipline

1. **Explore before you guess.** Print the DOM, read the network, dump the
   payload. The user: "Nearly all of your failures were due to you trying to
   guess logic instead of actually exploring and assessing it directly. The
   first part of you just MUST be this field exploration and assessment."
   Every guessed selector in this project's history surfaced as a timeout
   somewhere unrelated and cost hours in the wrong place.
2. **Prefer the network to the DOM, everywhere.** Payloads are indifferent
   to class names, translations and layout. The DOM is for actuation only
   (type, click, set a control) and as a fallback for extraction.
3. **Measure, then write it down.** Every non-obvious value in a
   `selectors.json` has a `_key` sibling recording what was observed, when,
   and what the wrong assumption was. Keep that habit; it is why this
   codebase can be picked up at all.
4. **A guessed value must be marked as one.** A provider whose selectors are
   placeholders sets `calibrated: false`, refuses to run, and is not
   advertised by `/v1/models`. A plausible-looking placeholder is worse than
   nothing.
5. **Verify by effect, not by API success.** A click Playwright reports as
   successful can be ignored by the app. A model selection can be accepted
   and dropped. Assert the observable consequence.

### Safety and account integrity

6. **Never type or handle the user's credentials.** Sign-in is a human
   action in a visible window (`uibridge login <provider>`), and the session
   lives in the Chrome profile. `.profiles/` is gitignored because it is as
   sensitive as a password.
7. **Never forge or replay anti-bot tokens.** ChatGPT signs its conversation
   requests with a sentinel proof token whose payload is a browser
   fingerprint, and signs its file endpoints with a bearer token held in
   page JavaScript. **The page sends; we read.** Lifting the access token
   out of the session to call an endpoint directly is out of bounds, even
   though it would be easy and would simplify downloads.
8. **Never solve or evade a verification challenge.** Detect it, stop, and
   tell the human to clear it (`503 challenge`).
9. **Do not burst these sites.** See section 7. This was violated once and
   tripped a real lock on the user's account.
10. **`/api/auth/session` payloads are never retained.** The response
    carries a bearer token and says so itself. Field lookup happens inside
    the page; only a verdict comes back.
11. Terms-of-service caveats about UI automation are permanently dropped at
    the user's instruction: "the only thing being automated here is my
    hand." Do not re-raise them.

### Communication with this user

12. **Lead with stage, state, and next step.** Their words: "your texts and
    responses you're giving me here are borderline unintelligible. I dont
    know what stage you're in or wtf is the problem. The biggest hurdle in
    this entire project is how poor our communication is." A small table
    beats paragraphs. Findings come after the map, and only if they change a
    decision.
13. **Never bury "X does not work" inside a paragraph about something that
    does.** When a measurement contradicts an earlier claim, say so in one
    plain line.

---

## 3. Architecture

Two things vary independently, and keeping them apart is the design:

- **Actuation** - driving the UI: type, submit, pick a model, attach a file.
  Necessarily DOM work.
- **Extraction** - reading the answer back. A **transport**: the network
  (`wire`), the provider's copy button (`copy`), rebuilt markdown
  (`dom-markdown`), or innerText (`rendered`).

Nothing above `src/providers/` knows a provider exists. Adding a provider is
a `selectors.json` plus its quirks; the request flow, completion detection,
uploads, citations and file retrieval are inherited.

```
src/core/           provider-agnostic infrastructure
  chrome.mjs        Chrome lifecycle; attach over CDP to a fixed port
  pool.mjs          TabPool: one tab per concurrent request, poisoned tabs discarded
  config.mjs        operational settings (ports, timeouts, pacing) - NOT selectors
  auth.mjs          session detection (evidence -> ranked verdict) + the sign-in message
  signin.mjs        awaitSignIn: in-page banner, polls until a session appears
  errors.mjs        typed errors carrying HTTP status + retryable
  async.mjs         waitFor, waitStable, Mutex, retry, Pacer
  markdown.mjs      table/code-fence parsing, newline normalisation
  log.mjs           levelled logger with request ids

src/providers/
  contract.mjs      the seam: what every provider must implement
  dom-provider.mjs  the generic request flow, written once
  registry.mjs      provider list, model catalogue, model-id resolution
  gemini/           selectors.json + quirks   (extraction: DOM/copy)
  chatgpt/          selectors.json + quirks   (extraction: wire)

src/transports/
  wire.mjs          WireTap: CDP tap on the responses the page receives
  sse-openai.mjs    decoder for ChatGPT's "v1" delta stream
  files-wire.mjs    generated files: click, keep the bytes, name them safely
  dom.mjs           copy button, generated-file overlay, completion signals
  markdown-dom.mjs  rebuild markdown from elements when the clipboard is dead

src/api/
  server.mjs        HTTP routing
  openai.mjs        OpenAI envelope + the _uibridge block

src/tools/
  recon.mjs         map an UNKNOWN site: DOM vocabulary + every request
  anoncheck.mjs     prove signed-out detection on a throwaway profile
  capture.mjs       record one exchange for calibration

bin/uibridge.mjs    CLI: serve, login, doctor, ask, recon, capture
  test/unit.mjs       67 tests, no browser, ~2s
test/live.py        live UI-surface suite (needs a signed-in profile)
examples/_client.py the client a pipeline copies
```

### Request lifecycle (`src/session.mjs`)

1. **Pace.** `Pacer` spaces request *starts* provider-wide (section 7).
2. **Take a tab** from the pool (fresh conversation per request, so requests
   cannot see each other's context).
3. **Open** the provider, wait for a *visible* composer.
4. **Prove the session** (`core/auth.mjs`). `challenge` -> stop.
   Not `in` -> stop with instructions. `unknown` counts as signed out.
5. **Dismiss blocking notices** and record them.
6. **Select model / modes**, then read the UI's state back *once* after
   everything is applied.
7. **Attach files**, waiting on a real readiness signal.
8. **Arm the wire tap, then submit.** On a wired provider the tap must be
   armed before the send or the response is lost.
9. **Await completion**: the stream closing (wire), or turn-count + text
   stability + stop-control absence (DOM).
10. **Extract**, then retrieve generated files.
11. **Re-verify the model** against what the server says answered.

---

## 4. Provider status

| | Gemini | ChatGPT |
|---|---|---|
| Send prompt, get answer | works | works |
| Extraction | DOM: copy button, then rebuilt markdown, then innerText | **wire**: the response the page receives |
| File attachments | works (trusted CDP drag) | works (hidden unrestricted file input, each upload confirmed on the wire) |
| Model selection | works, flaky on Gemini's side, retried and reported | works (family x effort), confirmed by the server's slug |
| Generated files | works (viewer overlay -> Download control) | works (sandbox link -> page fetch -> keep the bytes) |
| Citations | works (`...` -> View sources) | works, with character offsets into the answer |
| Model provenance from the server | not available | `provenance.answered_by` |

---

## 5. Measured knowledge base

Everything here was observed on the live sites. Dates matter: these UIs
move.

### 5.1 ChatGPT wire format (2026-09-06)

`POST /backend-api/f/conversation` answers `text/event-stream` in a compact
delta encoding announced by `event: delta_encoding` / `data: "v1"`.

- **The one rule that matters**: a delta with no `o` (op) and no `p` (path)
  **inherits both from the previous delta**. A first implementation that
  treated every frame as self-describing recovered 29 characters of a 2 KB
  answer and looked like it had worked.
- `c` selects a channel. One turn carries many messages: user context,
  several system messages, assistant `code`, `tool execution_output`,
  assistant `thoughts`/`reasoning_recap`, and finally assistant `text`.
- `o: "patch"` batches ops, and **patch mode persists**: later bare frames
  carry op arrays.
- Frames with a `type` are control frames (`resume_conversation_token`,
  `title_generation`, `message_marker`, ...). `[DONE]` ends the stream.
- **The answer** is the last channel with
  `author.role === 'assistant' && content.content_type === 'text'`. Taking
  "the last assistant message" without checking the content type returns a
  tool call or a thought.
- **The model that answered** is `metadata.model_slug`. This is the only
  honest provenance available anywhere in the project.

**Citations.** Inline private-use sentinels wrap a marker:
`citeturn638403search2`. Strip the **whole span**, not
just the sentinels, or `citeturn638403search2` ends up inside a table cell
and travels into a CSV. Remember the offset in the *clean* text.
The sources are in `metadata.search_result_groups[].entries[]` on the
**tool and reasoning channels** - not on the final message, whose
`content_references` are routinely `invalid: true` with no URL. Reading only
those produced a confident, wrong report that the sources had been withheld
while the UI was showing them. Match `ref_id` -> `turn{turn_index}{ref_type}{ref_index}`.

### 5.2 ChatGPT models: two dimensions

The composer pill (default text "Instantânea"; hover "Esforço de
raciocínio") opens **one popover with two panels**:

- **effort**, a `role="slider"` with `aria-valuenow` 0..3:
  0 Instantânea, 1 Média, 2 Alta, 3 Pro (locked on this plan - the value
  refuses to move). Driven with arrow keys, as its own help text says.
- **family**, `role="menuitemradio"`: "GPT-5.6 Sol", "GPT-5.5". Reached by
  clicking the row labelled "Selecionar modelo"; clicking a radio while the
  slider panel is up is intercepted by that panel. One Escape steps back a
  panel, a second closes the popover.

The request body reveals the truth: `model` is `gpt-5-6` at Instantânea and
`gpt-5-6-thinking` at both Média and Alta, distinguished by
`thinking_effort` (absent / `standard` / `extended`). So verification needs
**both** fields. `/backend-api/models` lists the categories
(`gpt_5_6_instant`, `gpt_5_6_reasoning`, `gpt_5_6_reasoning_mini`,
`gpt_5_auto`, `research`).

Instantânea **auto-routes**: a PDF question at that setting was answered by
`gpt-5-6-thinking`, a plain one by `gpt-5-6`. The slug pattern for the
instant ids admits both deliberately.

### 5.3 ChatGPT uploads

`input#upload-files` is a hidden `input[type=file]` with **no accept filter**
and `multiple`, so PDFs and CSVs go straight in. The two testid'd inputs
(`upload-photos-input`, `upload-media-input`) are image/media only.

Readiness is **not** the send button (enabled throughout) and not a chip.
The sequence is: `POST /backend-api/files` (returns a signed upload URL) ->
`PUT` the bytes to `oaiusercontent.com` -> `POST
/backend-api/files/process_upload_stream`, an event stream ending in
`file.processing.file_ready`. One completed call carrying `file_ready` per
file is the signal. An earlier guess (`/files/<id>/uploaded`) never fired,
and the prompt was never sent - the file just sat there attached.

### 5.4 ChatGPT generated files

The answer text carries `[label](sandbox:/mnt/data/name.csv)`, rendered as
`button.behavior-btn` whose `aria-label` is the link text. No `href`, no
`<a download>`, so scanning for download affordances finds nothing.

Clicking makes the **page** fetch:
`GET /backend-api/conversation/<id>/interpreter/download?message_id=..&sandbox_path=..`
-> `{download_url, file_name, mime_type, metadata:{file_id}}`, then
`GET /backend-api/estuary/content?..` -> the bytes, with the real name in
`content-disposition` (including a UTF-8 form).

Two things were verified so nobody has to retry the shortcuts:

- **Chrome writes no file.** With `Browser.setDownloadBehavior` set to
  `allow` plus a download path: zero download events, empty directory. The
  bytes exist only in the response the page received.
- **We cannot call the endpoints.** An in-page `fetch` with
  `credentials: 'include'` **and** Playwright's `APIRequestContext` both
  return `401 {"detail":{"message":"Unauthorized - Access token is
  missing"}}`. The app adds an Authorization bearer header in its own JS.

Scope: format-agnostic files sent through the composer and downloadable files
returned by a thread. Canvas "textdocs" are UI documents rather than files
and remain outside the contract; no extension/MIME allowlist is used.

### 5.5 Session detection (`core/auth.mjs`)

**These UIs answer while logged out.** chatgpt.com serves a whole anonymous
application - its own bundle under `/unauth-mweb/`, its own composer
(`textarea#mobile-composer-prompt`), image-only file inputs. So a request
against a signed-out browser does not fail; it succeeds with a weaker model
and drops the result into a batch with nothing to mark it.

Therefore: **prove signed in, never infer it.** Evidence is ranked -
challenge > account from the app's own session endpoint > session cookie >
anonymous bundle > endpoint answered with no user > weak DOM markers. States
are `in` / `anonymous` / `challenge` / `unknown`, and **`unknown` is treated
as signed out**. The old code returned `true` when it had nothing to go on,
which is the one answer that fails silently.

Cookies must be read from the **browser context**, not `document.cookie`: a
session token is httpOnly, which is exactly what JS cannot see. Gemini's are
`SID`, `__Secure-1PSID`, `__Secure-3PSID`.

`uibridge doctor <id> --anon` proves the negative on a throwaway profile. A
signal that has only ever been seen fire one way has not been tested.

### 5.6 The rate-limit lock (important, and easy to misdiagnose)

After too many requests the site raises a modal:

> **Excesso de solicitações** - "Você está fazendo solicitações rápido
> demais. Limitamos temporariamente o acesso às suas conversas para proteger
> seus dados. Aguarde alguns minutos antes de tentar novamente" - one button,
> **"Entendido"**.

Per the user, this is a **per-user data-protection lock, not a bot
challenge**: new chats still send and answer normally; **previous
conversations become unreachable** (they load empty, and the conversations
endpoint returns 429).

Consequences that cost four failed download runs:

- Its backdrop (`fixed inset-0 z-50`) **swallows every click**. Playwright
  says "subtree intercepts pointer events" and a download click times out
  having sent no request at all.
- It **reappears every few seconds** while the lock is active, because each
  conversations poll 429s and re-raises it. Dismissing once per request is a
  race that loses about half the time.
- Old conversations cannot be used to verify anything while it is up. Verify
  on a fresh turn instead - which is what the bridge does anyway.

It is reported (`_uibridge.throttle_notice`) and never raised: the request
that produced an answer still produced an answer.

### 5.7 Clicks in these apps

- **Layout panels intercept clicks.** `data-side-pane-shell-host`, the
  scroll root, and the sticky composer cover a link at the bottom of a
  thread. Centre the element (`scrollIntoView({block:'center'})`) and, if
  something still covers it, dispatch on the element itself
  (`locator.evaluate(el => el.click())`).
- **A click can be accepted and ignored** during the re-render after a modal
  closes. Judge success by the page issuing the request, and repeat the
  click until it does.

### 5.8 CDP gotchas (all measured)

- **Subscribe at `responseReceived`.** `Network.streamResourceContent` must
  be requested then, or a streamed body is not retained and the one response
  worth having comes back empty.
- **An empty stream still needs `getResponseBody`.** The subscription can
  succeed and deliver no `dataReceived` events - this wrote a 0-byte "CSV".
  Test emptiness, not the subscription's return value.
- **A redirect reuses the request id.** Chrome re-fires
  `requestWillBeSent` with a `redirectResponse`; treating it as a new
  request orphans the capture, which then waits out its whole timeout for a
  response that already arrived.
- **Chunks are base64 and can split a multibyte character.** Join buffers
  and decode once, or a pt-BR accent or a citation sentinel is corrupted.
  Keep the raw `buffer` for files: a utf8 round-trip destroys an xlsx.
- **Response headers are kept to an allowlist** (content-type,
  -disposition, -length). The full bag carries `set-cookie`, and snapshots
  reach logs and error bodies.
- **Chrome's `--user-data-dir` must be absolute** or Chrome never opens the
  debugging port and the connection times out with no explanation.
- Ports: gemini 9333, chatgpt 9334 (`basePort` + provider index); recon
  9400, anon-check 9411.

### 5.9 Gemini specifics

- The **copy button is the only route to real markdown**. innerText renders
  a pipe table as tab-separated runs and loses LaTeX entirely: KaTeX keeps
  no `<annotation>` and no `data-latex`, so rendered maths has no source in
  the DOM. Measured: innerText `t ^ 2 = C Q-(k-1)` vs copy
  `$\hat{\tau}^2 = \frac{Q-(k-1)}{C}$`.
- **The clipboard is one machine-wide buffer.** Two tabs copying at once
  read each other's answer, which looks exactly like the model replying to
  the wrong prompt. Hence a mutex and an identity check. It also needs a
  focused document, so a pooled background tab must be fronted.
- **Generation never appears in page-level CDP traffic** (checked three
  ways, including `streamResourceContent` and collecting in-flight
  requests); there is no service worker, and the visible RPCs are obfuscated
  positional arrays behind an `at` token. That is why the DOM ladder exists
  at all, and why a wire transport for Gemini is not currently possible.
- **Uploads need a trusted CDP drag.** Synthetic `DragEvent`s are ignored -
  tested against nine targets, zero attachments every time - and there is no
  `input[type=file]`.
- **A generated file is not a link.** No `<a download>`, no `blob:` href.
  The bytes sit behind an "Open" control that opens a viewer overlay whose
  toolbar is `div[role=button]`, not `<button>`.
- **Model switching genuinely drops selections** (Gemini's bug), so it is
  retried and then read back; an unverified selection is reported, never
  hidden. The **active option is `aria-disabled`**, so clicking it can never
  succeed - treat it as confirmation.
- Enter does **not** submit; the send button is the only path, and it stays
  enabled throughout, so its state says nothing about readiness.
- The account renders in **pt-BR**. Never match on English button text.

### 5.10 Providers render their own failures as ordinary messages

"Sorry, something went wrong. Please try your request again." arrives as a
short, valid-looking answer. Per the user: "they are answers nonetheless.
It's up for downstream code using ui bridge to handle error logic, but
insofar a message has been generated and retrieved, this is a success for
us." So it is **delivered** with `provider_error: true`, still a 200, and
never retried automatically.

---

## 6. Public API

`POST /v1/chat/completions` (OpenAI envelope; `attachments: [paths]`,
`modes: {thinking: bool}`, optional `thread_id`), `GET /v1/models`,
`GET /v1/capabilities`.

Everything specific is under `_uibridge`:

| field | meaning |
|---|---|
| `provenance.model.requested/applied/verified/note` | what was asked for vs what the UI holds |
| `provenance.answered_by`, `sent_as`, `sent_effort` | wire only: the slug the **server** says answered, and what the page asked for |
| `provenance.final_state` | the picker read back after everything was applied |
| `extraction` | `wire` / `copy` / `dom-markdown` / `rendered` |
| `markdown`, `lossy_math` | whether the text is markdown; whether maths lost its source |
| `tables`, `code_blocks`, `json` | parsed from that markdown |
| `files` | generated files on disk (`{name, path, bytes, mime}`), or `{name, error}` when retrieval failed - never silently short |
| `ledger` | local per-native-thread JSONL record of input/output paths, sizes and SHA-256 hashes; no prompt/answer text or credentials |
| `thread_id` | provider-native UUID from the thread URL; pass it to a later request to continue that exact thread |
| `browsed`, `searched`, `sources`, `citations` | searched = attempted; browsed = the answer carries citations; citations carry `at`, the offset in the content |
| `provider_error` | the text is the provider's own error notice |
| `truncated` | the stream ended before the site said it was done |
| `throttle_notice`, `notices` | blocking notices seen (and dismissed) during the request |
| `usage` | always zero. Token counts are not observable through a UI, and inventing them would be worse than admitting it |

Typed errors: `401 signed_out`, `503 challenge`, `400 invalid_request`,
`502 ui_contract`, `504 timeout`, `501 not_calibrated`, `429 rate_limited`,
`502 upload_failed`, `502 model_not_applied`, `502 compose_failed`,
`502 submit_failed`. **An error means no message was retrieved.** A message
that *was* retrieved is always a 200, even when the provider used it to say
it failed.

---

## 7. Pacing: do not burst these sites

`minIntervalMs` is the minimum spacing between request **starts**,
provider-wide across all tabs: **ChatGPT 20 s** (concurrency 1),
**Gemini 8 s**. Set per provider in `config.json`.

This exists because it was violated. About a dozen fresh conversations in
fifteen minutes tripped the lock in 5.6 on the user's real account. Their
words: "You werent supposed to keep spawning tab after tab so fast. For
fucks sake you're hitting the same abuse mechanics we are not supposed to
trigger at all."

Raise it for long batches. **Never lower it to make a batch faster.**

Related discipline: **one tab, always released.** Ad-hoc probe scripts that
died before `page.close()` left eleven tabs open, each polling the site.
Reuse the first tab, close the rest, and clean up in a `finally`.

---

## 8. How to work on this

```bash
npm install
node bin/uibridge.mjs login chatgpt        # sign in by hand, once
uibridge logout chatgpt                    # clear the dedicated session
uibridge status --json                     # scriptable auth state for every provider
uibridge models --json                     # advertised model ids
uibridge threads [provider] --json          # recorded provider-native threads
uibridge thread <provider> <id> --json      # per-turn sent/downloaded file ledger
node bin/uibridge.mjs doctor               # chrome, session, models, contracts
node bin/uibridge.mjs doctor chatgpt --anon  # prove signed-out detection
npm test                                   # 68 unit tests, no browser, ~2s
python test/live.py                        # live suite (signed-in profile)

node bin/uibridge.mjs ask chatgpt "..." --file=paper.pdf --model=chatgpt-5.6-high
node bin/uibridge.mjs recon observe https://example.com/   # map an unknown site
node bin/uibridge.mjs recon exchange https://example.com/ --composer=... --send=... --prompt=...
```

**Workflow for anything UI-facing**: `recon` first, read the dump, then
write selectors, then a live check, then record what was measured in the
`_key` comment. Never the other way round.

**Where things go**: selectors in `providers/<id>/selectors.json`; provider
quirks in `providers/<id>/index.mjs`; anything reusable in `core/` or
`transports/`. No selector, provider name or vendor quirk above
`src/providers/`.

**Environment**: Windows, Chrome via CDP, Playwright 1.63, Node 22.
Files are CRLF (`core.autocrlf=true`). Gitignored: `.profiles/` (live
sessions), `testdata/recon/` and `testdata/capture/` (raw bodies carry
tokens), `downloads/`, `_*.mjs` (scratch probes).

**A trap specific to this environment**: a bash heredoc feeding python
strips backslashes, and a Write tool call once turned `\x00-\x1f` into
literal control bytes in the source. For code containing escapes, use the
editing tools and verify with a byte-level check afterwards.

---

## 9. Scope boundaries and operational notes

### Live verification completed 2026-09-06

1. **The GPT-5.5 family switch** succeeded: `chatgpt-5.5-medium` was sent as
   `gpt-5-5-thinking` with `thinking_effort=standard`, and the server reported
   that model as the answerer.
2. **Medium vs high effort** is distinguished live: `chatgpt-5.6-high` was
   sent as `gpt-5-6-thinking` with `thinking_effort=extended`; medium was
   observed with `standard`.

### Deliberately out of scope or externally blocked

3. **Canvas/textdocs are out of scope.** The user confirmed that ChatGPT
   Canvas is not part of this bridge's purpose. The supported artifact path
   is format-agnostic files exchanged through a chat thread. UI-native
   documents and canvases are not files and are not part of the contract.
4. **Streaming responses are built.** With `stream: true`, ChatGPT's partial
   wire body is decoded into OpenAI-compatible SSE content chunks. DOM-only
   providers emit their extracted answer as one content chunk. The final
   chunk carries `_uibridge` provenance and is followed by `[DONE]`.
5. **Gemini wire transport is not a missing product feature.** Repeated live
   measurement found no generation payload in page-level traffic (5.9), so
   Gemini correctly uses its copy/DOM extraction ladder. If the site later
   exposes a readable payload, the transport seam can adopt it.
6. **Provider notices remain measurement-driven.** The generic notice and
   click-through mechanism is built. ChatGPT's observed rate-limit dialog is
   calibrated. No Gemini dialog was visible during the final authenticated
   inspection, so no speculative selector was added.

### Operational design

7. **Conversation isolation is the default, continuation is explicit.** Omit
   `thread_id` for a new isolated provider thread, or pass the provider-native
   UUID to continue it. Long-thread history is allowed to hydrate and settle
   before a response baseline is taken; changed assistant blocks are tracked
   directly instead of relying on DOM counts that virtualization invalidates.
8. **Both calibration and production can reuse a thread.** `uibridge capture
   <provider> --continue "follow-up"` minimizes investigative traffic;
   `uibridge ask <provider> --thread=<native-id>` and top-level API
   `thread_id` provide explicit production continuation.
9. **Retry policy is deliberately narrow**: only `compose_failed` and
   `submit_failed`, once. Timeouts are not retried (the model was working,
   and repeating a ten-minute wait costs the caller more than it recovers).
   Provider errors are not retried (caller's policy).
10. **Authentication paths are intentionally not automated.** Login waits for
    the authoritative end state, so password, passkey, Windows Hello, MFA and
    account-choice flows can vary without becoming bridge logic. ChatGPT is
    proven by `/api/auth/session`; Gemini by its observed SID-family cookies.

### Deferred by the user

11. **LitScape v2 redesign** - the consumer of this bridge. Out of scope
    here.

---

## 10. Honest status

**Both providers work end to end today**: prompt, attachments, model
selection, markdown with tables and citations, and generated files on disk.
ChatGPT's answers, model provenance and citations come off the network;
Gemini's come from its own copy control with two fallbacks below it.

The GPT-5.5 family switch and high/medium effort distinction were watched
succeeding live on 2026-09-06. Everything claimed in section 5 was measured;
where a measurement contradicts an earlier comment or commit message, the
comment is corrected rather than quietly retained.

Signed-out HTTP acceptance was also measured on 2026-09-06 after clearing
both dedicated profiles: `gemini-flash` returned `401 signed_out` in 985 ms;
`chatgpt-5.6-instant` returned `401 signed_out` in 3.9 s, with the anonymous
bundle named as evidence. Neither prompt reached a chatbot.

---

## 11. Thread export and thread-wide file retrieval (2026-09-06, phase 3)

The chat UIs virtualize history: a 34-message ChatGPT thread keeps about six
messages in the document. Reading a thread is therefore a *walk*, and the
walk is provider-generic (`src/transports/thread-dom.mjs`); what is per
provider is only the identity contract, in `thread.export` of its
`selectors.json`. Both contracts are measured, not guessed:

| provider | messageNode | identity |
|---|---|---|
| ChatGPT | `[data-message-author-role][data-message-id]` | `data-message-id` (uuid), role and `data-message-model-slug` on the same node; a sent file's name is in `div.overflow-hidden > div.truncate.font-semibold` inside the message node |
| Gemini | `user-query, model-response` | `id` on a descendant `message-content[id]`; a user turn borrows the id of the message after it (`pairId: "next"`), role from element name, screen-reader labels pruned via `textExclude` |

### What the walk had to get right

1. **Hydrate upward first.** History arrives as the top comes into view, so
   one jump to zero proves nothing. Repeat until neither scroll height nor
   message count changes, twice in a row.
2. **Never read a scroller that is still settling.** A reading taken right
   after a jump can be showing the messages the scroller came *from*. This
   shipped once: a jump to the top returned the thread's *last three*
   messages, and first-sight ordering then put the end of the conversation
   in front of the beginning. Readings now wait for the mounted set and the
   offset to stop changing.
3. **Order is DOM order, stitched.** Each reading is a contiguous slice in
   document order; unknown messages are spliced in after the last known
   message of that same reading, never appended in discovery order.
4. **Verify, then claim.** The assembled order is checked against every
   reading taken. `order_verified: false` (and `complete: false`) is
   reported rather than serving a scrambled transcript. A thread export that
   silently reorders a conversation is worse than one that fails, because a
   meta-analysis built on it cannot tell.

### Resuming a thread: two rules learned by breaking them

- **Sending must not be gated on reading.** The resume path waited for a
  thread's previous messages to render before submitting - which is exactly
  what the rate-limit lock removes (it keeps accepting new messages while it
  stops serving old conversations). The result was the user's file attached
  to the composer and the turn abandoned unsent. The wait is now advisory:
  `provenance.history` is `loaded` or `not_loaded`, and the send proceeds.
- **A visible composer is not proof of arrival.** A `/c/<id>` load that
  lands on a blank new chat has one too, so messages were being written into
  brand new conversations - misattributed, and manufacturing precisely the
  fresh chats that trip the rate limiter. `resumeThread` now verifies the
  thread id it landed on and refuses with `503 thread_unavailable`.

### Files, both directions

`send` and `download` are the only two file operations, and no format
specific logic exists anywhere. An export names sent files (`attachments`)
and generated files (`file_controls`); `--files` / `"files": true` retrieves
the generated ones by scrolling each message back into view and clicking its
control, reading the bytes off the wire (the app's bearer token is never
touched). Verified live: a file generated 25 messages earlier was recovered
byte-exact.

### Live acceptance (2026-09-06)

Thread `6a9ddcb5…` grown to 34 messages through one persistent tab
(8-22 s/turn), then exported: `complete: true`, 34/34 ordered, stable ids,
`order_verified: true` across 19 readings, `mounted_at_end: 6`, strict
user/assistant alternation, markers `VBIG_01…VBIG_08` in sequence, sent and
generated files both present, and the same export served over
`POST /v1/threads/export`. Gemini exports through the same code path with
its own contract.

### Still open

- Gemini's `notices` block is unmeasured; its rate-limit text is unknown.
- Gemini answers still cannot be read off the wire (section 5.9).
- ChatGPT's `authCookiePattern` remains an unobserved guess.
- Latency is dominated by cold page loads in one-shot mode; the persistent
  `chat` tab is the fast path and a warm pool would generalise it.

### 11.1 The CLI is a client, not a second copy (added after live review)

One process may drive one Chrome profile. Every CLI command opening its own
`Session` therefore had two costs, and the user caught both:

- ~40 s of Chrome and site boot per turn, thrown away at the end of it.
- Hard collisions: a command issued while `serve` was running waited 60 s
  for a composer owned by the other process, then failed. A Gemini export
  failed exactly this way, and a ChatGPT `thread_mismatch` was made worse by
  it (the underlying cause there was the rate-limit lock, which stops
  previous conversations from being served while sending still works).

`src/core/client.mjs` makes `ask`, `chat` and `export` clients of a running
uibridge, starting one detached if none answers `/health`, with its output
in `.uibridge/daemon.log` (discarding it made failures inside the daemon
undiagnosable). `--local` keeps the in-process path for debugging the
browser layer itself, and `uibridge stop` exists because a running daemon
keeps serving the code it started with - `POST /admin/shutdown`, loopback
like the rest of the API.

Measured 2026-09-06 on the same command and thread: 71 s cold, 14.3 s warm
(10.5 s of that the model). `chat` turns: 10.1 s and 8.2 s.

### 11.2 Audit corrections

- ChatGPT/wire continuations no longer wait for historical DOM at all;
  `provenance.history` is `not_required`. The former advisory wait could
  still consume 60 seconds before sending even though history was irrelevant.
- DOM-only continuations use a short `historyBaselineMs` budget (8 seconds by
  default), and this check runs before attachments are placed in the composer.
  Full export alone uses `historyTimeoutMs` (60 seconds).
- `/health` identifies `service: "uibridge"` and protocol version. The CLI
  refuses an unrelated/incompatible service on the configured port and no
  longer silently falls back to a second local browser driver when daemon
  startup fails.

### 11.3 Where a turn's time actually goes (measured 2026-09-06, phase timing)

The send path now logs every phase before submission at debug level, because
"22 s for a 1.9 s answer" is an observation, not a diagnosis, and the first
two guesses (the history wait, then the pacer) were both wrong.

| phase | cold tab | warm tab |
|---|---|---|
| auth (`prepareAuth` + `sessionState`) | 11.9 s | 0.2 s |
| open | 0.0 s | 0.0 s |
| thread (resume/navigate) | 11.1 s | 0.0 s |
| notices, history, attach, baseline | 0.3 s | 0.2 s |
| submit | 1.8 s | 1.4 s |
| model | 4.4 s | 2.6 s |
| **total** | **~25 s** | **4.4 s** |

So a warm continuation costs 0.4 s of uibridge before the prompt is sent,
and every large number ever measured on this path was the FIRST turn after
a daemon restart - a Chrome tab and the site booting. That is also why
`uibridge stop` between code changes shows up as a slow next command.

`provenance.history` is `not_required` on ChatGPT: confirmed live, no wait.
Pacing was NOT involved - a continuation uses `continuationIntervalMs`
(0 by default), and the debug log shows no pacer wait on these turns.

### 11.4 Honesty of exported text

Every exported message carries `text_source: 'rendered'`. A live ChatGPT
answer is read off the wire and is the model's own markdown; an exported
historical one is read back out of the rendered page, so fences and tables
are reconstructed and maths may be glyphs rather than LaTeX. The field names
are the same, the provenance is not.

### 11.5 Known limits (not defects, but not to be discovered by surprise)

- Export covers the ACTIVE branch. Regenerated/alternate branches are not
  walked, and no evidence field claims they are.
- Historical file retrieval is proven for sandbox (code-interpreter) files.
  Generated images use other endpoints and are not retrieved.
- A running daemon serves the code it started with. `/health` now carries
  `service` and `protocol`; a daemon predating that is recognised as
  `legacy` - enough to be stopped by `uibridge stop`, never enough to be
  sent a prompt.
