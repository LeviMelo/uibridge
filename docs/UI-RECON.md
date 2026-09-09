# The UI, as measured

**Surveyed 2026-09-09, by hand, in a signed-in browser.** Every statement here
was read off the live page or watched happening. Nothing was copied from
`selectors.json`; where this document and a selector disagree, this document
looked and the selector did not.

## Why this file exists

The expensive failures in this project were never hard bugs. They were
selectors written from a plausible mental model, shipped, and discovered wrong
by a production failure — after which someone guessed a new selector and
shipped that. `src/tools/capture.mjs` says it in its own header: *"the single
biggest waste in building this was working from assumptions about the page
instead of from the page."*

A first attempt at this survey was a **script** that walked both sites looking
for a composer and a submit control. It failed immediately and instructively:
its "find the composer" rule (the last `[contenteditable="true"]`) resolved to
`div.ql-clipboard`, Quill's permanently-offscreen paste buffer, and its
"submit" rule reported `could not submit: Enter did nothing and no send button
matched` — then kept capturing as though a turn had been sent. **A script can
only find what its author already assumed.** That is the same failure one level
up, so the survey below was done by looking.

That script is `tools/recon-ui.mjs`. It is kept, because its header is the
lesson and because nothing else produces the bulk `network.jsonl` /
`skeleton.html` / inventory dumps under `testdata/recon/ui-<provider>/`. Use
it to capture in bulk once you already know what you are looking at. Never
use it to find out.

## How to redo this

Open the site in a signed-in browser and read the DOM directly. Two harness
facts that cost time:

- **Screenshot pixels are not CSS pixels.** The viewport measured 1920×1065
  while screenshots came back in a 1512×795 frame — a factor of **0.7875**.
  Coordinates from `getBoundingClientRect()` must be multiplied by that factor
  before they can be clicked, and the factor changes when the window changes.
  Prefer clicking by element reference; reserve coordinates for when you must.
- **Menus are not where the control is.** See the overlay note under Gemini.

---

# Gemini

`https://gemini.google.com/app` · Angular · account language **English** ·
account tier Pro.

## Composer

| | |
|---|---|
| Real editor | `div.ql-editor[contenteditable="true"]`, `role="textbox"`, `aria-label="Enter a prompt for Gemini"` |
| Decoy | `div.ql-clipboard` — also `contenteditable="true"`, also `visibility: visible`, but 0×1px at `x = -99166` |
| Empty marker | class **`ql-blank`** is present when empty and removed when text is entered |
| Wrapper | `input-area-v2` (class `new-input-ui`) inside `input-container` |

`ql-blank` is the cheapest readiness signal on the page: it is a class toggle
on the element you already hold, not a text comparison.

## Sending — the send button does not exist at rest

Measured on an empty composer, the only buttons in `input-area-v2` are:

    Upload & tools · Open mode picker, currently Flash-Lite · Dictate (^⇧D)

**There is no send control in the DOM at all.** Typing one character adds a
fourth button, `aria-label="Send message"`. Any code that waits for the send
button *before* typing waits forever.

**Enter does not submit.** Verified directly: with text in the composer,
`Enter` left the text in place, the URL unchanged, and created no response
element. The button is the only path.

While generating, that same fourth slot becomes **`aria-label="Stop response"`**
— send and stop are the same position, swapped.

## The lifecycle of a turn, as timed

This is the part that matters most, because two intuitive completion rules are
both wrong.

| Observed | State |
|---|---|
| T+2s, T+6s after clicking send | `Stop response` present. `model-response` count **still 1** — the *previous* turn, still fully rendered |
| T+11s | second `model-response` appears, **empty**, gains class `has-thoughts` |
| T+21s | **no stop button**, and the response **still empty** |
| later | text lands |

Two traps fall out of it:

1. **"Read the last `model-response` after sending" returns the previous
   answer.** For seconds after send, the newest response element does not exist
   yet, so the last one is the prior turn — complete, plausible, and wrong.
   uibridge avoids this correctly: it snapshots the response texts *before*
   sending and picks the index that changed.
2. **"Stop button gone ⇒ finished" is false.** There is a window with no stop
   control and no text. uibridge avoids this too, and the ordering is the
   reason: it waits for the text to *stabilise and be usable* first, and only
   then consults the stop control. Reversing those two would return `""`.

