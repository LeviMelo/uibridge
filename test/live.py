"""
UI-surface suite for uibridge.

    python test/live.py            # all checks
    python test/live.py file table # only checks whose name matches

WHAT THIS TESTS: the Gemini UI, and only the UI.

Not the model. Whether Gemini can echo a token, add two numbers or emit valid
JSON is not in question and never was - asking it proves nothing and litters
the chat history. Every check below asserts something about how the UI
*renders and exposes* a response, and would fail on a UI change while a
perfectly capable model sat behind it:

  markdown fidelity   pipe tables and LaTeX survive extraction, because the
                      text comes from the Copy button and not innerText
  table structure     a rendered table parses into header + rows
  generated files     a <generated-file> chip is found, opened, and its BYTES
                      downloaded to disk
  code blocks         fenced source arrives with its language
  attachments         an uploaded file is actually registered by the composer
  UI controls         model and thinking selections read back from the picker
  sources             citations come from the '...' -> View sources panel
  isolation           concurrent tabs share neither a thread nor the clipboard
  error paths         bad input fails fast instead of hanging

Prompts are real research questions rather than echo games, so a failure
points at the bridge and the transcript stays usable.
"""
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# The client lives with the examples on purpose: it is the thing a pipeline
# copies, so the suite exercises exactly what a user would run.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "examples"))
from _client import BASE, call, require_server  # noqa: E402

DATA = Path(__file__).resolve().parent.parent / "testdata"
MODEL = "gemini-flash"
NO_THINK = {"thinking": False}

results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))


