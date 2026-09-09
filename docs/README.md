# docs

Long-lived records that do not belong in `README.md` (which is for people
*using* uibridge) or in `AGENTS.md` (which is the rules for changing it).

| file | what it is |
|---|---|
| [UI-RECON.md](UI-RECON.md) | **The UI, as measured.** A by-hand survey of the Gemini and ChatGPT interfaces uibridge automates: composers and their decoys, submit and stop controls, the timing of a turn, thread identity, attachments, generated files, and where each of those traps you. Read this before touching a `selectors.json`. |
| [PLAND.md](PLAND.md) | The original project handover: what uibridge is for, how it is built, what was measured along the way, and the rules that are not up for renegotiation. Parts are dated snapshots — it says so where that is true. |
| [ISSUES_AND_FEATURE_REQUESTS.md](ISSUES_AND_FEATURE_REQUESTS.md) | A dated record of findings from live runs and what was done about each. Kept as memory, not as a live backlog. |

These are history as much as documentation. When one of them turns out to be
wrong, the fix is to date the correction and keep the original claim visible —
not to quietly overwrite it. Most of the expensive mistakes in this repository
came from someone trusting a confident sentence nobody had re-measured.
