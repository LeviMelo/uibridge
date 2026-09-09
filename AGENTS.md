# Working on uibridge

Read this before changing anything. It exists because the single most
expensive failure mode in this project's history has not been a bug — it has
been a capable model deciding, on its own, that uibridge is something it is
not, and spending days building the wrong thing.

## What uibridge is

A local, OpenAI-compatible HTTP API backed by chat UIs the user already pays
for. A real browser, signed in as the user, does what their hands would do:
type a prompt, attach a file, wait for the answer, read it back out of the
page. The answer is returned as an OpenAI `chat.completion`.

**uibridge is a transport.** Its entire job is to move bytes faithfully
between a program and a chat UI, and to describe honestly what happened on
the way. That is the whole product.

## What uibridge is NOT

Not negotiable, not context-dependent, not "unless it would be useful here."

### It is not a model benchmarker, evaluator, or test harness for models

**Never write code, tests, scripts or documents that measure the QUALITY of
the models uibridge calls.** Not accuracy. Not reasoning. Not classification
performance, macro-F1, PubMedQA, MMLU, "can it answer a scientific query",
"which provider is better at X", or a leaderboard of any kind.

Why, concretely:

- **The models are frontier models.** Their capability is not in question and
  is not affected by one line of code in this repository. Measuring it here
  tells you nothing about uibridge.
- **Every such measurement spends the user's paid subscription** — the exact
  resource this project exists to conserve — to produce a number that nobody
  working on this project can act on.
- **It has already happened, repeatedly.** Previous agents built
  `test/scientific.mjs`, `test/support/biomedical.mjs`, a `live.py` grader and
  an `ASSESSMENT.md` model leaderboard. All of it was deleted. If you find
  yourself writing a prompt whose answer you intend to grade for correctness,
  you have made this mistake.

If you catch yourself reasoning "but a quick sanity check that the model
understands the task would help" — no. That is the same mistake wearing a
smaller hat. The bridge is correct if the bytes arrived and the envelope is
honest, whatever the model then said.

### It is not an editor of what the model said

Never write logic that rewrites, cleans up, reformats, summarises, truncates,
"fixes" or otherwise improves an answer. `text` is what the provider produced,
carried through unchanged. If you find yourself reaching for a regex to tidy
an answer, stop: you are corrupting the record the caller will cite.

Three things are allowed, and they are not exceptions to this rule:

1. **Choosing the best SOURCE for the same text.** `extraction` names it -
   `wire` (the server's own markdown), `copy` (the site's own copy button),
   `dom-markdown` (rebuilt from the rendered DOM, and only when neither of the
   other two is available). The last one is a reconstruction, which is why it
   says so, and why `lossy_math` and `extraction_warning` exist. Never let a
   reconstruction be reported as if it were the original.
2. **Parsing the text into extra fields** - `tables`, `code_blocks`,
   `citations` - which are derived alongside `text`, never instead of it, and
   never by modifying it.
3. **Labelling** - `provider_error`, `truncated`, `throttle_notice`. A label
   describes the answer; it does not change it.
4. **Removing the site's own invisible markers.** ChatGPT interleaves citation
   anchors into its stream as Private Use Area codepoints - characters that
   are not the model's prose and that would otherwise land in the record as
   invisible garbage. `stripMarkers` removes exactly those and returns their
   offsets, which become `citations`. This is the ONLY sanctioned removal, it
   is limited to that measured codepoint range, and it must never grow into
   "tidying up" anything a reader could actually see.

Anything beyond those four is out of scope.

### It is not a scraper, a botnet, or an anti-bot bypass

Never forge, replay or synthesise anti-bot or sentinel tokens. Never lift the
site's bearer token out of the session to call its endpoints directly — **the
page sends, we read.** Never solve or evade a verification challenge: detect
it and stop (`503 challenge`). Never remove pacing to go faster; the pacing
exists because that boundary was crossed once already.

### It is not a credential manager

