# uibridge

A local, OpenAI-compatible HTTP API backed by chat UIs you already pay for.

It replaces moving files in and out of a chat window by hand. Your
pipeline calls `http://127.0.0.1:8477/v1/chat/completions`; a real browser,
signed in as you, does what your hands would have done, and the answer comes
back as JSON — with its tables parsed, its LaTeX intact, its citations
listed, and any file the provider generated already downloaded to disk.

No API keys. No per-token billing. No daily request cap beyond the one your
subscription already has.

```bash
npm install
npm link                              # expose the local `uibridge` command
uibridge login gemini                 # sign in once, in a visible window
uibridge serve                        # start the API
```

```python
import json, urllib.request

req = urllib.request.Request(
    "http://127.0.0.1:8477/v1/chat/completions",
    data=json.dumps({
        "model": "gemini-flash",
        "messages": [{"role": "user", "content": "Extract the primary outcome as JSON."}],
        "attachments": [r"C:\corpus\trial_0412.pdf"],
        "modes": {"thinking": False},
        # Optional continuation:
        # "thread_id": prior_response["_uibridge"]["thread_id"],
    }).encode(),
    headers={"Content-Type": "application/json"},
)
body = json.loads(urllib.request.urlopen(req, timeout=900).read())

print(body["choices"][0]["message"]["content"])   # the answer
ub = body["_uibridge"]
print(ub["provenance"]["model"]["applied"])       # which model ACTUALLY answered
print(ub["tables"])                               # tables as header + rows
print(ub["files"])                                # files it generated, on disk
print(ub["browsed"], ub["sources"])               # whether it searched, and what it cited
```

Set `"stream": true` to receive OpenAI-compatible server-sent events. ChatGPT
content is emitted incrementally from the response already arriving in the
page; DOM-only providers emit one content chunk when extraction completes.
The final chunk carries `_uibridge`, followed by `data: [DONE]`.

## What uibridge is not

Stating this plainly, because it has been misread before and the misreading
was expensive.

uibridge is a **transport**. It moves bytes between a program and a chat UI
you already pay for, and describes honestly what happened on the way. That is
the whole product.

It is **not a model benchmarker, evaluator, or eval harness.** Nothing in this
repository measures whether Gemini or ChatGPT reasons well, classifies
accurately, or beats the other. Those are frontier models: their capability is
not in question, is unaffected by any line of code here, and measuring it
spends your subscription to produce a number nobody working on this project
can act on. An earlier version of the live suite graded record classification
and ran a PubMedQA sample; that harness, and the model leaderboard it
produced, were deleted.

