"""
Minimal client for uibridge. Stdlib only, so a pipeline needs no dependencies.

Its job beyond the HTTP call is failing LEGIBLY: a server that is not running,
or a session that is signed out, produces one clear line and an instruction -
not a traceback.
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8477"


def _die(msg, fix):
    print(f"\n  {msg}\n  Fix: {fix}\n", file=sys.stderr)
    raise SystemExit(1)


def health():
    try:
        with urllib.request.urlopen(f"{BASE}/health", timeout=5) as r:
            return json.loads(r.read())
    except Exception:
        return None


def require_server():
    if health() is None:
        _die(
            "uibridge is not running on 127.0.0.1:8477.",
            "in a second terminal:  npm run serve   (leave it running)",
        )


def call(prompt, model="gemini", attachments=None, modes=None, timeout=900):
    """Send one prompt. Returns a dict of text plus what the UI actually did."""
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}]}
    if attachments:
        payload["attachments"] = attachments
    if modes:
        payload["modes"] = modes

    req = urllib.request.Request(
        f"{BASE}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read())
    # HTTPError subclasses URLError, so it MUST be caught first or the
    # friendly branches below are unreachable.
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error", {})
        except Exception:
            err = {}
        kind, detail = err.get("type", ""), err.get("message", "")
        if kind == "signed_out":
            _die(detail, f"node bin/uibridge.mjs login {model.split('-')[0]}")
        if kind == "challenge":
            _die(detail, "clear the challenge in the open browser window, then retry")
        if kind == "not_calibrated":
            _die(detail, "see src/providers/<provider>/selectors.json")
        if kind == "ui_contract":
            _die(detail, "the UI changed - update that provider's selectors.json")
        _die(f"uibridge returned HTTP {e.code}: {detail or '(no detail)'}",
             "check the server terminal for the full log")
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), ConnectionRefusedError):
            _die("uibridge is not running on 127.0.0.1:8477.",
                 "in a second terminal:  npm run serve")
        raise

    ub = body.get("_uibridge", {})
    prov = ub.get("provenance") or {}
    model_prov = prov.get("model") or {}
    return {
        "text": body["choices"][0]["message"]["content"],
        "json": ub.get("json"),
        "ms": ub.get("elapsed_ms"),
        # True when the text is the provider's OWN markdown (its copy control).
        # False means scraped rendered text, where pipe tables arrive
        # tab-separated and LaTeX is lost to KaTeX rendering.
        "markdown": ub.get("markdown", False),
        "tables": ub.get("tables") or [],
        "code_blocks": ub.get("code_blocks") or [],
        # Files the PROVIDER generated, already downloaded to disk.
        "files": ub.get("files") or [],
        # What the UI actually did, not what the prompt asked for.
        "browsed": ub.get("browsed"),
        "sources": ub.get("sources") or [],
        # Provenance for a methods section: which model really answered, and
        # whether the UI confirmed the selection.
        "provenance": model_prov.get("applied"),
        "model_verified": model_prov.get("verified"),
        "modes": prov.get("modes") or {},
    }
