# uibridge

An OpenAI-compatible endpoint on `localhost`, backed by chat UI sessions in a
real Chrome window. Built for LitScape: a pipeline that fires many LLM calls
per run, against subscriptions that are already paid for, without a hard
daily request cap killing a run at request 40 of 60.

## What it is, precisely

A real Chrome profile, signed in by you, driven by Playwright. Each request
opens a fresh conversation, types the prompt, waits for the reply to finish,
and reads it back. No stealth patches, no fingerprint spoofing, no challenge
solvers - if a provider ever puts a challenge up, you solve it yourself in the
window, same as any other day.

Requests run **concurrently** across a pool of tabs. A burst of 60 calls runs
`concurrency` at a time; the rest queue. Nothing is dropped.

## Setup

```bash
npm install
node login.mjs gemini      # sign in by hand, then close the window
npm run serve
```

## Use from Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8477/v1", api_key="unused")

r = client.chat.completions.create(
    model="gemini",                      # or "chatgpt"
    messages=[{"role": "user", "content": "Return JSON: {\"ok\": true}"}],
)
print(r.choices[0].message.content)
```

Attach files with a non-standard `attachments` field (absolute paths):

```python
r = client.chat.completions.create(
    model="gemini",
    messages=[{"role": "user", "content": "Extract the outcomes as JSON."}],
    extra_body={"attachments": [r"C:\corpus\paper_001.pdf"]},
)
```

The response also carries `_uibridge.json` - the first valid JSON block found
in the reply, already parsed, so you do not have to fence-strip it yourself.

## When it breaks

It will, eventually - providers reshuffle their DOM. Nothing here is subtle:

```bash
node calibrate.mjs gemini
```

That prints which configured selectors still match and lists live candidates
for the ones that do not. Fix `config.json`. No code changes.

## Throughput

`concurrency` in `config.json` sets how many tabs run at once per service
(default 6). Each tab is an independent conversation, so:

| concurrency | 60 calls @ ~8s each |
|---|---|
| 1 | ~8 min |
| 6 | ~80 s |
| 12 | ~40 s |

Raise it until the provider starts throttling or the machine complains. Tabs
open lazily, so a run needing two never opens six. Overflow queues rather than
failing - `/health` shows `tabs`, `busy` and `waiting` per service.

## Honest limits

- **No token counts.** Not observable through a UI; `usage` is present but zero.
- **Plan message caps still apply.** This moves your hand, not your quota.
- **Not for patient-level data.** Published literature is fine. Anything
  identifiable should go to a local model or a paid API with a
  no-training guarantee.

## Files

| File | Role |
|---|---|
| `config.json` | selectors, timeouts, concurrency, port - the only file you edit when a UI changes |
| `browser.mjs` | persistent-profile plumbing |
| `login.mjs` | one-time interactive sign-in |
| `pool.mjs` | tab pool - N concurrent conversations per service |
| `driver.mjs` | type, submit, wait, read (one tab) |
| `server.mjs` | OpenAI-compatible HTTP endpoint |
| `calibrate.mjs` | DOM inspector for repairing selectors |