## Anatomy of a completed turn

    div#<16-hex>.conversation-container
      user-query
        user-query-content > div.query-content
      model-response
        response-container
          structured-content-container.model-response-text.processing-state-visible
            message-content#message-content-id-r_<16-hex>
              div#model-response-message-contentr_<16-hex>.markdown.markdown-main-panel

- The `conversation-container` id and the `r_…` content id are **different
  16-hex values**; the URL thread id is a **third**.
- The thread URL is `/app/<16-hex>` — **not a UUID**.
- `model-response.innerText` begins **`"Gemini said"`**; `user-query.innerText`
  reads **`"You said X\n\nX"`** — a visually-hidden screen-reader label plus the
  prompt, duplicated. Extraction must scope to `message-content` / `.markdown`
  and prune `.cdk-visually-hidden`, which uibridge does.
- With a thinking model the container gains `has-thoughts` and a
  `thinking-overlay` element, but still exactly **one** `.markdown` — the
  thoughts do not add a second panel to confuse a first-match selector.
- `crust-task` is the **only shadow-root host in the page**. Nothing uibridge
  reads is inside it today; if response rendering ever moves in there,
  `querySelectorAll` goes blind and this is the place to look.

## Response actions

`message-actions` is present without hovering and holds:

    Good response · Bad response · Redo · Copy · Show more options

The selectors file documents this list as exactly four items; **`Redo` has been
added since it was written.** The selector itself is unaffected.

Note the user's own turn carries **`Copy prompt`**, which matches a naive
`[aria-label*="Copy"]` just as well as the response's `Copy` does. Scope to
`message-actions` / `copy-button`.

## Model / mode picker — rebuilt

Trigger: `button[aria-label="Open mode picker, currently <mode>"]`.

The menu is now **`gem-menu`** containing **`gem-menu-item[role="menuitem"]`**:

| Item text | |
|---|---|
| `3.5 Flash-Lite` — Fastest answers | selected: class `selected … active` |
| `3.8 Flash` — All-around help | |
| `3.1 Pro` — Advanced reasoning | |
| `Extended thinking` — Complex problem solving | a peer of the models, not a separate toggle |

- Items carry **no `aria-label`**, and **`aria-checked` / `aria-selected` are
  both `null`** — selection is expressed only as a **class**.
- Model names now carry version prefixes (`3.1 Pro`). Selecting `3.1 Pro`
  changes the trigger to `"Open mode picker, currently Pro"` — **verified
  live**, so the existing `match`/`verify` regexes (`\bPro\b`) still hold.

## Overlays — where menus actually live

Every menu mounts into **`div.cdk-overlay-container` appended to `<body>`**,
outside the composer subtree entirely. Two consequences, both measured:

- Scoping a menu query to `input-area-v2` finds **nothing**. My first pass
  reported zero menu items while ten were plainly on screen.
- The overlay is **not attached instantly**: a query 2s after the click found
  no items; the same query moments later found them. This is the most likely
  cause of the intermittent `modelPicker` failures — including the one that
  ended the last certification run — and it is a **timing** defect, not a
  selector one.

## Attachments — there is no file input

**`document.querySelectorAll('input[type=file]')` returns an empty list** on
Gemini, before and after opening the upload menu. `setInputFiles` cannot work
here; attachment must be a real drag. Both drop targets exist:
`file-drop-indicator` and `.xap-uploader-dropzone`. This matches
`attachStrategy: "cdp-drag"`.

The upload menu (from `Upload & tools`) contains, in order: `Upload files`,
`Add from Drive`, `More uploads ▸`, `Create image`, `Create video`,
`Create music`, `Canvas`, `Deep research`, `Guided learning`, `More tools ▸`.
`Upload files` is a `button[role="menuitem"]` with
`aria-label="Upload files. Documents, data, code files"`.

---

# ChatGPT

`https://chatgpt.com/` · React · account language **Portuguese (pt-BR)** —
note the same user is served **English on Gemini and Portuguese here**, which
is exactly why labels are matched bilingually and why identifiers are
preferred over labels wherever one exists.

## Composer

