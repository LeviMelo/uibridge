# uibridge

A local, OpenAI-compatible HTTP API backed by chat UIs you already pay for.

It replaces moving CSVs and PDFs in and out of a chat window by hand. Your
pipeline calls `http://127.0.0.1:8477/v1/chat/completions`; a real browser,
signed in as you, does what your hands would have done, and the answer comes
back as JSON — with its tables parsed, its LaTeX intact, its citations
listed, and any file the provider generated already downloaded to disk.

No API keys. No per-token billing. No daily request cap beyond the one your
subscription already has.

```bash
npm install
node bin/uibridge.mjs login gemini    # sign in once, in a visible window
node bin/uibridge.mjs serve           # start the API
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

## Commands

```bash
node bin/uibridge.mjs serve                 # the API (default 127.0.0.1:8477)
node bin/uibridge.mjs login <provider>      # sign in; you type the password, never this tool
node bin/uibridge.mjs doctor [provider]     # Chrome, session, models, UI contracts
node bin/uibridge.mjs ask chatgpt "..."     # one prompt, no server
node bin/uibridge.mjs ask chatgpt --file=paper.pdf --model=chatgpt-5.6-high "..."
node bin/uibridge.mjs doctor chatgpt --anon # prove signed-OUT is detected (throwaway profile)
node bin/uibridge.mjs recon observe <url>   # map an unknown site: DOM vocabulary + network
npm test                                    # 49 unit tests, no browser, ~1s
python test/live.py                         # live UI-surface suite
```

## What comes back

The OpenAI envelope is standard, so existing clients work unchanged.
Everything provider-specific sits under `_uibridge`, and it is there to be
honest about what happened rather than to look tidy:

| field | why it exists |
|---|---|
| `provenance.model.applied` / `.verified` | Requested is not applied. Gemini genuinely drops model switches (its own bug), so the selection is retried and then read back from the UI. `verified: false` means the UI is on something else — `applied` names what. For a systematic review this is the audit trail; set `strictModel: true` in config to make a mismatch an error instead. |
| `provenance.final_state` | The picker label read *after* model and modes were both applied. The per-step labels are stale by then. |
| `extraction` | Which tier produced the text: `wire` (the response body the page received — the model's own markdown, ChatGPT), `copy` (the provider's own markdown via its copy control), `dom-markdown` (rebuilt from elements — tables, fences and lists intact), or `rendered` (innerText, structure lost). |
| `provenance.answered_by`, `provenance.sent_as` | Wire only. The slug the *server* says answered, and the model the page put in its own request. When a model was requested, `provenance.model.verified` is re-checked against `answered_by`, which outranks any picker label. |
| `citations` | Wire only. Each inline citation with `at`, the character offset in the content where the claim it supports is made, plus `url`, `title`, `site`, `snippet`. `sources` is everything the turn consulted; `citations` is what the answer leans on. |
| `truncated` | `true` when the stream ended before the site said it was done. The text is whatever arrived. |
| `markdown` | `true` for either markdown tier. |
| `lossy_math` | `true` when maths was rendered but its source is not in the DOM, so the formula is glyphs rather than LaTeX. Never passed off as source. |
| `tables`, `code_blocks` | Parsed from that markdown, so a pipeline gets rows and source instead of a string to re-parse. |
| `files` | Files the provider *generated*, downloaded to `downloads/`, with small text payloads inlined. |
| `browsed`, `sources` | What the UI actually did. Providers routinely answer from their weights despite being told to search. |
| `provider_error` | `true` when the delivered text is the provider's own error notice ("Sorry, something went wrong") rather than an answer. Still a 200, still real content: the UI produced a message and this retrieved it, which is all the bridge promises. Retry-or-skip is your policy, and this flag means you needn't match on prose. |
| `usage` | Always zero. Token counts are not observable through a UI, and inventing them would be worse than admitting it. |

Errors are typed, so a caller can branch: `401 signed_out`, `503 challenge`,
`400 invalid_request`, `502 ui_contract` (the UI changed), `504 timeout`,
`501 not_calibrated`. An error is something that stopped a message from being
retrieved. A message that *was* retrieved always comes back as a 200, even
when the provider used it to say it failed.

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

Live suite, run against Gemini with the system clipboard broken — so the
`dom-markdown` tier was doing the work throughout:

```
17/18   markdown extraction (28 pipes), maths correctly flagged lossy,
        table parsed to rows, python fence with language,
        generated CSV retrieved to disk (436 bytes, real header),
        csv / pdf / both uploads registered,
        thinking toggle verified in the picker,
        citations reported truthfully (no sources claimed when none shown),
        6 concurrent tabs isolated, 0 leakage, 4.3x speedup,
        bad attachment rejected in 0.02s, empty messages 400, unknown model 200
```

The one failure was Gemini refusing a model switch (`gemini-pro` requested,
UI stayed on Flash-Lite). That is Gemini's bug; the bridge reported it
correctly rather than attributing the answer to Pro. It is now retried, and
`strictModel` can turn it into an error.

### What works today

**Gemini only.** Signed in as you, one conversation per request: send a
prompt, attach CSVs and PDFs, pick `gemini-flash` / `gemini-flash-lite` /
`gemini-pro`, toggle extended thinking, get markdown back with tables and
code parsed, any file it generated already on disk, and its citations when
it actually searched. That is the whole working surface.

**ChatGPT works, and reads its answer off the network.** Signed in as you,
one conversation per request: send a prompt, attach PDFs and CSVs (the
upload is confirmed on the wire before the prompt goes out), pick
`chatgpt-5.6-instant` / `-medium` / `-high` or the `chatgpt-5.5-*` family,
and get the model's own markdown back with the server's model slug in
`provenance.answered_by`, its sources, and each citation tied to the
character offset it supports. The UI is only used to type, click and set the
picker; nothing is scraped, so translations and class names cannot break
extraction. Files ChatGPT itself generates are not retrieved yet.

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
- There are no fixed sleeps in the request path. Every wait is a condition
  with a budget; "stopped changing" is a measurement, not padding.