def raw_post(payload, timeout=120):
    req = urllib.request.Request(
        f"{BASE}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


# ---- rendering fidelity ---------------------------------------------------
def t_markdown_not_innertext():
    """The Copy button yields markdown; innerText does not. Which did we get?

    innerText renders a pipe table as tab-separated fragments. So the presence
    of pipes IS the assertion that extraction went through the UI's own copy
    path rather than scraping rendered text.
    """
    r = call(
        "Compare sevoflurane and propofol for paediatric emergence delirium. "
        "Use a markdown table, and give the pooled risk ratio formula in LaTeX.",
        model=MODEL, modes=NO_THINK,
    )
    t = r["text"]
    check("text extracted as markdown, not innerText",
          r["markdown"] and "|" in t,
          f"via={r['extraction']} pipes={t.count('|')} chars={len(t)}")


def t_latex_source_survives():
    """LaTeX is only recoverable through the provider's own copy path.

    KaTeX keeps no <annotation> and no data-latex, so rendered maths has no
    source in the DOM at all. That makes this check conditional on HOW the
    text was extracted - and the point is that the bridge must never present
    garbled glyphs as if they were LaTeX:

      extraction == "copy"  -> real LaTeX commands must be present
      otherwise             -> the answer MUST be flagged lossy_math, and we
                               assert the flag, not the formula
    """
    r = call("Give the DerSimonian-Laird between-study variance estimator in LaTeX.",
             model=MODEL, modes=NO_THINK)
    t = r["text"]
    if r["extraction"] == "copy":
        has_tex = any(m in t for m in (r"\frac", r"\tau", r"\sum", r"\hat"))
        check("LaTeX source recovered via the copy path", has_tex, repr(t[:90]))
    else:
        check("maths correctly flagged as lossy when copy was unavailable",
              r["lossy_math"] is True,
              f"extraction={r['extraction']} lossy_math={r['lossy_math']}")


def t_table_parses_to_rows():
    """A rendered table must come back as structured rows, not just text."""
    r = call("Give a markdown table of 4 paediatric anaesthesia trials with "
             "columns PMID, drug, n, effect size. Table only.",
             model=MODEL, modes=NO_THINK)
    tabs = r["tables"]
    ok = bool(tabs) and len(tabs[0]["rows"]) >= 3 and len(tabs[0]["header"]) == 4
    check("rendered table parses into header+rows", ok,
          f"{len(tabs)} table(s), header={tabs[0]['header'] if tabs else None}")


def t_code_block_has_language():
    """code-block exposes no raw-source attribute; the fence carries it."""
    r = call("Write a Python function that computes a pooled odds ratio by the "
             "Mantel-Haenszel method. Code only.", model=MODEL, modes=NO_THINK)
    cb = r["code_blocks"]
    ok = bool(cb) and cb[0]["lang"] == "python" and "def " in cb[0]["code"]
    check("fenced code block extracted with language", ok,
          f"{len(cb)} block(s), lang={cb[0]['lang'] if cb else None}")


# ---- generated files ------------------------------------------------------
def t_generated_file_downloaded():
    """The hard one: Gemini emits a real file behind an 'Open' overlay.

    No <a download>, no blob: href - the bytes only arrive by opening the
    viewer and clicking its Download control. Assert BYTES ON DISK.
    """
    r = call("Build a CSV file with 5 rows of paediatric anaesthesia trial data, "
             "columns pmid,drug,n,effect. Give me the actual file.",
             model=MODEL, modes=NO_THINK, timeout=900)
    files = r["files"]
    ok = bool(files) and (files[0].get("bytes") or 0) > 0
    check("generated file retrieved to disk", ok,
          str([(f.get("name"), f.get("bytes")) for f in files]))
    if ok and files[0].get("text"):
        first = files[0]["text"].splitlines()[0]
        check("generated CSV carries a real header row", "," in first, repr(first))


# ---- attachment contract --------------------------------------------------
def t_attachment_registers():
    """Does the composer actually register an uploaded file?

    The assertion is on values that exist ONLY inside the file, so a pass means
    the upload chip resolved and the bytes reached the thread - a transport
    fact about the UI, not a claim about reasoning.
    """
    r = call("The attached CSV has a pmid column. List its values, comma separated.",
             model=MODEL, modes=NO_THINK, attachments=[str(DATA / "trials.csv")])
    pmids = ["31234567", "32145678", "33256789", "34367890", "35478901"]
    hit = sum(1 for p in pmids if p in r["text"])
    check("csv upload registered by the composer", hit >= 4, f"{hit}/5 values present")


def t_pdf_attachment_registers():
    r = call("The attached PDF has a trial registration number. Give it.",
             model=MODEL, modes=NO_THINK,
             attachments=[str(DATA / "trial_abstract.pdf")])
    check("pdf upload registered by the composer", "NCT04412345" in r["text"],
          repr(r["text"][:70]))


def t_two_attachments_register():
    r = call("A CSV and a PDF are attached. Give the first pmid from the CSV and "
             "the NCT number from the PDF.", model=MODEL, modes=NO_THINK,
             attachments=[str(DATA / "trials.csv"), str(DATA / "trial_abstract.pdf")])
    csv_ok, pdf_ok = "31234567" in r["text"], "NCT04412345" in r["text"]
    check("both uploads registered", csv_ok and pdf_ok, f"csv={csv_ok} pdf={pdf_ok}")


# ---- UI control contract --------------------------------------------------
def t_model_picker_readback():
    """A model request must be reflected in the picker - or reported as not.

    Gemini genuinely drops model switches (its own bug: a switch sometimes
    only takes on a later attempt), so this does NOT assert that Gemini
    complied. It asserts the bridge tells the truth either way: when
    model_verified is True the picker must name the model asked for, and when
    it is False the provenance must name whatever is actually active instead
    of the request. Silently attributing an answer to the wrong model is the
    failure that matters here.
    """
    ok, detail = True, {}
    for mid, want in (("gemini-flash-lite", "Flash-Lite"), ("gemini-pro", "Pro")):
        r = call("Summarise the purpose of the PRISMA 2020 checklist in one sentence.",
                 model=mid, modes=NO_THINK)
        label = r["provenance"] or ""
        detail[mid] = f"{label!r} verified={r['model_verified']}"
        if r["model_verified"]:
            if want not in label:
                ok = False          # claimed verified but the label disagrees
        elif want in label:
            ok = False              # said unverified while it clearly applied
    check("model selection reported truthfully", ok, str(detail))


def t_thinking_toggle_readback():
    """The picker label reads '<Model> Extended' only when thinking is on."""
    q = "Outline how to assess risk of bias in a crossover trial."
    on = call(q, model="gemini-pro", modes={"thinking": True})["provenance"] or ""
    off = call(q, model="gemini-pro", modes={"thinking": False})["provenance"] or ""
    check("thinking toggle verified in the picker",
          "Extended" in on and "Extended" not in off,
          f"on={on[-26:]!r} off={off[-26:]!r}")


def t_sources_from_menu():
    """Citations live behind '...' -> View sources, not in the message body.

    Two facts must not be conflated. sources-list is present in EVERY
    response, so it cannot be the browsing signal; source-inline-chip and the
    sources menu entry are. And a response can ATTEMPT a search and still
    answer from the model's weights: measured directly, one such reply had
    zero inline chips and no "View sources" entry in its menu at all. So this
    asserts the correct reading of the UI, not that Gemini chose to browse.
    """
    r = call("Search the web for guidance published in the last year on "
             "paediatric procedural sedation, and name each source site.",
             model=MODEL, modes=NO_THINK)
    urls = [s["url"] for s in r["sources"]]
    if not r["browsed"]:
        # No citations in the UI: sources MUST be empty, or we invented them.
        check("no citations claimed when the UI shows none", not urls,
              f"searched={r['searched']} browsed=False sources={len(urls)}")
        return
    clean = all("accounts.google" not in u and "/intl/" not in u for u in urls)
    check("sources read from the View sources panel",
          len(urls) >= 2 and clean, f"{len(urls)} sources")
    if urls:
        print(f"        e.g. {urls[0][:78]}")


def t_no_false_browsing():
    """browsed must be False when nothing was searched."""
    r = call("Define statistical heterogeneity in meta-analysis in one sentence.",
             model=MODEL, modes=NO_THINK)
    check("browsed=False when no search happened",
          r["browsed"] is False and not r["sources"],
          f"browsed={r['browsed']} searched={r['searched']} sources={len(r['sources'])}")


# ---- isolation + error paths ---------------------------------------------
def t_tab_isolation():
    """Concurrent tabs must share neither a thread nor the clipboard.

    Each prompt asks about a DIFFERENT drug, so a leak shows up as the wrong
    drug in a reply. This also exercises the clipboard mutex: the Copy path is
    a single shared resource, and a missing lock returns another tab's text.
    """
    drugs = ["sevoflurane", "propofol", "ketamine", "dexmedetomidine",
             "remifentanil", "midazolam"]
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=len(drugs)) as pool:
        rs = list(pool.map(
            lambda d: call("In one sentence, state the main paediatric anaesthesia "
                           f"use of {d}. Name the drug in your answer.",
                           model=MODEL, modes=NO_THINK), drugs))
    wall = time.time() - t0
    own = sum(1 for d, r in zip(drugs, rs) if d in r["text"].lower())
    leaked = sum(1 for i, r in enumerate(rs)
                 for j, d in enumerate(drugs)
                 if i != j and d in r["text"].lower())
    mean = sum(r["ms"] for r in rs) / len(rs) / 1000
    check("concurrent tabs stay isolated", own == len(drugs) and leaked == 0,
          f"{own}/{len(drugs)} own, {leaked} leaked, wall={wall:.0f}s "
          f"speedup={mean * len(drugs) / wall:.1f}x")


