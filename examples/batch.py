"""
Many calls at once, with answers whose SHAPE you can rely on.

    python examples/batch.py

Classifies 12 study titles against an inclusion criterion, CONCURRENCY at a
time, and reports real wall-clock timing so you can see the concurrency
working instead of taking anyone's word for it.

Two things this shows that matter in a review pipeline:

  - schema=... makes the daemon VALIDATE each answer's JSON. An answer that
    does not fit raises, instead of arriving as a half-parsed guess.
  - a failed row is caught and reported; it does not end the whole batch.

It prints what the model decided. It does not score whether it was right.
"""
import time
from concurrent.futures import ThreadPoolExecutor

try:
    import uibridge
except ImportError:  # not pip-installed yet: use the copy in this repository
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
    import uibridge

MODEL = "gemini-pro"   # a specific id, so every row is attributable to one model
CONCURRENCY = 2        # match providers.gemini.concurrency in config.json

CRITERION = "Inclusion criterion: pediatric (<18y) anesthesia or procedural sedation."

SCHEMA = {
    "type": "object",
    "properties": {
        "include": {"type": "boolean"},
        "population": {"type": "string"},
        "reason": {"type": "string"},
    },
    "required": ["include", "population", "reason"],
}

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


def classify(title):
    try:
        return uibridge.ask(f"{CRITERION}\n\nTitle: {title}", model=MODEL, schema=SCHEMA)
    except uibridge.BridgeError as err:
        return err


def main():
    print(f"Classifying {len(TITLES)} titles with {MODEL}, {CONCURRENCY} at a time...\n")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        results = list(pool.map(classify, TITLES))
    total = time.time() - t0

    answered = [r for r in results if isinstance(r, uibridge.Answer)]
    for title, r in zip(TITLES, results):
        if isinstance(r, uibridge.BridgeError):
            print(f"  [ERR] {r.code:<22} {title[:52]}")
            continue
        mark = "IN " if r.json["include"] else "out"
        print(f"  [{mark}] {r.seconds:5.1f}s  {title[:62]}")

    print(f"\n  wall clock      : {total:.1f}s")
    if answered:
        mean = sum(a.seconds for a in answered) / len(answered)
        print(f"  mean per answer : {mean:.1f}s")
        print(f"  speedup         : {mean * len(answered) / total:.1f}x vs one at a time")
    print(f"  answered        : {len(answered)}/{len(TITLES)}")


if __name__ == "__main__":
    main()