| | |
|---|---|
| Real editor | `div#prompt-textarea.ProseMirror[contenteditable="true"]`, placeholder `Pergunte ao ChatGPT` |
| Decoy | `textarea.wcDTda_fallbackTextarea` — a second, hidden candidate |
| Send | `button[data-testid="send-button"]`, `aria-label="Enviar prompt"` |
| Stop | `button[data-testid="stop-button"]` |
| Attach | `button[data-testid="composer-plus-btn"]` |

Same rule as Gemini: **`send-button` does not exist while the composer is
empty** — confirmed by typing and watching it appear. Keying on the `testid`
rather than the label is what keeps this working across the locale difference.

Unlike Gemini, ChatGPT **does** have file inputs — five, including one general
`multiple` input and `upload-media-input` / `upload-photos-input` restricted to
`image/*` and `image/*,video/*`.

## Messages

    [data-message-id="<uuid>"][data-message-author-role="user|assistant"]
                              [data-message-model-slug="gpt-5-6-thinking"]

wrapped by `[data-testid="conversation-turn-N"]`. Model provenance is readable
per assistant message. Numbering is **per message, not per pair**: six messages
are turns 1–6.

## The thread does not fully load — the important finding

Reloading a six-message thread and sampling the DOM every 150ms:

| Time | Mounted |
|---|---|
| 1 ms | 0 messages |
| 10,433 ms | **5 messages — turns 2, 3, 4, 5, 6** |
| through 20s | still 5. **Turn 1 never mounted.** |

Scrolling every scrollable ancestor to the top recovered nothing. The thread
had only **123px of scroll overflow**, so a scroll-based sweep reaches the top
immediately and legitimately — `reached_top` and `reached_bottom` are both
**true** — while the user's opening message is simply absent.

On an earlier visit the same thread *did* eventually reach six messages, so the
behaviour is lazy and unreliable rather than a permanent omission.

**This is a correctness hole, not a cosmetic one:** an export can return 5 of 6
messages and describe itself as complete. Scroll evidence answers "did the walk
reach both ends of what the DOM was showing"; it cannot answer "was the DOM
showing everything." Only the provider's own numbering can — and ChatGPT
publishes it in `data-testid`.

Fixed: `thread.export.ordinalNode` / `ordinalAttr` / `ordinalPattern` now feed
`sweepThread`, which accumulates every turn number seen across the whole walk
and refuses to call an export complete unless they start at 1 with no gaps. The
verdict is reported as `first_turn` / `last_turn` / `turn_gaps` in the export's
evidence, and `first_turn: null` honestly means "this provider publishes no
numbering", not "the thread starts where we think".

## Attachments, on a turn that carries one

The file renders as a **spreadsheet preview card**, not a small chip. The name
lives in:

    span.grow.items-center.truncate.font-semibold.capitalize

- `textContent` is **`"recon annex chatgpt"`** — the uploaded file was
  `recon_annex_chatgpt.csv`. **Underscores became spaces and the extension is
  gone.** `innerText` reads `"Recon Annex Chatgpt"` purely because of CSS
  `text-transform: capitalize`.
- **The original filename is not recoverable from the DOM.** An export label is
  the site's re-rendering, and must never be compared for equality against what
  was uploaded.
- The name is part of the user message's `innerText`
  (`"Recon Annex Chatgpt Reply with the single word BETA."`), so reading a user
  turn back to prove which bytes were sent must account for it.

## Generated files

    button.behavior-btn[aria-label="Download recon_out.csv"]

Exactly one `button.behavior-btn` in the thread, and it is that control —
matching `generatedFile.control`. There is **no `<a download>` and no `blob:`
href**, so scanning for download affordances finds nothing; the true filename
survives in the `aria-label`, unlike the attachment label above. A sibling card
shows `recon_out.csv` with a `library-file-icon` testid.

---

# Closed by measurement

## ChatGPT: retrospective download of a file already fetched once

**Opened 2026-09-09, closed the same day. The original claim is left standing
below the answer, because it was the evidence that framed the question.**

`export --files` retrieves a thread's generated files by clicking the message's
own `button.behavior-btn` and waiting for the content request
(`/backend-api/estuary/content`). Measured 2026-09-09:

| Case | Result |
|---|---|
| Live turn, at the moment the answer arrives | `diag_probe.csv`, 24 bytes, `source: wire` - **works** |
| Retrospective on that same thread, immediately | 3 clicks, **no request**, no file |
| Retrospective on that same thread, +75s | identical - so it is not "too soon" |
| Retrospective on an older thread whose file had never been downloaded in that browser session | **works**, `source: wire` |

The clicks produce **neither a network request nor a browser download** - the
`downloads/` directory gained no second copy. So the click is not silently
succeeding somewhere the wire tap cannot see; nothing happens at all.

### What the page actually does

Three instrumented runs, `Network.requestWillBeSent` and
`Browser.downloadWillBegin` both armed, DOM sampled before and after each
click. The hypothesis above was right about the panel and **wrong about the
cause** - the bytes are not missing because the browser already has them.

**The two paths are different mechanisms, not one flaky mechanism.**

| | At generation time | On a reloaded thread |
|---|---|---|
| Click on `button.behavior-btn` | page fetches `interpreter/download` then `estuary/content` | **no request at all** |
| Preview panel | opens | opens |
| Where the bytes are | the response body, read by the wire tap | nowhere yet |
| Chrome writes a file | no | - |

On the reloaded thread the click *only* opens the panel. Re-clicking - which is
what the old code did, three times - can only toggle that panel shut and open
again, which is exactly why it reported "the page never asked for the file".

The control that fetches is **inside the panel**:

```
[data-testid="artifact-preview-surface-shell"]
  button[data-testid="popcorn-zoom-select"]     100%
  button[aria-label="Baixar"]                   <- this one
  button[aria-label="Tela cheia"]               fullscreen
  button[data-testid="close-button"]            Fechar
```

Clicking it issues
`GET /backend-api/estuary/content?id=file_…&fn=…&cd=attachment` and, because of
that `cd=attachment`, **a real browser download** (`diag_probe(1).csv`).

### Why this path does not use the wire tap

Measured on that same click: the tap **sees the request** and then fails to read
the body with **`net::ERR_ABORTED`**. A download is not an in-page fetch, and
CDP has no response body to hand back for one. Chrome's own download event is
the only place those bytes exist. So the retrospective path captures the browser
download and reports `source: "browser"`; the live path is untouched and still
reports `source: "wire"`.

### Why the control is matched by label

That button has no stable structural identity: no `data-testid`, and an icon of
`<use href="…/sprites-core-<hash>.svg#be92c3">` whose hash changes with every
asset deploy. Its neighbour (fullscreen) carries an **identical class list**, so
"the first icon button in the toolbar" would click the wrong one. It is
therefore matched on `aria-label` against the same kind of locale alternation
`notices` already uses. Only the pt-BR spelling (`Baixar`) was measured on this
account; the other spellings are unmeasured, and a miss is reported as a miss
rather than guessed past - `downloadFromPreview` returns null and the caller
reports its own error.

**Verified end to end 2026-09-09**, on the thread that had failed twice:

```
uibridge export chatgpt 6aa1deb0-… --files --json
  complete: true | messages: 2
  FILE: {"name":"diag_probe(1).csv","bytes":24,"mime":null,"source":"browser", …}
  $ cat downloads/diag_probe\(1\).csv
  id,value
  1,alpha
  2,beta
```

`mime` is null on this path and that is honest: the metadata response that names
the type on the live path is never fetched here.

# What this survey changed

| Finding | Status |
|---|---|
| ChatGPT export could report `complete: true` while missing turn 1 | **Fixed** — turn-number evidence now gates completeness |
| Gemini menus mount in `cdk-overlay-container` and attach late; the likely cause of intermittent `modelPicker` failures | **Documented** — timing, not selectors |
| `message-actions` gained `Redo` | Note in `gemini/selectors.json` is stale by one entry; selector unaffected |
| Gemini model labels now version-prefixed (`3.1 Pro`) | Existing regexes verified live, still correct |
| `export --files` could not retrieve a file from a reloaded thread | **Fixed** — the message link only opens the preview panel there; the panel's own control downloads, and the bytes arrive as a browser download, not on the wire |

Confirmed correct by independent measurement, having been taken on trust
before: Gemini has no file input (`cdp-drag`); the `You said` duplication and
its `textExclude`; `message-content-id-r_…` identity; ChatGPT's attachment span
and its re-rendered label; `button.behavior-btn`; Enter not submitting on
Gemini.