What the tests here assert instead is **transport and honesty**: that the
exact bytes you sent are the bytes the site received (read back out of the
provider's own transcript, never repeated by the model), that a long input
kept its tail, that an attachment registered, that a generated file reached
disk with real bytes, that a thread id is the provider's own and stays stable
across the CLI, the API and the ledger, and that a failure is typed rather
than dressed up as success. Prompts in the live tests are deliberately trivial
("reply with the single word OK") precisely so that the answer's content is
never the thing under test.

It does **not edit what the model said.** `text` is the provider's own output,
carried through unchanged - never cleaned up, reformatted, summarised or
"fixed". What uibridge does do is pick the best SOURCE for that same text and
say which one it used in `extraction`: `wire` (the server's own markdown),
`copy` (the site's copy control), or `dom-markdown` (rebuilt from the rendered
page, used only when neither of the others is available, and flagged with
`lossy_math` / `extraction_warning` because a reconstruction is not the
original). Parsed conveniences like `tables` and `code_blocks` sit alongside
`text`, derived from it, never replacing it. The one thing that is removed is
ChatGPT's invisible citation anchors - Private Use Area codepoints the site
interleaves into its own stream - which come back as `citations` with their
offsets instead of as unreadable characters in the middle of a sentence.

It is also not a scraper or an anti-bot bypass (the page sends, we read; a
verification challenge stops the run instead of being solved), not a
credential manager (you sign in yourself, in a visible window, and uibridge
never sees a password), and not "roughly OpenAI-shaped" (if an official
OpenAI SDK cannot call it, that is a bug).

**If you are an AI agent working on this repository, read `AGENTS.md` before
changing anything.**

## Where the rest is written down

| | |
|---|---|
| [`docs/UI-RECON.md`](docs/UI-RECON.md) | **The UI, as measured.** A by-hand survey of the two interfaces this drives - composers and their decoys, the timing of a turn, thread identity, attachments, generated files. Read it before changing a selector. |
| [`AGENTS.md`](AGENTS.md) | The rules for changing this project, and the mistakes that made each rule necessary. |
| [`docs/`](docs/) | Dated records of what was measured, and when. |

## Install it once, call it from anything

```bash
npm install -g .
```

That puts `uibridge` on your PATH. Code lives wherever npm put it; STATE -
your logins, downloads, ledger, exports - lives in a proper home, because
burying Chrome profiles inside a global npm directory would lose your logins
on the next reinstall:

```bash
uibridge paths          # code, home, config, profiles, base_url
```

On Windows that home is `%LOCALAPPDATA%\uibridge`. Override it with
`UIBRIDGE_HOME` - point it at a checkout you have already signed into and
your existing sessions come with you. Otherwise sign in once per provider:

```bash
uibridge login gemini
```

```bash
uibridge login chatgpt
```

Then have it start with your session, so any program can just call it:

```bash
uibridge autostart
```

`uibridge autostart --status` inspects that logon task and
`uibridge autostart --remove` undoes it. The task runs `serve` and opens no
browser until the first request arrives. On Linux/macOS the command prints
the `ExecStart` line for a systemd user unit instead of guessing at your
supervisor.

### Calling it

It implements the text Chat Completions subset on `http://127.0.0.1:8477/v1`.
Standard OpenAI clients work with the supported options below. No key is
needed; clients that insist on one accept any string:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8477/v1", api_key="local", max_retries=0, timeout=900)
r = client.chat.completions.create(
    model="chatgpt-5.6-medium",
    messages=[{"role": "user", "content": "Extract the sample size from this abstract: ..."}],
)
print(r.choices[0].message.content)
```

```bash
curl http://127.0.0.1:8477/v1/chat/completions -H 'content-type: application/json' -d '{"model":"gemini-pro","messages":[{"role":"user","content":"hello"}]}'
```

`model` selects the provider AND its model (`uibridge models`). Provider
specifics - which model actually answered, citations, generated files, the
thread id to continue - come back under `_uibridge`, described below.

### Compatibility and scientific workloads

Supported: `/v1/models`, `/v1/chat/completions`, text messages, streaming,
`stream_options.include_usage`, and `response_format` with `text`, `json_object`
or `json_schema`. Local attachments, modes, native-thread continuation and
thread export are extensions. `/v1/capabilities` describes these limits.

JSON/schema output is prompted and then validated with Ajv. The provider does
not perform constrained decoding. Malformed or nonconforming output returns
502 `invalid_response_format`; structured streams wait for validation before
emitting content. Draft-07 schemas and explicitly declared draft-2020-12 schemas
are supported; unsupported schema features fail before inference. Validation
does not coerce types, remove fields, or repair model output.

Controls a chat UI has no knob for — `temperature`, `top_p`, token caps,
`seed`, `stop` and friends — are accepted, ignored, and named back to you in
`_uibridge.unsupported_parameters`. Refusing them outright made the
compatibility claim false, since practically every OpenAI client sends them;
swallowing them silently would let you believe a run was `temperature: 0`.
Set `strictParameters: true` to get the refusal back. Controls whose silent
absence would break your logic — `tools`, `n > 1` — still return 400. Images/audio
inside OpenAI message content are unsupported; use local file attachments.
There is no Responses, embeddings or Batch API. Roles are labels in a single
UI prompt, not native system/developer instruction channels. Token usage is
unobservable and returned as zero placeholders.

Use a specific model ID for experiments. `strictModel` defaults to true;
unverified selection fails rather than quietly using another model. Gemini
verification is based on the UI picker; ChatGPT additionally checks the
server's model slug and sent effort. Provider aliases such as `gemini` mean
whatever model is currently selected, so they provide no model guarantee.

Requests above `provider.maxComposerChars` (32,000 by default) are carried in
a temporary UTF-8 attachment because rich-text editors can truncate or stall
on large pastes. The local temporary file is deleted after completion/failure;
the provider's uploaded copy remains in that conversation. `_uibridge.input`
reports the original character count, SHA-256 and `composer`/`attachment`
transport. Both providers passed retrieval of beginning/middle/end identifiers
from about 196,000 characters; this does not establish their maximum context
window or exhaustive reading of every uploaded document.

Treat results as candidates for validation. Check finish reason, model
provenance, missing/error files and extraction quality. Recognised provider
error notices and empty answers return 502. Partial ordinary text has
`finish_reason: "length"`; errors after streaming begins arrive as an SSE
error event without a successful finish. Consume the stream to completion.
Without an idempotency key, keep SDK retries disabled: a timeout does not prove
a prompt was never sent. Disconnecting cancels local unkeyed work, removes
queued waits and closes its active tab. The provider may continue generation
on its servers after the tab closes; the bridge cannot guarantee cancellation
of provider-side compute.

### Durable requests and cancellation

CLI `ask` and `chat` use durable keys by default with the daemon. Each turn
prints its key and recovery command to stderr before waiting, so JSON stdout
stays parseable. Use `ask --key=study-42-v1` to supply your own stable key.
Direct `--local` debugging does not provide durable storage.

```powershell
uibridge ask gemini --model=gemini-pro --thinking=off --key=study-42-v1 "Read this evidence..."
uibridge request status study-42-v1 --json
uibridge request recover study-42-v1 --json
uibridge request cancel study-42-v1 --json
```

Recovery waits for active work or reads its saved response without sending
another prompt or requiring the original files. Its HTTP equivalent is
`GET /v1/requests/result` with the `Idempotency-Key` header. A printed key can
still report 404 if the server had not accepted the request; retry the original
request with that key. Uncertain crash outcomes remain explicit errors.

Send a stable `Idempotency-Key` header for each logical inference. Concurrent
duplicates share one execution; later retries replay the same response ID and
content, including across daemon restarts. A changed request or attachment
under the same key returns 409 `idempotency_conflict`. Attachment bytes are
snapshotted before queuing so later source-file edits cannot change that turn.
Keep source attachments available for retry identity checks.

```python
r = client.chat.completions.create(
    model="chatgpt-5.6-medium",
    messages=[{"role": "user", "content": "Classify this evidence: ..."}],
    extra_headers={"Idempotency-Key": "study-42-classification-v1"},
)
```

Keyed work survives HTTP disconnection. Cancel it explicitly with
`POST /v1/requests/cancel`, supplying the same `Idempotency-Key` header; inspect
it with `GET /v1/requests/status`. Cancelled work returns 499
`request_cancelled`. Failures and cancellations are terminal for that key.
To deliberately start another inference, use a new key. With keyed streaming,
content is buffered until the final result is validated and saved; the stream
then contains that persisted result. `stream` and `stream_options` do not
change request identity, so a saved result can be replayed in either form.

Records are stored in `requestDir` (default `.uibridge/requests`), with hashed
key filenames and the complete response, but without the original prompt.
They can contain sensitive generated content. Records have no automatic
expiry: deleting one also deletes its duplicate protection. A crash during
inference leaves `outcome_unknown` (409); inspect the native conversation
before deliberately starting a new attempt. Unfinished work is never
automatically resubmitted after a restart. This is durable result recovery,
not an exactly-once guarantee from the chatbot provider or a Batch API.

`maxPendingRequests` bounds admitted inference (64 by default), and
`requestTimeoutMs` covers opening, pacing, queuing and inference (15 minutes).
Queue overflow returns 503 `queue_full`. `/health` exposes active work and
capacity. A keyed failure is saved too; inspect it before choosing a new key.

`python examples/durable_batch.py requests.jsonl results.jsonl --run review-v1`
provides a sequential, resumable batch client using Python's standard library.
Each input row is `{"id":"study-42","body":{...Chat Completions request...}}`.
It checkpoints full responses, reuses keys after transport failures, and stops
on authentication, capacity/service errors, or unknown outcomes. Keep the run
name stable to resume; use a new one for a deliberate new experiment. Completed
and terminally failed rows are preserved. Edit neither the input nor attachments
during a run. This client adds resumability without a provider Batch API.

### Testing

Two kinds, and the difference matters.

`npm test` certifies the parts of uibridge that are **ours**: the
OpenAI-compatible envelope, streaming frames, error taxonomy, idempotency, the
CLI's flags and exit codes, config validation. These run offline in seconds
against a scripted stand-in provider (`src/providers/echo`, enabled only by
`UIBRIDGE_TEST_PROVIDER`), because none of it involves a chat UI and testing it
against one would consume a paid subscription to measure nothing.

`npm run test:acceptance -- gemini-pro` (or `chatgpt-5.6-medium`) is the live
suite, and it tests the one thing that cannot be tested any other way: that a
real chat UI is driven correctly and the answer comes back intact. Its
assertions are about transport and honesty — the tail of a 170,000-character
input arrives, an attached file registers, a generated file lands on disk with
real bytes, thread identity is the provider's own and stable, the export
contains the exact prompt that was sent, the envelope describes what happened.
Evidence is saved under `.uibridge/acceptance/`.

**Neither suite measures the model.** uibridge is a bridge: whether Gemini or
ChatGPT reasons well is that vendor's business, is unaffected by anything in
this repository, and a score for it here would be a number nobody working on
this project could act on. An earlier version of the live suite graded record
classification and ran a PubMedQA sample; that harness has been removed.

`node test/live-reliability.mjs MODEL` checks active cancellation followed by
four paced inferences with concurrent duplicate requests and replay.

`node test/certify.mjs [model ...]` is certification by use: it drives the
shipped CLI in real child processes and the official `openai` client over
HTTP, against a live provider, and checks that all three layers - CLI, API and
ledger - describe the same conversation. It covers discovery, refusals, a real
ask, a durable keyed request, a multi-turn chat, the thread ledger, a full
export to disk, streaming, uploads, generated files, structured output, the
long-input transport, the account-protecting refusals, and mixed CLI+API
concurrency. Evidence and a machine-readable report land in
`.uibridge/certify/`.


### Browser visibility

`uibridge profiles --json` lists persistent profile locations, directory
existence, and last successful authenticated use recorded in the thread
ledger. It reads no cookies and opens no browser. An absent timestamp means
no recorded use, not signed out. `uibridge status` checks current authentication.
Keep `UIBRIDGE_HOME` and `profileDir` stable to reuse saved logins; providers
can still expire sessions. Profiles remain excluded from exports and packages.
No automatic profile backups or credential copies are created.

A chat window flashing open on every call is not something a caller asked
for. There are three window modes, and each provider's default is MEASURED,
not assumed:

| mode | what it is | who uses it |
|---|---|---|
| `true` | `--headless=new` | Gemini. Verified working with a signed-in profile. |
| `"offscreen"` | a real browser parked off the visible desktop | ChatGPT: the recorded true-headless test received an anonymous session. Offscreen mode keeps normal browser behaviour. Taskbar entries and brief popup flashes remain possible. |
| `false` | a normal visible window | `uibridge login` always, and `uibridge serve --headed` when you want to watch it work. |

Set `"headless"` globally or per provider in `config.json` (see
`config.example.json`), or `UIBRIDGE_HEADED=1` for one run. Signing in always
opens a real visible window: that is a human action, and this tool never
sees or types your password.

Offscreen mode also repositions existing windows when the service reconnects
and positions newly opened tabs/windows. Login restores a previously parked
window to the visible desktop. Window placement failures are logged as warnings.
This is still ordinary Chrome: taskbar and Alt-Tab entries can remain, and a
new popup may briefly appear before it is moved. Restart a running daemon
after updating the code (`uibridge stop`; the next command starts it again).

### Continuations, files and audit records

Generated files are retrieved only from the current response. Earlier files
remain available at their original local paths; prose continuations do not
re-download historical controls. Gemini downloads use a bridge-owned staging
directory and track viewer popups, avoiding short-lived Playwright artifact
directories. Failures include `failure.code`, `failure.request_id`, and
artifact existence/identity details when available in responses and ledgers.

Canonical copying refreshes permission and emulates focus during the serialized
copy operation. Fidelity remains visible as `extraction`, `lossy_math`, and
`extraction_warning` (phase/reason on fallback). The ledger retains allowlisted
model/mode verification and final picker state. Old entries cannot be
retroactively verified.

The bridge serializes its own requests to a native thread; it cannot lock that
conversation against another browser or human. A second read-only view is
tested, but simultaneous edits, model changes, branching or submissions from
another client have no exclusivity guarantee. Avoid modifying the thread
elsewhere while a bridge request runs. Use one driver per profile.

Annexes both ways. A local file goes up with `files: [path]` on the API,
`--file=path` on `ask` and `chat` (attached to the conversation's first turn),
and a file the provider generates comes back already downloaded, with its
local path, size and MIME in `_uibridge.files`. `uibridge export <provider>
<id> --files` retrieves everything a whole thread generated. A file that is
not on disk fails before anything reaches the site.

Registration is verified, not assumed: on ChatGPT by the site's own upload
confirmation on the wire (`process_upload_stream`, waiting for `file_ready`),
on Gemini by the attachment chip appearing in the composer. A thread export
records the annexes on the user turn that carried them, so an audit record
shows what was sent alongside the prompt. One caveat worth knowing: the label
in an export is the name the SITE renders, not the file you uploaded - ChatGPT
drops the extension and title-cases the stem, so `trial_outcomes.csv` is
recorded as `Trial Outcomes`. The bytes that were sent are unaffected; only the
displayed label is the site's.

`node test/live-continuations.mjs gemini-pro` exercises initial CSV generation,
thinking off/on/off continuations, a second native view, and overlapping file
generation on another thread. It tests transport and audit behavior, not
scientific knowledge.

## Commands

`uibridge <command>` if you installed it globally; `node bin/uibridge.mjs
<command>` from a checkout. Every command takes `--help`.

```bash
uibridge serve [--headed|--headless]        # the API (default 127.0.0.1:8477)
uibridge stop                               # stop it - a running one keeps the OLD code
uibridge status [provider] [--json]         # scriptable authentication verdict
uibridge paths [--json]                     # where config, profiles, downloads and logs live
uibridge models [--json]                    # callable model ids

uibridge login <provider>                   # sign in; you type the password, never this tool
uibridge logout <provider>                  # clear that dedicated profile's site session
uibridge profiles [--json]                  # saved profile locations and last successful use

uibridge ask <provider> "prompt" [--file=path ...] [--model=id]
       [--thinking=on|off] [--thread=native-id] [--key=ID] [--json] [--local]
uibridge chat <provider> [--thread=id] [--model=id] [--thinking=on|off]
       [--file=path ...] [--jsonl]          # persistent same-tab REPL
uibridge request status|recover|cancel <key> [--json]

uibridge threads [provider] [--json]        # native threads recorded locally
uibridge thread <provider> <native-id> [--json]   # turns and sent/downloaded files
uibridge export <provider> <native-id> [--files] [--output=path] [--json]

uibridge doctor [provider]                  # Chrome, session, models, UI contracts
uibridge doctor <provider> --anon           # prove signed-OUT is detected (throwaway profile)
uibridge autostart [--remove|--status]      # run uibridge at logon (Windows task)
uibridge capture <provider> ["prompt"] [--continue]   # record DOM + network for one exchange
uibridge recon observe <url>                # map an unknown site: DOM vocabulary + network
uibridge recon exchange <url> ...           # drive one turn there and record the wire

npm test                                    # unit and local HTTP tests; no browser required
node test/acceptance.mjs <model> [case ...] # live end-to-end suite through the OpenAI SDK
```

An unrecognised option is an error, not something to ignore: `--out` on a
command whose flag is `--output=` used to write to the default path and say
nothing, and in `ask` it was swept into the prompt and sent to the model.

### The CLI is a client of the API

There is one implementation, not two. Every command that needs a browser goes
over HTTP to the running uibridge:

| command | endpoint |
|---|---|
| `ask`, `chat` | `POST /v1/chat/completions` |
| `export` | `POST /v1/threads/export` |
| `status` | `POST /v1/session` |
| `models` | `GET /v1/models` |
| `threads`, `thread` | `POST /v1/threads/list`, `POST /v1/threads/events` |
| `request status\|recover\|cancel` | `GET,POST /v1/requests/*` |

`--local` drives a browser in the CLI process instead, for debugging the
browser layer itself. Three commands are deliberately local because they are
not API operations: `login` and `logout` need a **visible window a human types
into**, and `doctor` has to be able to diagnose a daemon that will not start.

This is not tidiness. Only one process may drive a Chrome profile, and
`status` used to open its own Session: a leftover Chrome from one such run
held the debugging port, and every later request failed with a 45-second
"Chrome never opened a debugging port". `uibridge status` is now answered by
the daemon's already-warm browser.

### One browser, not one per command

Every command that needs a browser (`ask`, `chat`, `export`) talks to a
running uibridge, starting one in the background if none is listening. This
is not a nicety: only one process may drive a given Chrome profile, so a
command run while `serve` was up used to fail on a composer that belonged to
the other process - and a cold start costs about 40 s of Chrome and site
boot before any prompt is sent.

Measured on the same command and thread: a warm ChatGPT continuation is
**4.4 s end to end, 0.4 s of it uibridge** (phase timing: auth 0.2 s, thread
0.0 s, notices 0.1 s, submit 1.4 s, model 2.6 s). The first turn after a
daemon starts costs ~25 s, almost all of it Chrome and the site booting
(auth 11.9 s, thread load 11.1 s) - which is why `uibridge stop` after a
code change makes the next command look slow.

`--local` forces the old in-process path for debugging the browser layer.
A running daemon keeps running the code it started with; `uibridge stop`
after editing, or the next command reuses the old build. Its log is
`.uibridge/daemon.log`.

## What comes back

The response envelope follows Chat Completions for the supported subset.
Everything provider-specific sits under `_uibridge`, and it is there to be
honest about what happened rather than to look tidy:

The complete set, from a real response:

```json
"_uibridge": {
  "provider": "gemini", "request_id": "j0vc13gd4", "thread_id": "67a49e3d6ee75736",
  "input": { "characters": 26, "sha256": "dd28...", "transport": "composer" },
  "ledger": { "path": ".uibridge/threads/gemini/67a49e3d6ee75736.jsonl" },
  "elapsed_ms": 10640,
  "provenance": {
    "model": { "requested": "gemini-pro", "applied": "...Pro Extended", "verified": true, "note": "already active" },
    "modes": {}, "final_state": "...Pro Extended"
  },
  "extraction": "copy", "extraction_warning": null, "markdown": true, "lossy_math": false,
  "provider_error": false, "provider_error_suspected": false, "provider_error_match": null,
  "tables": [], "code_blocks": [], "files": [], "json": null,
  "browsed": false, "searched": false, "sources": [], "citations": [],
  "truncated": false, "throttle_notice": null
}
```

| field | why it exists |
|---|---|
| `provider`, `request_id`, `elapsed_ms` | Which provider answered, the id this run is logged under, and how long it took end to end. |
| `input.characters`, `input.sha256`, `input.transport` | Exactly what was sent, hashed, and *how*: `composer` (typed) or `attachment` (too large to type, so carried as a temporary UTF-8 file). A prompt that took the attachment path is a different experiment from one that did not. |
| `ledger.path` | Local JSONL audit file for this native thread. |
| `provenance.model.requested` / `.note` | What you asked for, and why the verdict is what it is (`already active`, `unknown model`, ...). |
| `provenance.modes` | Per-mode outcome (e.g. thinking) in the same shape as the model verdict. |
| `provider_error_suspected`, `provider_error_match` | See *Answer integrity* below: a flag for an answer that opens like a failure but matches no measured wording, and the pattern that produced a positive verdict. |
| `searched` | The UI's search affordance was used, as distinct from `browsed`. |
| `json` | The parsed object when a `response_format` was requested and validated; `null` otherwise. |
| `extraction_warning` | Set when the tier that produced the text is weaker than the one that was expected. |
| `provenance.model.applied` / `.verified` | Selection is read back from the UI and, where possible, checked against the response wire. `strictModel: true` (default) makes failed verification an error. Setting it to false permits unverified results, explicitly marked here. |
| `thread_id` | The provider's native thread UUID from its URL. Pass it as top-level `thread_id` to continue that thread; omit it for a fresh isolated thread. |
| `provenance.final_state` | The picker label read *after* model and modes were both applied. The per-step labels are stale by then. |
| `extraction` | Which tier produced the text: `wire` (the response body the page received — the model's own markdown, ChatGPT), `copy` (the provider's own markdown via its copy control), `dom-markdown` (rebuilt from elements — tables, fences and lists intact), or `rendered` (innerText, structure lost). |
| `provenance.answered_by`, `provenance.sent_as` | Wire only. The slug the *server* says answered, and the model the page put in its own request. When a model was requested, `provenance.model.verified` is re-checked against `answered_by`, which outranks any picker label. |
| `citations` | Wire only. Each inline citation with `at`, the character offset in the content where the claim it supports is made, plus `url`, `title`, `site`, `snippet`. `sources` is everything the turn consulted; `citations` is what the answer leans on. |
| `throttle_notice` | The site's own "too many requests" text when it was showing. On ChatGPT that lock only blocks *previous* conversations; the request still went through. A batch seeing it should slow down. |
| `truncated` | `true` when the stream ended before the site said it was done. The text is whatever arrived. |
| `markdown` | `true` for either markdown tier. |
| `lossy_math` | `true` when maths was rendered but its source is not in the DOM, so the formula is glyphs rather than LaTeX. Never passed off as source. |
| `tables`, `code_blocks` | Parsed from that markdown, so a pipeline gets rows and source instead of a string to re-parse. |
| `files` | Files the provider *generated*, downloaded to `downloads/`, with small text payloads inlined. |
| `ledger` | Local JSONL audit path for this native thread. It stores file paths, sizes and SHA-256 hashes—not prompt/answer text or credentials. |
| `browsed`, `sources` | What the UI actually did. Providers routinely answer from their weights despite being told to search. |
| `provider_error` | Retained in Session/CLI results; the HTTP API rejects recognised provider error notices with 502. Detection depends on observed provider wording and cannot recognise every possible non-answer. |
| `usage` | Always zero. Token counts are not observable through a UI, and inventing them would be worse than admitting it. |

### Answer integrity

These sites render their OWN failures as an ordinary assistant message.
"Sorry, something went wrong. Please try your request again." arrives as a
normal turn: 59 characters, markdown, indistinguishable in structure from a
real reply. Extraction returns it happily, and in a batch that silently poisons
rows — an apology recorded as evidence.

There is no structural marker to key on; measured, an errored turn is an
ordinary response element with an ordinary paragraph. Text is the only signal
the UI gives, so uibridge matches measured wordings and reports the verdict
rather than hiding it:

- `provider_error` — the answer matched a **measured** failure wording. The
  request becomes a typed, retryable error instead of a 200.
- `provider_error_suspected` — it opens like a failure (an apology, a refusal
  to continue) but matches nothing known. This is a **flag, not a verdict**:
  the text still comes back, because a terse refusal can be legitimate content.
- `provider_error_match` — which pattern produced a positive verdict, so a
  false positive can be traced to the rule that caused it.

Three settings control it, all under `provider` in `config.json`:

| setting | default | what it does |
|---|---|---|
| `errorTextExtra` | `[]` | Extra failure wordings, as regex source strings. A provider can change its error text at any time and you will meet the new one before this project does; adding it here needs no code change. |
| `failOnSuspectedProviderError` | `false` | Promote a *suspected* failure to a 502 instead of a flag. Off by default; turn it on for pipelines that would rather lose a row than record a bad one. |
| `errorNoticeMaxChars` | `400` | Longer text that merely *contains* an apology is an answer, not a failure notice. |

Anything not on the list is reported as suspected rather than guessed at. The
mechanism lives in `src/core/answer-integrity.mjs`.

### Exporting a whole thread

`uibridge export <provider> <native-id>` (or `POST /v1/threads/export` with
`{"provider", "thread_id", "files"}`) returns every message on the thread's
active branch, in order, with `attachments` naming files that were **sent**
and `file_controls` naming files the thread **generated**. `--files` (or
`"files": true`) also retrieves those generated files, scrolling each
message back into view to reach its download control.

With `--files`, the retrieved files are an array on `files` - each entry
naming the file, its local `path`, `bytes` and `mime`, or an `error` if that
one could not be fetched. A provider with no measured download control says so
once in `files_skipped` rather than pretending the thread had none.

`source` says where the bytes came from, because retrieving a file from a
thread the browser has merely reloaded is not the same mechanism as receiving
one as it is generated. `wire` means the page fetched the file and uibridge
read the response, which is what happens at generation time and carries the
server's own name and MIME type. `browser` means the message's link no longer
fetches anything and only opens the file preview panel, so the download was
taken from that panel and arrived as an ordinary browser download - the bytes
are byte-exact either way, but `mime` is null, since the metadata response
that names the type is never fetched on that path. Both are measured; see
`docs/UI-RECON.md`.

These chat UIs virtualize their history: on a 34-message thread only six
messages exist in the document at any moment, so an export is a walk, and
`evidence` says how well that walk went rather than asking you to trust it:

| field | meaning |
|---|---|
| `reached_top`, `reached_bottom` | Both ends were actually observed. History arrives while scrolling, so the top is confirmed by two quiet passes, not by one jump to zero. |
| `message_count`, `ordered_count` | Messages found, and messages the walk could place. A message that was seen but never placed is still exported, flagged `order_unknown`. |
| `stable_ids` | Identity came from the provider's own message ids. When false, identity was inferred from content and two identical messages collapse into one. |
| `readings`, `order_verified` | Each reading sees a contiguous slice of the thread in document order. `order_verified` means the assembled order contradicts none of them. False means the transcript is not faithful — and it says so instead of pretending. |
| `branch_pager`, `branched_messages`, `branches_walked` | Whether the provider has a calibrated control for sibling versions (regenerated answers, edited questions), how many messages have them, and whether they were visited. `branch_pager: false` means the question was never asked — which is not the same as "there are none". |
| `mounted_at_end` | How many messages the page was holding when the walk finished. Far below `message_count` is the virtualization being handled. |
| `first_turn`, `last_turn`, `turn_gaps` | The provider's OWN turn numbers, when it publishes them. This is the only evidence that says whether the DOM ever showed the *start* of the thread — scrolling to the top of a pane that never held the first message proves nothing. `first_turn: null` means the provider publishes no numbering, so the question could not be asked. |

`complete` is true only when both ends were reached, every message was
placed, the order verified, and — where the provider numbers its turns — those
numbers start at 1 with no gaps.

That last clause exists because of a measured failure. Reloading a six-message
ChatGPT thread mounted turns 2 through 6 and never mounted turn 1, through 20
seconds of sampling and an explicit scroll to the top of every scrollable
ancestor. The thread had 123px of scroll overflow, so `reached_top` and
`reached_bottom` were both perfectly true — and the export would have described
itself as the whole thread while missing the user's opening message. Scroll
evidence answers "did the walk reach both ends of what the DOM was showing"; it
cannot answer "was the DOM showing everything".

### Errors

An error is something that stopped a message from being retrieved. A message
that *was* retrieved always comes back as 200, even when the provider used it
to say it failed - that is reported in `_uibridge.provider_error` instead.

Every error carries `{ error: { message, type, retryable, detail? } }`, where
`type` is one of the codes below. They exist so a caller can branch instead of
matching prose:

Every error response also carries an **`x-should-retry`** header, `true` or
`false`, matching the `retryable` field in the body. Both official OpenAI SDKs
retry 5xx twice by default and both honour that header. It exists because a
wasted retry against a hosted API costs a fraction of a cent, while here it
drives a browser: measured, one `client.chat.completions.create()` that hit a
502 reached the provider three times, and on a real site each of those is
another message typed into your own conversation and another turn off your
subscription. A failure that already reached the site is never marked
retryable.

| status | code | meaning |
|---|---|---|
| 400 | `invalid_request` | Your request: unknown model, missing file, empty messages, a config key this build does not have. |
| 401 | `signed_out` | Run `uibridge login <provider>`. Carries the evidence that led to the verdict. |
| 403 | `cross_origin_refused` | The request carried an `Origin` header from something other than this machine, so it came from a web page rather than a program. uibridge does not serve web pages. |
| 404 | `thread_unknown` | No local ledger for that thread on this machine. |
| 404 | `not_found` | No such route. |
| 404 | `model_not_found` | `GET /v1/models/{id}` for a model this build does not serve. |
| 404 | `request_not_found` | No durable record for that Idempotency-Key. |
| 409 | `idempotency_conflict` | That key was used for a *different* request. |
| 409 | `outcome_unknown` | The key has an unfinished record: the provider outcome is genuinely unknown. Inspect the conversation before reusing it. |
| 409 | `daemon_other_home` | The uibridge holding the port serves a different state directory. |
| 429 | `rate_limited` | The site answered an actual HTTP 429. `retryable`, after a wait. |
| 503 | `notice_blocking` | One of the site's own modals kept covering a control and returning after each dismissal. ChatGPT's "too many requests" notice is one of these: it restricts access to *previous conversations*, not sending, so a retry usually succeeds. |
| 499 | `request_cancelled` | Cancelled by the caller. |
| 501 | `not_calibrated` | The provider has no measured contract for what you asked (e.g. thread export). |
| 502 | `ui_contract` | A selector we depend on matches nothing: the UI changed. |
| 502 | `model_unverified`, `model_not_applied`, `mode_not_applied` | The model or mode could not be confirmed from the UI. Under `strictModel: false` the first becomes a flag instead. |
| 502 | `submit_failed`, `submit_uncertain`, `compose_failed` | The prompt did not go out, or it is not certain that it did. |
| 502 | `thread_mismatch`, `thread_unidentified` | The page is not on the thread we asked for, or will not say which thread it is on. |
| 502 | `upload_failed` | The site refused an attachment. |
| 502 | `upstream_refused` | The site answered the page's own conversation request with an HTTP error that carried no stream. Distinct from `rate_limited`, which is specifically a 429. |
| 502 | `empty_response` | The turn completed and the provider produced no answer text at all. |
| 502 | `download_identifier`, `download_artifact_missing`, `download_cancelled`, `download_save_failed`, `download_failed` | A generated file could not be retrieved. `download_save_failed` means the browser finished the download but the bytes could not be written to disk; `download_failed` is the fallback on a file record whose retrieval failed with no more specific cause. |
| 502 | `non_monotonic_stream` | The stream contradicted itself; the text is not trustworthy. |
| 503 | `challenge` | A verification challenge is up. uibridge never solves or evades one: clear it in the browser window. |
| 503 | `network`, `network_blocked`, `browser_gone` | This machine could not reach the site, was blocked by a local proxy/certificate policy, or lost the browser. Only the first and last are `retryable`. |
| 503 | `thread_unavailable`, `thread_history_unavailable` | The thread would not open, or its history would not load. |
| 503 | `browser_unavailable`, `pool_closed`, `session_closed`, `shutting_down`, `queue_full`, `request_store_unavailable` | uibridge itself is not in a position to serve this right now. |
| 503 | `daemon_not_running`, `daemon_start_failed`, `daemon_incompatible` | CLI-side: no daemon, it would not start, or the port belongs to another build. |
| 504 | `timeout`, `request_timeout` | A wait exceeded its budget. |
| 504 | `composer_unavailable` | The prompt box never became usable. The message names the page and any notice that was covering it. |
| 504 | `upload_not_registered` | The file never reached the page. Nothing was sent. |
| 504 | `upload_slow` | The file is attached and the site is still uploading it. |
| 500 | `internal`, `chrome_missing`, `port_in_use`, `client_disconnected`, `not_implemented`, `bridge_error` | Local environment, or a bug in here. An unrecognised internal error stays a 500 on purpose rather than being dressed up as something familiar. |

## Architecture

```
src/core/         provider-agnostic: chrome lifecycle, tab pool, config,
                  typed errors, async primitives, markdown parsing
src/providers/    contract.mjs   the seam every provider implements
                  dom-provider.mjs  the generic request flow, written once
                  gemini/        selectors.json + its quirks (DOM extraction)
                  chatgpt/       selectors.json + its two-axis picker (wire extraction)
src/transports/   extraction as a swappable concern:
                  wire.mjs          a CDP tap on the response the page receives
                  sse-openai.mjs    decoder for ChatGPT's delta stream
                  dom.mjs           copy button, files, completion signals
                  markdown-dom.mjs  structured fallback when copy is dead
src/api/          OpenAI mapping, separate from HTTP handling
src/tools/        recon: map an unknown site's DOM and network; anoncheck
bin/uibridge.mjs  CLI
```

Two things vary independently, and keeping them apart is the point:

- **Actuation** — driving the UI: type, submit, pick a model, attach a file.
- **Extraction** — reading the answer back. A *transport*.

The goal never changes even when the provider does, so nothing above
`src/providers/` knows a provider exists. Adding one is a `selectors.json`
plus one line in `registry.mjs`; the request flow, completion detection,
uploads, citations and file retrieval are all inherited.

### Adding a provider

```bash
node bin/uibridge.mjs login chatgpt
node bin/uibridge.mjs capture chatgpt      # writes DOM + network under testdata/capture/
node bin/uibridge.mjs capture chatgpt --continue "follow-up"  # reuse the open thread during calibration
```

Fill in `src/providers/<id>/selectors.json` from that capture and set
`calibrated: true`. Until then the provider refuses to run — deliberately.
Placeholder selectors that *look* plausible are worse than none: they fail
somewhere else entirely, as a timeout, and you go hunting in the wrong place.

## What was learned the hard way

Each of these is in the code as a comment next to the thing it explains.
They are recorded because every one of them cost hours, and all of them look
like something else when they fail:

- **Attach over CDP, don't `launchPersistentContext`.** Chrome on Windows
  re-execs itself at startup; Playwright decides the browser died while an
  orphaned Chrome keeps holding the profile lock.
- **`innerText` is lossy.** KaTeX keeps no `<annotation>` and no
  `data-latex`, so rendered maths cannot be recovered from the DOM at all.
  The message *Copy* button returns canonical markdown. Compare:
  `t ^ 2 = C Q−(k−1)` against `$\hat{\tau}^2 = \frac{Q-(k-1)}{C}$`.
- **The clipboard is one buffer for the whole machine**, and it can fail on
  its own. Two tabs copying at once read each other's answer (hence a
  process-wide mutex); it needs a *focused* document, so a pooled background
  tab must be fronted; and Windows can stop serving clipboard requests
  entirely — observed here, with every write reporting success, every read
  returning empty, and PowerShell's own `Get-Clipboard` failing at the same
  moment. That is why extraction has three tiers rather than two: a
  clipboard outage must not silently turn every table into tab-separated
  text.
- **A generated file is not a link.** There is no `<a download>` and no
  `blob:` href anywhere. The bytes sit behind *Open*, which opens a viewer
  overlay whose toolbar is `div[role=button]` — so
  `button[aria-label*=Download]` only ever matches the code block's *Download
  code*. This is exactly how a real generated CSV gets mistaken for "just a
  code block".
- **Synthetic `DragEvent`s are ignored.** Tested against nine different
  targets: zero attachments every time. CDP's `Input.dispatchDragEvent` is a
  trusted event and takes file paths.
- **Upload readiness is not the send button.** It stays enabled throughout,
  so keying off it sends the prompt before the file lands and the model
  answers about a file it never received.
- **`isVisible()` must not be given a timeout.** It is an immediate state
  read; with a timeout, a busy page makes it throw, and a catch that answers
  "not generating" truncates the answer mid-stream.
- **`count()` does not auto-wait.** Reading it the instant a page renders
  reports zero for controls that are merely a few frames late — which
  misreads a timing race as "the UI changed".
- **CRLF.** The clipboard returns `\r\n` on Windows, so a newline-anchored
  fence pattern silently matches nothing and a perfectly good code block
  reads as absent.
- **A provider renders its own failures as an ordinary message.** "Sorry,
  something went wrong" arrives as a short, valid-looking answer. It is
  delivered, because retrieving it is a success by this layer's definition,
  but flagged as `provider_error` so a batch can tell it apart from a real
  short answer without matching on prose.
- **The active model's menu option is `aria-disabled`.** Clicking it can
  never succeed, so a picker label read too early (before it rendered) leads
  straight into a 10s click timeout trying to select the model that was
  already selected.
- **A rendered composer does not mean signed in.** An anonymous session shows
  one too, and every request then runs against no account.
- **`sources-list` is in every response**, so it cannot be the browsing
  signal; `source-inline-chip` is, and the real URLs live behind *… → View
  sources*.
- **`.contains-extensions-response`** marks responses where the provider's
  code/file tool ran. Gating file lookup on it means ordinary answers pay
  nothing.
- **A click can be accepted and ignored.** Playwright reporting a successful
  click is not evidence the app handled it: during the re-render after a
  modal closes, the first click reaches a node with no handler yet. Four
  download runs were blamed on the file endpoints before the truth showed up
  in a list of the page's actual requests. Success is now judged by the page
  *issuing the request*, and the click repeated until it does.
- **Layout panels intercept clicks.** A link at the bottom of a thread sits
  under the sticky composer, and `data-side-pane-shell-host` covers the
  message area, so a coordinate click lands on the wrong element. The target
  is centred first and, if still covered, the click is dispatched on the
  element itself.
- **A rate-limit modal reappears.** While the lock is active every
  conversations poll returns 429 and raises the notice again, so dismissing
  it once per request is a race. It is dismissed immediately before each
  click that matters.
- **Downloads may never touch the download manager.** With Chrome's download
  behaviour set to a directory: zero download events, empty directory. The
  bytes existed only in the response the page received.

### Why not read the network instead of the DOM?

It was the first thing to try, and it is the right instinct — a structured
payload beats scraping pixels. For Gemini it does not currently work:
generation never appears in page-level CDP traffic (checked three ways,
including `Network.streamResourceContent` and collecting still-in-flight
requests), there is no service worker, and the visible RPCs are obfuscated
positional arrays behind an `at` token.

So extraction is a *transport* rather than something baked in. For ChatGPT
the stream *is* readable — `POST /backend-api/f/conversation` answers with
an event stream in a compact delta encoding — and `src/transports/wire.mjs`
taps it with CDP (`Network.streamResourceContent`, subscribed at
`responseReceived` or the body is gone). The page still does the sending,
with its own anti-bot tokens; nothing is forged or replayed. `uibridge recon`
is how that was found: point it at a URL and it maps the DOM vocabulary and
every request, flagging which payload holds the answer.

## Status

Live suite as it stood when this was recorded (the suite has changed shape
since; `npm run certify` is the current one), run against Gemini with the
system clipboard broken — so the `dom-markdown` tier was doing the work
throughout:

```
17/18   markdown extraction (28 pipes), maths correctly flagged lossy,
        table parsed to rows, python fence with language,
        generated CSV retrieved to disk (436 bytes, real header),
        csv / pdf / both uploads registered,
        thinking toggle verified in the picker,
        citations reported truthfully (no sources claimed when none shown),
        6 concurrent tabs isolated, 0 leakage, 4.3x speedup,
        bad attachment rejected in 0.02s, empty messages 400
```

The one failure was Gemini refusing a model switch (`gemini-pro` requested,
UI stayed on Flash-Lite). The bridge reported it correctly rather than
attributing the answer to Pro. It is now retried, and `strictModel` can turn
it into an error.

That was read at the time as a Gemini-side bug. A later hand survey
(`docs/UI-RECON.md`) measured a likelier cause: Gemini's menus mount into a
body-level `cdk-overlay-container` and can take seconds to attach, so a
picker queried too early looks like a picker that refused. The retry is the
right fix either way, but the diagnosis has moved.

### What works today

**Gemini.** Signed in as you, one conversation per request: send a
prompt, attach files accepted by the UI, pick `gemini-flash` / `gemini-flash-lite` /
`gemini-pro`, toggle extended thinking, get markdown back with tables and
code parsed, any file it generated already on disk, and its citations when
it actually searched. That is the whole working surface.

**ChatGPT works, streams, and reads its answer off the network.** Signed in as you,
one conversation per request: send a prompt, attach files accepted by the UI
(each upload is confirmed on the wire before the prompt goes out), pick
`chatgpt-5.6-instant` / `-medium` / `-high` or the `chatgpt-5.5-*` family,
and get the model's own markdown back with the server's model slug in
`provenance.answered_by`, its sources, and each citation tied to the
character offset it supports. The UI is only used to type, click and set the
picker; nothing is scraped, so translations and class names cannot break
extraction.

**Files ChatGPT generates come back too.** Its Python environment is the
reliable one, so this is how a table of extracted data leaves the chat: ask
for a generated file, and its bytes land in `downloads/` named by the
server, byte-exact. Chrome never writes the file itself - the page fetches
it and keeps it in memory - so the bridge keeps the response the page
received. Code-interpreter files only; canvas documents and generated
images use other endpoints and are not retrieved yet.

## Notes

- `.profiles/` holds your live session cookie. It is gitignored because it is
  as sensitive as a password. This tool never sees or types your credentials —
  sign-in is you, in a visible window.
- Verification challenges are yours to clear. The bridge detects one and
  fails with `503 challenge`; it does not attempt to solve or evade it.
- Concurrency is per provider (`config.json` → `provider.concurrency`, default
  2). Every request opens a fresh conversation, so requests cannot see each
  other's context.
- **Requests are paced.** `minIntervalMs` (ChatGPT 20s, Gemini 8s, per
  provider in `config.json`) is the minimum spacing between request starts
  across all of a provider's tabs. A burst of fresh conversations — a dozen
  in fifteen minutes during calibration — tripped ChatGPT's throttling, and
  a batch is exactly the caller that would burst. Raise it for long runs;
  never lower it to speed a batch up.
- Generation waits are condition-driven. A short 600 ms post-modal pause
  allows the page to rerender; thread export uses small stabilization samples
  while walking virtualized nodes. ChatGPT continuations never wait for old
  DOM history; DOM-only providers get an 8-second baseline budget.