def t_missing_file_fails_fast():
    t0 = time.time()
    status, _ = raw_post({"model": MODEL,
                          "messages": [{"role": "user", "content": "x"}],
                          "attachments": ["Z:/definitely/missing.csv"]}, timeout=30)
    dt = time.time() - t0
    check("missing attachment fails fast", status == 400 and dt < 5,
          f"HTTP {status} in {dt:.2f}s")


def t_empty_messages():
    status, _ = raw_post({"model": MODEL, "messages": []})
    check("empty messages -> 400", status == 400, f"HTTP {status}")


def t_unknown_model_falls_back():
    # This one runs a real request through the fallback provider, so it needs
    # a real timeout - not raw_post's short default, which is sized for the
    # checks that are supposed to fail immediately.
    status, _ = raw_post({"model": "totally-made-up",
                          "messages": [{"role": "user",
                                        "content": "Define publication bias."}]},
                         timeout=600)
    check("unknown model falls back, no crash", status == 200, f"HTTP {status}")


def t_models_endpoint():
    with urllib.request.urlopen(f"{BASE}/v1/models", timeout=15) as r:
        ids = [m["id"] for m in json.loads(r.read())["data"]]
    need = {"gemini-flash", "gemini-flash-lite", "gemini-pro",
            "chatgpt", "chatgpt-5.6-instant", "chatgpt-5.6-high"}
    # An id here is a promise that calling it works: both providers are
    # calibrated now, and a provider whose selectors are placeholders would
    # be missing from this list rather than present.
    ok = need.issubset(set(ids))
    check("/v1/models advertises every calibrated id", ok, str(ids))


