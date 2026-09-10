# Using uibridge from Python

A guide for someone who has never used it. Every example below was run for
real, against the real sites, on 2026-09-10 — the output shown is what came
back, not what it should look like.

```python
import uibridge

answer = uibridge.ask("In one sentence: what is a systematic review?", model="gemini-pro")
print(answer)
```

## Contents

1. [What you are actually running](#1-what-you-are-actually-running)
2. [One-time setup](#2-one-time-setup)
3. [Your first question](#3-your-first-question)
4. [Choosing a model](#4-choosing-a-model)
5. [Conversations](#5-conversations)
6. [Sending files](#6-sending-files)
7. [Getting files back](#7-getting-files-back)
8. [Structured answers (JSON)](#8-structured-answers-json)
9. [Thinking](#9-thinking)
10. [Many questions at once](#10-many-questions-at-once)
11. [Never losing an answer: keys](#11-never-losing-an-answer-keys)
12. [Reading a whole conversation back](#12-reading-a-whole-conversation-back)
13. [When something goes wrong](#13-when-something-goes-wrong)
14. [What an Answer contains](#14-what-an-answer-contains)
15. [Using the official `openai` package instead](#15-using-the-official-openai-package-instead)
16. [What uibridge will never do](#16-what-uibridge-will-never-do)
17. [Where things live on your computer](#17-where-things-live-on-your-computer)
18. [Troubleshooting](#18-troubleshooting)
19. [Advanced: the Client object](#19-advanced-the-client-object)

---

## 1. What you are actually running

uibridge is a small server that runs **on your own computer**. It controls a
real Chrome browser that is signed in to **your** Gemini and ChatGPT accounts.
When your script asks a question, uibridge types it into the website, waits
for the answer, and copies the answer back to your script.

```
your Python script
      │   uibridge.ask("...")
      ▼
uibridge   (a server on this computer, http://127.0.0.1:8477)
      │   types the question, reads the answer
      ▼
Chrome, signed in as you
      │
      ▼
gemini.google.com / chatgpt.com
```

What follows from that:

- **It is as fast as the website.** Seconds for a short answer; minutes for a
  thinking model. There is no way to make the site answer faster.
- **It uses your subscription**, the same as typing into the site yourself.
  Every question is a real message in a real conversation you can open in
  your browser.
- **It can only do what the website can do.** There is no temperature
  setting, no token count, no system prompt — the website has none of those.
- **Nothing is sent anywhere except the website itself.** uibridge only
  listens on this computer; no other machine can reach it.

The Python package (`import uibridge`) is only a messenger to that server. It
does not change what the model wrote: `answer.text` is exactly what the site
produced.

---

## 2. One-time setup

Do these once. Each has a command to check it worked.

| Step | Command | Check |
|---|---|---|
| 1. Node.js 22 or newer | install from nodejs.org | `node --version` |
| 2. Google Chrome | install normally | — |
| 3. uibridge's own libraries | in the uibridge folder: `npm install` | no errors |
| 4. The `uibridge` command | in the uibridge folder: `npm install -g .` | `uibridge --version` |
| 5. Sign in to each site | `uibridge login gemini` and `uibridge login chatgpt` | `uibridge status` |
| 6. The Python package | in the uibridge folder: `pip install -e python` | `python -c "import uibridge"` |

About step 5: a normal Chrome window opens. **You** sign in, then close the
window. uibridge never sees or stores your password — the session stays in a
private Chrome profile, exactly as if you had signed in to Chrome yourself.

About step 6: `-e` means "editable" — Python uses the files in the uibridge
folder directly, so when uibridge is updated you do not need to reinstall.
If you have more than one Python on the computer, use the one you will run
your scripts with: `python -m pip install -e python`.

**Check everything at once:**

```bash
uibridge status
```

```
gemini: authenticated
  a session cookie is present
chatgpt: authenticated
  the app's own session endpoint (/api/auth/session)
```

```bash
python -c "import uibridge; print(uibridge.models())"
```

```
['gemini', 'gemini-flash-lite', 'gemini-flash', 'gemini-pro', 'chatgpt', 'chatgpt-5.6-instant', 'chatgpt-5.6-medium', 'chatgpt-5.6-high', 'chatgpt-5.5-instant', 'chatgpt-5.5-medium', 'chatgpt-5.5-high']
```

**You do not need to start uibridge yourself.** The first time your script
calls it, the package starts it in the background, and it keeps running after
your script ends so the next script is fast. To stop it: `uibridge stop`.

If you would rather it were always running from the moment you log in to
Windows, run `uibridge autostart` once (`uibridge autostart --remove` undoes
it). It is optional.

---

## 3. Your first question

`examples/hello.py`:

```python
import uibridge

answer = uibridge.ask("In one sentence: what is a systematic review?", model="gemini-pro")

print(answer)
print(f"\n({answer.seconds:.1f}s, model verified: {answer.model_verified})")
for note in answer.warnings:
    print("note:", note)
```

Real output — run with uibridge **not** running beforehand, so this also shows
it starting itself:

```
A systematic review is a highly rigorous research methodology that collects, critically evaluates, and synthesizes all available empirical evidence matching pre-specified criteria to comprehensively answer a specific scientific or clinical question while minimizing bias.

(13.7s, model verified: True)
```

Three things to notice:

- **`model=` is required.** There is no default, because for research it
  matters which model wrote each answer. See the next section.
- **`print(answer)` prints the answer's text**, nothing else. The rest of the
  information lives in properties like `answer.seconds`.
- **`answer.warnings` is empty** for an ordinary answer. When it is not, each
  entry is a sentence saying what deserves a second look (see section 14).
  Checking it is a good habit.

---

## 4. Choosing a model

| `model=` | What it is |
|---|---|
| `gemini-pro` | Gemini's strongest model |
| `gemini-flash` | Gemini, faster |
| `gemini-flash-lite` | Gemini, fastest |
| `chatgpt-5.6-instant` | ChatGPT 5.6, answers straight away |
| `chatgpt-5.6-medium` | ChatGPT 5.6, thinks first (standard effort) |
| `chatgpt-5.6-high` | ChatGPT 5.6, thinks longer (extended effort) |
| `chatgpt-5.5-instant` / `-medium` / `-high` | The same, for ChatGPT 5.5 |
| `gemini`, `chatgpt` | **Whatever model the site currently has selected.** Avoid these for research — they do not pin a model, and `answer.warnings` will say so. |

`uibridge.models()` always gives the current list.

**Confirmed, not assumed.** After choosing the model on the website,
uibridge reads the page back to check it really switched (and on ChatGPT,
also checks which model the *server* says answered). If it cannot confirm the
model, it **refuses** with an error rather than hand you an answer labelled
with the wrong model. `answer.model_verified` is `True` when the check passed.

For a systematic review, that means every row in your results can be
attributed to the model you named.

---

## 5. Conversations

Every `ask()` starts a **new** conversation, so questions cannot see each
other. To continue a conversation, pass the previous answer's `thread_id`:

```python
a1 = uibridge.ask("Name one well-known reporting guideline for systematic reviews. One line.",
                  model="gemini-pro")
print(a1)
print(repr(a1))

a2 = uibridge.ask("What does its acronym stand for? One line.",
                  model="gemini-pro", thread=a1.thread_id)
print(a2)
print("same conversation:", a2.thread_id == a1.thread_id)
```

Real output:

```
PRISMA (Preferred Reporting Items for Systematic Reviews and Meta-Analyses) is the standard reporting guideline for systematic reviews.
<uibridge.Answer model='gemini-pro' chars=135 thread_id='5ed64dc941182c96'>
PRISMA stands for Preferred Reporting Items for Systematic Reviews and Meta-Analyses.
same conversation: True
```

The `thread_id` is the website's own id for that conversation — the same one
in the browser's address bar when you open it. Save it if you want to come
back to a conversation later, even from a different script or another day.

---

## 6. Sending files

Pass a path, or a list of paths, as `files=`:

```python
answer = uibridge.ask("How many data rows (excluding the header) does the attached CSV have? "
                      "Reply with just the number.",
                      model="gemini-pro", files=["trials.csv"])
print(answer)
```

Real output — note that Gemini chose to run code to count the rows, and that
code is part of what it wrote, so it is part of `answer.text`:

````
```python
import pandas as pd
df = pd.read_csv("trials.csv")
print(len(df))

```

```text
5


```

5
````

Good to know:

- **Relative paths mean relative to where your script is running from**,
  just as with `open()`. The package turns them into full paths before
  sending, because the uibridge server runs in a different folder.
- **A file that does not exist is refused before anything is sent** — you get
  an `InvalidRequest` error, and no message reaches the site.
- **Which file types work is up to the website.** CSV, text and PDF work on
  both.
- **Very long questions are sent as a file automatically.** Above 32,000
  characters, typing into the website becomes unreliable, so uibridge attaches
  the text as a `.txt` file instead. `answer.raw["_uibridge"]["input"]["transport"]`
  says which happened: `"composer"` (typed) or `"attachment"`.

---

## 7. Getting files back

When the model **creates** a file (a CSV, a chart, a spreadsheet), uibridge
downloads it for you. It is listed in `answer.files`:

```python
answer = uibridge.ask("Using Python, create a CSV file named guide_demo.csv with columns id,value "
                      "and three rows, and give me the download link.",
                      model="chatgpt-5.6-medium")
print(answer)
for f in answer.files:
    print(f["name"], f["path"], f["bytes"], "bytes")
```

Real output:

```
[Download guide_demo.csv](sandbox:/mnt/data/guide_demo.csv)
guide_demo.csv C:\Users\Galaxy\LEVI\projects\uibridge\downloads\guide_demo.csv 36 bytes
```

Each entry has `name`, `path` (where it is on your disk), `bytes`, `mime`
(the file type, when the site said) and `source`. A file that could not be
downloaded has an `error` instead of a `path`, and `answer.warnings` mentions
it — the rest of the answer still comes back.

Files land in the `downloads` folder (section 17). A second file with the same
name is saved as `name (2).csv` rather than overwriting the first.

To collect every file a *whole conversation* ever produced, see section 12.

---

## 8. Structured answers (JSON)

There are three levels, from loosest to strictest.

**`answer.json` — always there, never checked.** If the answer contains JSON,
this is it, parsed into Python. If not, it is `None`. Nothing checked its
shape, so treat it as a convenience.

**`json=True` — must be valid JSON.** uibridge asks for JSON only, and if the
answer is not valid JSON the request fails instead of returning it.

**`schema=` — must match the shape you describe.** You describe the fields
you want using [JSON Schema](https://json-schema.org/learn/getting-started-step-by-step);
uibridge asks for exactly that and checks the answer against it before
returning:

```python
schema = {
    "type": "object",
    "properties": {
        "population": {"type": "string"},
        "intervention": {"type": "string"},
        "sample_size": {"type": "integer"},
    },
    "required": ["population", "intervention", "sample_size"],
}
abstract = ("In a randomised trial of 120 children aged 2-12 undergoing tonsillectomy, "
            "intranasal dexmedetomidine was compared with oral midazolam as premedication.")

answer = uibridge.ask("Extract the study details from this abstract:\n\n" + abstract,
                      model="gemini-pro", schema=schema)
print(answer.json)
print(type(answer.json["sample_size"]).__name__)
```

Real output:

```
{'population': 'children aged 2-12 undergoing tonsillectomy', 'intervention': 'intranasal dexmedetomidine vs oral midazolam', 'sample_size': 120}
int
```

If the answer does not fit the schema, you get a `BridgeError` whose `code` is
`"invalid_response_format"`. **Nothing is repaired, guessed or filled in.**
That is deliberate: in a review pipeline, a row that failed loudly is better
than a row that was quietly patched. Retry it, or simplify the schema.

The website does not have a strict JSON mode, so the model is *asked* to
follow the schema and then *checked*. Simple, flat schemas succeed most often.

---

## 9. Thinking

**Gemini:** turn extended thinking on or off with `thinking=`:

```python
answer = uibridge.ask("In two sentences: why does allocation concealment matter in a randomised trial?",
                      model="gemini-pro", thinking=True)
```

uibridge switches the setting on the page and then reads it back. In the real
run, `answer.raw["_uibridge"]["provenance"]` recorded:

```json
{"model": {"requested": "gemini-pro", "verified": true, ...},
 "modes": {"thinking": {"requested": true, "applied": true, "verified": true, ...}},
 "final_state": "Open mode picker, currently Pro Extended"}
```

— that is, thinking was asked for, switched on, and confirmed. Leaving
`thinking=` out keeps whatever the site already has.

**ChatGPT:** thinking effort is part of the model name instead —
`chatgpt-5.6-instant`, `-medium` or `-high` (section 4).

---

## 10. Many questions at once

`examples/batch.py` classifies 12 study titles, two at a time, validating
every answer against a schema. The important parts:

```python
from concurrent.futures import ThreadPoolExecutor
import uibridge

MODEL = "gemini-pro"
CONCURRENCY = 2

def classify(title):
    try:
        return uibridge.ask(f"{CRITERION}\n\nTitle: {title}", model=MODEL, schema=SCHEMA)
    except uibridge.BridgeError as err:
        return err            # one failed row must not end the whole batch

with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
    results = list(pool.map(classify, TITLES))
```

Real output:

```
Classifying 12 titles with gemini-pro, 2 at a time...

  [IN ]   9.1s  Remimazolam for procedural sedation in children undergoing MRI
  [out]  25.0s  Epidural analgesia in labour: a randomised trial in nulliparou
  [IN ]  15.5s  EEG-guided sevoflurane titration in pediatric tonsillectomy
  [IN ]  13.6s  Virtual reality distraction during induction in children aged 
  [IN ]  16.0s  Dexmedetomidine versus midazolam premedication in pediatric su
  [out]  11.7s  Postoperative delirium in elderly hip fracture patients
  [IN ]  17.1s  Caudal block versus penile block for pediatric circumcision
  [out]  15.5s  Machine learning prediction of ICU mortality in adult sepsis
  [IN ]  15.7s  Nurse-administered propofol sedation for pediatric endoscopy
  [out]  16.4s  Intraoperative hypotension and myocardial injury after noncard
  [IN ]  15.8s  Nitrous oxide for laceration repair in the pediatric emergency
  [out]  17.7s  Comparison of videolaryngoscopes in adult difficult airway man

  wall clock      : 99.9s
  mean per answer : 15.8s
  speedup         : 1.9x vs one at a time
  answered        : 12/12
```

Every one of the 12 answers passed the schema check, so every `r.json` is a
dict with exactly the fields asked for. The script prints what the model
decided; it does not score whether that was right - that judgement is yours.

**Why only two at a time, and why the pauses?** uibridge deliberately spaces
out new conversations: at least 8 seconds apart on Gemini, 20 on ChatGPT, with
2 Gemini tabs and 1 ChatGPT tab at once. Opening many new conversations in a
burst is exactly what gets an account temporarily locked — this happened to
ChatGPT during development, and those numbers are what stopped it. Using more
threads than that does no harm (extra requests simply wait their turn), but
it does not make anything faster either.

Plan for it: 100 Gemini questions take at least 100 × 8 s ≈ 14 minutes from
pacing alone, plus the answers themselves.

For a long run you may need to stop and resume, use keys (next section) or
`examples/durable_batch.py`, which does it for you: it reads questions from a
JSONL file, writes every answer to another, and on a second run skips what is
already done.

---

## 11. Never losing an answer: keys

**The problem.** Suppose your script is waiting for an answer and your laptop
sleeps, or you press Ctrl+C, or the wait times out. Was the question sent?
Maybe. If you simply ask again, you might post the same question twice into
the conversation — and pay for it twice.

**The fix: give the request a name**, with `key=`:

```python
answer = uibridge.ask("In two sentences: why does allocation concealment matter in a randomised trial?",
                      model="gemini-pro", thinking=True, key="python-guide-thinking-2026-09-10")
```

With a key:

- Asking again with the **same key and the same question** never sends
  anything. It returns the saved answer — even after a restart.
- `uibridge.result(key)` fetches the saved answer (waiting, if it is still
  being produced). It never sends anything to the site.
- `uibridge.status(key)` says where it is. `uibridge.cancel(key)` stops it.

Real output, fetching the answer above by its key afterwards:

```python
again = uibridge.result("python-guide-thinking-2026-09-10")
print("same saved answer:", again.raw["id"] == answer.raw["id"])
print(uibridge.status("python-guide-thinking-2026-09-10"))
```

```
same saved answer: True
{'state': 'completed', 'created_at': '2026-09-10T20:46:23.704Z', 'finished_at': '2026-09-10T20:46:36.500Z', 'response_id': 'chatcmpl-zzbh7rbrz'}
```

Rules for keys:

- **One key per question.** Something like `f"{run_name}-{study_id}"` works
  well: `"screening-v1-study-0042"`.
- **A new question needs a new key.** Reusing a key for a different question
  is refused (`idempotency_conflict`), so a typo cannot return the wrong
  answer.
- **To ask the same question again on purpose**, e.g. a fresh run, change the
  key: `"screening-v2-study-0042"`.
- Saved answers are kept until you delete them (section 17).

If a keyed request loses its connection, the error tells you the key, so you
can recover it:

```python
try:
    answer = uibridge.ask(question, model="gemini-pro", key=my_key)
except uibridge.OutcomeUnknown as err:
    answer = uibridge.result(err.key)       # waits for it; sends nothing new
```

---

## 12. Reading a whole conversation back

`uibridge.export()` reads every message of a conversation back from the
website, in order:

```python
doc = uibridge.export("gemini", a1.thread_id)       # a1 from section 5
print("complete:", doc["complete"], "| messages:", len(doc["messages"]))
for m in doc["messages"]:
    print(f"  {m['role']:<9} {m['text'][:70]!r}")
```

Real output:

```
complete: True | messages: 4
  user      'Name one well-known reporting guideline for systematic reviews. One li'
  assistant 'PRISMA (Preferred Reporting Items for Systematic Reviews and Meta-Anal'
  user      'What does its acronym stand for? One line.'
  assistant 'PRISMA stands for Preferred Reporting Items for Systematic Reviews and'
```

- **`complete`** is `True` only when uibridge could prove it saw the whole
  conversation, top to bottom, with nothing missing. These websites load long
  conversations in pieces, so this is a real check, and `doc["evidence"]`
  says how it was made. If it is `False`, the export is still returned, but
  do not treat it as the full record.
- **`files=True`** also downloads every file the conversation generated;
  they appear in `doc["files"]`.
- `uibridge.threads()` lists the conversations this computer has sent
  messages to.

---

## 13. When something goes wrong

Every problem arrives as an exception. They all inherit from
`uibridge.BridgeError`, so catching that one catches everything:

| Exception | Meaning | What to do |
|---|---|---|
| `uibridge.NotRunning` | uibridge is not running and could not be started | read the message; usually `npm install -g .` in the uibridge folder |
| `uibridge.SignedOut` | the website session expired | `uibridge stop`, then `uibridge login gemini` (or `chatgpt`), then carry on |
| `uibridge.Challenge` | the site is showing a "are you human?" check | see [Verification checks](#verification-checks) |
| `uibridge.InvalidRequest` | the question itself is wrong: unknown model, missing file, bad schema | fix the code; nothing was sent |
| `uibridge.OutcomeUnknown` | the connection was lost while waiting, so it is unknown whether the question was sent | see section 11; if you did not use a key, check the conversation in the browser before asking again |
| `uibridge.BridgeError` | anything else | `err.code` says exactly what (list below) |

Every error has:

- `err.code` — a short fixed name, e.g. `"rate_limited"`. Branch on this, not
  on the message.
- `err.retryable` — `True` only when asking again is both **safe** and
  **worth it**. It is `False` whenever the question might already have
  reached the site.
- `err.hint` — what to do, in plain words (also shown when you print it).
- `err.message`, `err.status` (the HTTP status), `err.detail`, `err.key`.

Real output, asking for a model that does not exist:

```python
try:
    uibridge.ask("hello", model="gemini-ultra-9000")
except uibridge.InvalidRequest as err:
    print(err.code, err.status)
    print(err)
```

```
invalid_request 400
[invalid_request] Unknown model "gemini-ultra-9000". Available: gemini, gemini-flash-lite, gemini-flash, gemini-pro, chatgpt, chatgpt-5.6-instant, chatgpt-5.6-medium, chatgpt-5.6-high, chatgpt-5.5-instant, chatgpt-5.5-medium, chatgpt-5.5-high
```

**A sensible pattern for a pipeline:**

```python
try:
    answer = uibridge.ask(question, model="gemini-pro", key=key)
except uibridge.SignedOut:
    raise                                   # stop everything: a human must sign in
except uibridge.OutcomeUnknown as err:
    answer = uibridge.result(err.key)       # recover it; do not re-ask
except uibridge.BridgeError as err:
    if err.retryable:
        ...                                 # wait a little, then try again
    else:
        record_failure(key, err.code, str(err))
```

**Never retry blindly.** The package itself never retries a question on its
own, because a retry after the question may have been sent posts it twice.
The one exception is when the connection was *refused* outright, which proves
nothing was received — then it starts uibridge and sends it once.

### The codes you are most likely to meet

| `err.code` | What happened | What to do |
|---|---|---|
| `signed_out` | session expired | sign in again (above) |
| `challenge` | human-verification check | see below |
| `rate_limited` | the site said "too many requests" | wait a few minutes; send fewer at once |
| `notice_blocking` | one of the site's pop-ups kept covering the page | retrying usually works |
| `model_unverified`, `model_not_applied` | the site would not confirm the model you asked for | retry, or choose another model |
| `mode_not_applied` | thinking could not be switched | retry |
| `invalid_response_format` | the answer did not match your schema / was not JSON | retry, or simplify the schema |
| `idempotency_conflict` | that key was already used for a different question | use a new key |
| `empty_response` | the site finished without writing anything | retry |
| `upload_failed` | the site refused your file | check the file opens and its type is accepted |
| `timeout`, `request_timeout` | the answer took longer than allowed (15 minutes overall) | retry; for very long tasks, see section 19 |
| `ui_contract` | the website changed in a way uibridge does not recognise | needs a code fix — keep the message |
| `queue_full` | too many requests are already waiting | send fewer at once |

The complete list is in the Errors table of the main [README](../README.md#errors).

### Verification checks

Sometimes a site shows an "are you human?" check. **uibridge will not solve
or get around one** — it stops and raises `Challenge`. The browser normally
runs hidden, so to see it:

```bash
uibridge stop
uibridge serve --headed
```

That starts uibridge with a visible browser window. Ask your question again;
when the check appears in that window, complete it yourself. Then press
Ctrl+C in that terminal, and carry on as normal — your next script starts the
usual hidden one.

### A signed-out session

```bash
uibridge stop
uibridge login gemini
```

Sign in in the window that opens, close it, and run your script again.
`uibridge stop` first matters: only one program may use a browser profile at
a time.

---

## 14. What an Answer contains

`print(answer)` prints the text. Everything else is a property:

| Property | What it is |
|---|---|
| `answer.text` | The model's answer, exactly as the site produced it. |
| `answer.thread_id` | The conversation's id. Pass it as `thread=` to continue. |
| `answer.model` | The model id you asked for. |
| `answer.model_verified` | `True` if uibridge confirmed the page used that model. |
| `answer.model_applied` | What the page itself said it was set to. |
| `answer.seconds` | How long it took (also `answer.elapsed_ms`). |
| `answer.json` | The JSON in the answer, parsed, or `None` (section 8). |
| `answer.tables` | Markdown tables in the answer, as `[{"header": [...], "rows": [...]}]`. |
| `answer.code_blocks` | Code blocks in the answer. |
| `answer.files` | Files the model generated, already downloaded (section 7). |
| `answer.citations` | ChatGPT: each citation with `url`, and `at` — its character position in `text`. |
| `answer.sources` | Web pages consulted, when the model searched. |
| `answer.extraction` | How the text was read (below). |
| `answer.truncated` | `True` if the answer was cut off before the site finished. |
| `answer.suspect` | `True` if the answer opens like a failure ("I could not…") — read it before using it. |
| `answer.warnings` | A list of plain-English notes on anything worth a second look. Empty is normal. |
| `answer.key` | The key you passed, if any. |
| `answer.raw` | The complete response, for anything not listed here. |

**`answer.extraction`** — where the text came from, best first:

| Value | Meaning |
|---|---|
| `wire` | ChatGPT: read from what the site's server sent — the model's own text. |
| `copy` | Gemini: read through the site's own Copy button — the model's own markdown. |
| `dom-markdown` | Copying failed, so the markdown was rebuilt from the page. Formatting may differ; `warnings` says so. |
| `rendered` | Read off the screen. Tables and code formatting are lost; `warnings` says so. |

`tables`, `code_blocks` and `json` are worked out *from* the text for your
convenience. They never replace it: if one of them ever looks wrong, the text
is the record.

---

## 15. Using the official `openai` package instead

uibridge speaks the same language as OpenAI's API, so code already written
for the `openai` package works by pointing it at uibridge. Use this if you
have existing code, or want streaming.

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8477/v1", api_key="local", max_retries=0, timeout=900)

r = client.chat.completions.create(
    model="gemini-pro",
    messages=[{"role": "user", "content": "In one sentence: what is a systematic review?"}],
)
print(r.choices[0].message.content)
print(r.to_dict()["_uibridge"]["thread_id"])      # everything uibridge-specific lives here
```

- **`api_key`** can be any text; uibridge does not use one. No request goes
  to OpenAI — `base_url` sends everything to uibridge on your computer.
- **`max_retries=0` matters.** The `openai` package normally retries a failed
  request twice, and here each retry can post the question into your
  conversation again. uibridge also tells it not to (`x-should-retry: false`),
  but setting this removes the doubt.
- **Continuing a conversation:** `extra_body={"thread_id": previous_thread_id}`.
- **A key:** `extra_headers={"Idempotency-Key": "my-key"}`.
- The `openai` package does **not** start uibridge for you.

**Streaming** — pieces printed as they arrive:

```python
stream = client.chat.completions.create(
    model="gemini-pro",
    messages=[{"role": "user", "content": "Count from 1 to 5, one number per line."}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content if chunk.choices else None
    if delta:
        print(delta, end="", flush=True)
```

Real output:

```
1
2
3
4
5
```

In that run the whole answer arrived as **a single piece**. Streaming works
and is correct, but do not count on a smooth word-by-word feed from Gemini —
it depends on how the site delivers the answer.

---

## 16. What uibridge will never do

So that nothing surprises you:

- **Change what the model wrote.** No tidying, reformatting or summarising.
  The only thing ever removed is invisible citation markers that ChatGPT puts
  inside its text, which become `answer.citations` instead.
- **Pretend to support settings the website lacks.** With the `openai`
  package you can still send `temperature`, `top_p`, `seed` and so on — they
  are accepted, **ignored**, and named back to you, and `answer.warnings`
  lists them. Your run was not `temperature=0`, and uibridge will not let you
  believe it was.
- **Count tokens.** A website does not show them. `usage` is always zero.
- **Solve "are you human?" checks**, or get around a site's protections.
- **Handle your password.** You sign in yourself, in a normal window.
- **Send faster than the pacing allows** (section 10).
- **Be reachable from another computer.** It only listens on this one.

---

## 17. Where things live on your computer

```bash
uibridge paths
```

On this computer, because a `config.json` exists in the uibridge folder,
everything lives in that folder:

| What | Where | Notes |
|---|---|---|
| Your logins | `.profiles\` | **As sensitive as your passwords.** Never share, upload or commit this folder. |
| Downloaded files | `downloads\` | Files the models generated. |
| Conversation records | `.uibridge\threads\` | One file per conversation: what was sent and what came back, file hashes. No passwords. |
| Saved keyed answers | `.uibridge\requests\` | Kept until you delete them. Deleting one means that key can be sent again. |
| Exports | `.uibridge\exports\` | |
| The server's log | `.uibridge\daemon.log` | Look here if something is odd. |
| Settings | `config.json` | Every setting is described in `config.example.json`. |

To keep uibridge's data somewhere else, set the `UIBRIDGE_HOME` environment
variable to a folder before starting it. You would then need to sign in again
there, since your logins live in the old folder.

---

## 18. Troubleshooting

**`ModuleNotFoundError: No module named 'uibridge'`** — the package is not
installed for the Python you are running. From the uibridge folder:
`python -m pip install -e python`.

**`NotRunning: ... the uibridge command is not on this machine's PATH`** — run
`npm install -g .` in the uibridge folder (setup step 4).

**The first question is slow.** It is starting uibridge and a browser. Later
questions reuse both.

**Everything is slow.** It is a website: thinking models take minutes, and new
conversations are deliberately spaced out (section 10).

**I updated uibridge and nothing changed.** A running uibridge keeps using the
code it started with. Run `uibridge stop`; your next question starts the new
version.

**Can two scripts use it at the same time?** Yes. They share the same uibridge,
which queues their questions.

**Does it work in Jupyter?** Yes, the same `import uibridge`.

**The answer looks cut off.** Check `answer.truncated` and `answer.warnings`.

**Something else.** Read the end of `.uibridge\daemon.log`, then look up
`err.code` in the [README's Errors table](../README.md#errors).

**Running the package's own tests** (offline — they start a throwaway server
with a scripted stand-in, and never touch a real website):

```bash
npm run test:python
```

---

## 19. Advanced: the Client object

The `uibridge.ask(...)` shortcuts use a shared default connection. For
different settings, make your own:

```python
client = uibridge.Client(
    "http://127.0.0.1:8477",   # or set the UIBRIDGE_URL environment variable
    timeout=960,               # seconds to wait for an answer (the default)
    auto_start=True,           # start uibridge if it is not running (the default)
)
answer = client.ask("...", model="gemini-pro")
```

`Client` has the same methods as the module: `ask`, `models`, `export`,
`threads`, `result`, `status`, `cancel`, plus `health()`, `is_running()` and
`start()`.

**Timeouts.** uibridge allows a whole request 15 minutes, and the package
waits a little longer (16), so a slow answer arrives as uibridge's own clear
`timeout` error rather than as a lost connection. For tasks you expect to take
longer, raise `requestTimeoutMs` (and the relevant `responseTimeoutMs`) in
`config.json`, restart uibridge with `uibridge stop`, and pass a matching
`timeout=` here.

**Everything `ask()` accepts:**

| Argument | Meaning |
|---|---|
| `prompt` | What to say. |
| `model` | Which model (section 4). Required. |
| `thread=` | Continue this conversation (section 5). |
| `files=` | A path or list of paths to attach (section 6). |
| `thinking=` | Gemini: `True`/`False` for extended thinking (section 9). |
| `schema=` | A JSON Schema the answer must match (section 8). |
| `json=` | `True` to require valid JSON of any shape (section 8). |
| `key=` | A name for this request, so it is never sent twice (section 11). |
| `timeout=` | Seconds to wait, overriding the client's default. |