Never see, type, store or handle the user's password. Signing in is a human
action in a visible browser window (`uibridge login <provider>`), and the
session lives in the Chrome profile. `/api/auth/session` payloads are never
retained — presence only, never an email in a log or an error body. Cookie
names and lengths may be read; values never.

### It is not "roughly OpenAI-shaped"

The compatibility claim is the product. If an official OpenAI SDK cannot call
it, it is broken. Parameters a chat UI has no knob for are accepted, ignored,
and **named back** in `_uibridge.unsupported_parameters` — never silently
swallowed. Parameters whose silent absence would corrupt a caller's logic
(`tools`, `n > 1`) are refused with a 400.

## Where things are written down

- `README.md` - for people using uibridge.
- `AGENTS.md` (this file) - the rules for changing it.
- `docs/UI-RECON.md` - **the two UIs as actually measured.** The first thing
  to read before touching a selectors file, and the thing to re-measure
  rather than trust if it looks stale.
- `docs/` - dated records: the original handover, and findings from live
  runs. When one turns out to be wrong, date the correction and leave the
  original claim visible. Quietly overwriting it destroys the only evidence
  that the question was ever settled.

## How to test this project

There are exactly two kinds of test here, and both are about transport.

**Offline (`npm test`)** — everything that is uibridge's own code: the
envelope, streaming frames, the error taxonomy, idempotency, CLI flags and
exit codes, config validation. Runs against the scripted stand-in provider
(`src/providers/echo`, enabled only by `UIBRIDGE_TEST_PROVIDER=1`). No
browser, no network, no subscription spent. **If a behaviour can be tested
here, it must be.**

**Live (`npm run test:acceptance`, `node test/certify.mjs`)** — the one thing
that cannot be tested any other way: that a real chat UI is driven correctly.

A live assertion may only be about transport and honesty. Legitimate:

- the exact bytes we sent are in the provider's own transcript — proved by
  **reading the user turn back out via thread export**, never by asking the
  model to repeat them;
- the tail of a long input survived the attachment transport;
- an attachment registered on the site; a generated file landed on disk with
  real bytes;
- the thread id is the provider's own and is stable across CLI, API, ledger;
- the envelope describes what actually happened (transport, truncation,
  provider error, model provenance);
- a failure is typed, and a failure that already reached the site is not
  retried into a duplicate message.

Prompts in live tests are deliberately trivial ("reply with the single word
OK") **precisely so the answer's content is never the thing under test.**

## Standing constraints

- **The CLI is a client of the API.** It must never grow its own inference,
  extraction or browser logic. One process per Chrome profile — two processes
  driving one profile is the bug the daemon exists to prevent.
- **Authentication is mandatory.** No anonymous or degraded mode.
- Use the providers' **native thread UUIDs**. Never invent an id.
- **Canvas is out of scope.** No file-format-specific logic.
- Selectors are **measured, not guessed.** If you are about to write a
  selector because it "looks right", open the page and read the DOM first.
  `docs/UI-RECON.md` is the survey of both UIs as they actually are — read it
  before touching a selectors file, and re-measure rather than trusting it if
  it looks stale. Note what it says about *scripting* a survey: a script only
  finds what its author already assumed, which is the same mistake one level
  up. Open the page yourself.
- Every error code must appear in the Errors table in `README.md`; a test
  enforces this.
- `.profiles/`, `downloads/`, `.uibridge/` and the `dom/`, `net/`,
  `downloads/`, `capture/` and `recon/` subfolders of `testdata/` are
  gitignored. **`testdata/` itself is NOT** - its root holds tracked
  fixtures. A DOM or recon dump therefore goes in a subfolder, never in
  the root, or it lands in a commit carrying conversation content and
  session tokens. Root-level scratch (`_anything`) is ignored too.

## Before you claim something works

Run it. `npm test` for the offline suite, and for anything touching a
provider, drive the real thing and show the output. "Should work" is not a
result. If a test fails, say so with the output; if a step was skipped, say
that.
