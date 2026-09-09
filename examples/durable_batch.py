"""Resumable local JSONL inference, using only Python's standard library.

python examples/durable_batch.py requests.jsonl results.jsonl --run review-v1

Input rows: {"id":"study-42", "body":{"model":"gemini-pro", "messages":[...]}}
Keep --run stable to resume; choose a new value for a deliberate new experiment.
Outputs and failures are checkpointed. Transport failures can be retried by
rerunning this command, always with the same idempotency key.
"""
import argparse
import hashlib
import json
import os
import urllib.error
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--run", required=True, help="Stable identifier for this experiment")
    parser.add_argument("--base-url", default="http://127.0.0.1:8477/v1")
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()]
    ids = [row.get("id") for row in rows]
    if any(not isinstance(id_, str) or not id_ for id_ in ids) or len(set(ids)) != len(ids):
        parser.error("Each input row needs a unique, nonempty string id")
    if any(not isinstance(row.get("body"), dict) or row["body"].get("stream") for row in rows):
        parser.error("Each row needs a non-streaming Chat Completions body")
    if args.input.resolve() == args.output.resolve():
        parser.error("Input and output must be different files")

    checkpoint = {}
    if args.output.exists():
        for line in args.output.read_text(encoding="utf-8").splitlines():
            if line.strip():
                saved = json.loads(line)  # A torn checkpoint fails loudly; it is never silently discarded.
                checkpoint[(saved["run"], saved["id"])] = saved
    args.output.parent.mkdir(parents=True, exist_ok=True)
    had_failure = False
    with args.output.open("a", encoding="utf-8") as output:
        for row in rows:
            data = json.dumps(row["body"], sort_keys=True, ensure_ascii=False).encode("utf-8")
            digest = hashlib.sha256(data)
            for attachment in row["body"].get("attachments", row["body"].get("files", [])):
                with Path(attachment).open("rb") as file:
                    digest.update(hashlib.file_digest(file, "sha256").digest())
            fingerprint = digest.hexdigest()
            prior = checkpoint.get((args.run, row["id"]))
            if prior:
                if prior["body_sha256"] != fingerprint:
                    parser.error(f"Changed body for {row['id']}; use a new --run for a new experiment")
                if prior["state"] in ("completed", "failed"):
                    had_failure |= prior["state"] == "failed"
                    print(f"{row['id']}: checkpoint {prior['state']}")
                    continue
            identity = json.dumps([args.run, row["id"]]).encode("utf-8")
            key = "batch-" + hashlib.sha256(identity).hexdigest()
            record = {"run": args.run, "id": row["id"], "key": key, "body_sha256": fingerprint}
            request = urllib.request.Request(
                args.base_url.rstrip("/") + "/chat/completions", data=data,
                headers={"Content-Type": "application/json", "Idempotency-Key": key},
            )
            halt = False
            try:
                with urllib.request.urlopen(request, timeout=960) as response:
                    record.update(state="completed", response=json.loads(response.read()))
            except urllib.error.HTTPError as error:
                body = error.read().decode("utf-8", errors="replace")
                try:
                    detail = json.loads(body)
                except ValueError:
                    detail = {"error": {"message": body[:1000]}}
                record.update(state="failed", status=error.code, error=detail)
                had_failure = True
                halt = error.code in (401, 429, 503) or detail.get("error", {}).get("type") == "outcome_unknown"
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                record.update(state="transport_unknown", error=str(error))
                halt = True
            output.write(json.dumps(record, ensure_ascii=False) + "\n")
            output.flush()
            os.fsync(output.fileno())
            print(f"{row['id']}: {record['state']}", flush=True)
            if halt:
                print("Stopped. Inspect the saved error and request status before continuing.")
                return 1
    return int(had_failure)


if __name__ == "__main__":
    raise SystemExit(main())
