"""
What you actually need for LitScape: many calls at once, structured output,
timing you can trust.

    python examples/batch.py

Fires 12 classification calls concurrently and reports real wall-clock timing,
so you can see the concurrency working instead of taking my word for it.
"""
import sys
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(Path(__file__).parent))
from _client import call, require_server  # noqa: E402

CONCURRENCY = 2          # match provider.concurrency in config.json


SCHEMA = """Return ONLY a JSON object, no prose:
{"include": true|false, "population": "...", "reason": "..."}

Inclusion criteria: pediatric (<18y) anesthesia or procedural sedation.

Title/abstract:
"""

TITLES = [
    "Remimazolam for procedural sedation in children undergoing MRI",
    "Epidural analgesia in labour: a randomised trial in nulliparous women",
    "EEG-guided sevoflurane titration in pediatric tonsillectomy",
    "Virtual reality distraction during induction in children aged 4-10",
    "Dexmedetomidine versus midazolam premedication in pediatric surgery",
    "Postoperative delirium in elderly hip fracture patients",
    "Caudal block versus penile block for pediatric circumcision",
    "Machine learning prediction of ICU mortality in adult sepsis",
    "Nurse-administered propofol sedation for pediatric endoscopy",
    "Intraoperative hypotension and myocardial injury after noncardiac surgery",
    "Nitrous oxide for laceration repair in the pediatric emergency department",
    "Comparison of videolaryngoscopes in adult difficult airway management",
]


def main():
    print(f"Firing {len(TITLES)} calls, {CONCURRENCY} at a time...\n")
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        results = list(pool.map(lambda t: call(SCHEMA + t), TITLES))

    total = time.time() - t0

    hits = 0
    for title, res in zip(TITLES, results):
        data = res["json"] or {}
        ok = data.get("include")
        hits += 1 if res["json"] else 0
        mark = "IN " if ok else "out" if ok is False else " ? "
        print(f"  [{mark}] {(res['ms'] or 0)/1000:5.1f}s  {title[:62]}")

    per_call = sum((r["ms"] or 0) for r in results) / len(results) / 1000
    print(f"\n  wall clock     : {total:.1f}s")
    print(f"  mean per call  : {per_call:.1f}s")
    print(f"  speedup        : {per_call * len(TITLES) / total:.1f}x vs serial")
    print(f"  valid JSON     : {hits}/{len(TITLES)}")


if __name__ == "__main__":
    main()
