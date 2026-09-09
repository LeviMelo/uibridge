# Assessment — 2026-09-07

For the latest API/transport fixes and verification, see
`ISSUES_AND_FEATURE_REQUESTS.md`. The user clarified that model scientific
knowledge is outside the bridge's acceptance scope. The historical biomedical
results below are retained as prior work, not bridge acceptance criteria.
The latest suite passes 149 tests; the reported six-turn file/clipboard workload
passed, including canonical copying, file preservation and ledger verification.

The bridge now supports cancellable local work, persistent duplicate protection and resumable batch use through its OpenAI Chat Completions subset. Transport and recovery checks pass; the real biomedical benchmark also exposes reasoning errors. Native API equivalence and general scientific accuracy are not established.

## Verified results

| Facet | ChatGPT 5.6 medium | Gemini Pro |
|---|---|---|
| Signed-in inference and requested model | Passed; wire verification | Passed; picker verification |
| Small synthetic classification | 6/6 labels | 6/6 labels |
| Long synthetic classification, 111,249 characters | 60/60 labels | 60/60 labels |
| Three identifiers across 195,924 characters | Passed via text attachment | Passed via text attachment |
| Official JS SDK and Unicode streaming | Passed | Passed |
| Attachment extraction, continuation, short export | Passed | Passed |
| Two independent conversations | Passed | Passed |
| Controlled Markdown formatting and generated text download | Passed | Passed |
| Low-visibility operation | Headed Chrome parked offscreen | True headless observed |
| Recovery after closing idle browser | Passed, 18.3 seconds | Not live-tested separately |
| Active cancellation followed by four paced inferences | Passed | Passed |
| Concurrent duplicate sharing and saved-result replay | Passed | Passed |
| Live saved responses replayed after daemon restart | 4/4; no browser opened | 4/4; no browser opened |
| Attachment snapshot survives source-file mutation | Passed, exact text | Passed, schema-validated JSON |

The local suite passes 142 tests, including 200 HTTP requests with injected failures, abrupt worker termination, queue/time-budget recovery, cancellation, durable attachment snapshots and Python batch resumption. All 46 JavaScript modules pass syntax checks; the 45-file package excludes profiles and runtime artifacts. Results are cumulative across focused runs after relevant fixes, not one uninterrupted all-green live run.

## Biomedical benchmark

We used 12 real records from the expert-labelled [PubMedQA PQA-L dataset](https://github.com/pubmedqa/pubmedqa), pinned to revision `1cbae8e92f72f20c8d3747cbb3bf5bc53554d997`. A deterministic selection took four records per class. Reference labels and conclusion fields were withheld from prompts. The long variant reverses target order and intersperses unrelated abstracts.

| Model | Short context: 18,708 characters | Long context: 138,911 characters | Same labels across contexts |
|---|---|---|---|
| Gemini Pro | 10/12; macro-F1 0.822 | 10/12; macro-F1 0.822 | 12/12 |
| ChatGPT 5.6 medium | 8/12; macro-F1 0.630 | 9/12; macro-F1 0.709 | 9/12 |

Every run produced 12/12 quotes that exactly matched its own source record. That confirms quote fidelity, not that the quote entails the conclusion. Both models labelled two reference `maybe` records as `yes`; repeated agreement therefore did not guarantee correctness. ChatGPT also changed three labels with context/order. No prompt tuning against these answer keys was performed.

This is a small public diagnostic sample, not the official test split or a model ranking. Training contamination is possible. `test/scientific.mjs` accepts a custom adjudicated JSONL corpus so the same measurements can be applied to the user's own evidence. Reported character counts exclude appended schema instructions; actual bridge inputs were 21,279 and 141,482 characters.

## Problems found and repaired

Gemini silently retained only 32,000 input characters. A large multiline ChatGPT paste stalled Chrome. Inputs above the configured threshold now travel as temporary text attachments, with original character count/hash and transport recorded. This verifies bridge transport; it cannot prove that the provider exhaustively reads a file.

Stale clipboard data returned an earlier Gemini answer, and a sidebar fallback assigned an unrelated ChatGPT conversation ID. Clipboard clearing/verification and response-scoped copying, plus current-page/wire thread identity, fixed the observed cases. Continuation and isolation were retested successfully.

Other repairs cover page-pool concurrency and shutdown, ambiguous submission retries, strict model verification, schema validation, streaming errors, safe unique download paths, prompt-safe error logging, browser positioning/login restoration, and recovery of closed idle sessions. Unsupported API controls now fail explicitly.

Cancellation now interrupts pacing, conversation locks, tab acquisition and polling; active tabs are closed and discarded. Durable `Idempotency-Key` records are claimed before inference and atomically completed. Replays survive restarts; uncertain crash outcomes fail closed instead of resubmitting. Keyed attachments are snapshotted, and keyed streaming emits the saved final result. Explicit cancellation/status endpoints and bounded admitted work support local pipelines. `examples/durable_batch.py` checkpoints results with stable keys.

Legacy live checks passed 7/9 assertions: an actual Gemini service non-answer and an unfenced code response failed. The specific service non-answer is now detected as an error, and subsequent controlled formatting tests passed. Interrupted runs and service-recovery connection failures remain recorded; they are not counted as successful tests.

The first Gemini snapshot test returned the correct identifier followed by a filename, failing the strict plain-text assertion. The failure remains recorded. A subsequent schema-validated JSON test passed without stripping or repairing the answer; use explicit output schemas for machine-consumed extraction.

## Compatibility and remaining gaps

JSON output is prompted and validated with Ajv, rather than generated through native constrained decoding. System/developer roles become textual labels. Token usage is a zero placeholder. Sampling controls, token caps, tool calls, multimodal message parts, Responses, embeddings and batch endpoints are unsupported. Inspect `/v1/capabilities` and README before integrating.

Unkeyed disconnects cancel local work; keyed requests persist until completion or explicit cancellation. Closing a tab cannot guarantee that provider-side generation stops. A crashed in-flight request remains `outcome_unknown`; there is no provider-backed exactly-once guarantee or automatic resubmission. Durable records retain full responses until removed, and deleting a record removes its duplicate protection. Use SDK `maxRetries: 0` without a stable key. Four paced live inferences per provider plus injected-load tests are not an endurance test of provider quotas, outages or days-long unattended operation.

Successful external citation retrieval remains unverified; testing established truthful absence of citations only. ChatGPT PDF testing was interrupted and not successfully rerun. All model variants, file types, long-history exports, OS autostart and installation paths have not been assessed comprehensively. Offscreen Chrome can still have taskbar entries or popups.

The original perfect synthetic scores do not generalize to real biomedical reasoning, as the new benchmark demonstrates. The next scientific milestone is a larger independently adjudicated corpus drawn from the user's actual workloads, with explicit handling of uncertainty and review of model disagreements.

## Evidence and continuation

`HANDOFF.md` identifies exact live run directories under `.uibridge/acceptance/`, implementation details and continuation priorities. Local results: `.uibridge/test-results.txt`; packaging: `.uibridge/package-check.json`; recovery: `.uibridge/acceptance/recovery-results.json`. Runtime evidence is intentionally gitignored. No changes have been committed.