def t_chatgpt_wire_answer():
    """ChatGPT's answer comes off the network, with the server's model slug.

    The point of the check is provenance: `extraction` must be "wire" (not a
    clipboard tier) and `answered_by` must be the slug the site reported, so
    a row can be attributed to the model that actually wrote it.
    """
    status, body = raw_post({"model": "chatgpt-5.6-instant",
                             "messages": [{"role": "user",
                                           "content": "Reply with exactly one word: ready."}]},
                            timeout=300)
    ub = body.get("_uibridge", {})
    ok = status == 200 and ub.get("extraction") == "wire" and bool(ub.get("provenance", {}).get("answered_by"))
    check("chatgpt answers over the wire with a model slug", ok,
          f"HTTP {status} via {ub.get('extraction')} by {ub.get('provenance', {}).get('answered_by')}")


def t_chatgpt_pdf_attachment():
    """A PDF reaches ChatGPT: the upload is confirmed on the wire before sending."""
    status, body = raw_post({"model": "chatgpt-5.6-instant",
                             "messages": [{"role": "user",
                                           "content": "From the attached PDF only, give the sample size as a number."}],
                             "attachments": [str(DATA / "trial_abstract.pdf")]},
                            timeout=300)
    text = body.get("choices", [{}])[0].get("message", {}).get("content", "")
    check("chatgpt pdf attachment answered", status == 200 and any(ch.isdigit() for ch in text),
          f"HTTP {status}: {text[:80]!r}")


TESTS = [
    t_markdown_not_innertext, t_latex_source_survives, t_table_parses_to_rows,
    t_code_block_has_language, t_generated_file_downloaded,
    t_attachment_registers, t_pdf_attachment_registers, t_two_attachments_register,
    t_model_picker_readback, t_thinking_toggle_readback,
    t_sources_from_menu, t_no_false_browsing,
    t_tab_isolation, t_missing_file_fails_fast, t_empty_messages,
    t_unknown_model_falls_back, t_models_endpoint,
    t_chatgpt_wire_answer, t_chatgpt_pdf_attachment,
]


def main():
    require_server()
    if not (DATA / "trials.csv").exists():
        print(f"missing fixtures in {DATA} - see README")
        raise SystemExit(1)

    only = sys.argv[1:]
    tests = [t for t in TESTS if not only or any(o in t.__name__ for o in only)]
    print(f"\nuibridge UI-surface suite  ({len(tests)} checks, model={MODEL})\n")
    t0 = time.time()
    for t in tests:
        try:
            t()
        except SystemExit:
            raise
        except Exception as e:
            check(t.__name__, False, f"raised {type(e).__name__}: {e}")

    passed = sum(1 for _, ok in results if ok)
    print(f"\n  {passed}/{len(results)} passed in {time.time() - t0:.0f}s")
    if passed < len(results):
        print("  failed:", ", ".join(n for n, ok in results if not ok))
    raise SystemExit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
