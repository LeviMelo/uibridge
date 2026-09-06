"""
Tiny shared client for the examples. Stdlib only.

Its main job beyond the HTTP call is failing *legibly*: if the server is not
running, or you are signed out, you get one clear line instead of a traceback.
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8477"


class BridgeDown(RuntimeError):
    pass


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
            "open a SECOND terminal, cd to the uibridge folder, run:  npm run serve"
            "\n       (leave it running - it is the server)",
        )


def call(prompt, model="gemini", attachments=None, modes=None, timeout=900):
    """Send one prompt. Returns {'text','json','ms','provenance','modes'}."""
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
    # HTTPError subclasses URLError - it MUST be caught first or the
    # friendly messages below are unreachable.
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read()).get("error", {}).get("message", "")
        except Exception:
            pass
        low = detail.lower()
        if "signed out" in low or "composer" in low:
            _die(
                f"Not signed in to {model}.",
                f"node login.mjs {model}   (sign in, then close the window)",
            )
        _die(
            f"uibridge returned HTTP {e.code}: {detail or '(no detail)'}",
            "check the server terminal for the full log",
        )
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), ConnectionRefusedError) or "refused" in str(e).lower():
            _die(
                "uibridge is not running on 127.0.0.1:8477.",
                "in a second terminal:  npm run serve",
            )
        raise

    ub = body.get("_uibridge", {})
    return {
        "text": body["choices"][0]["message"]["content"],
        "json": ub.get("json"),
        "ms": ub.get("elapsed_ms"),
        # Provenance: what the UI was ACTUALLY set to, read back after both
        # model and modes were applied. Log this in your methods section.
        "provenance": (ub.get("model_applied") or {}).get("final_label"),
        "modes": ub.get("modes_applied"),
        # Did it really browse, and what did it cite? Gemini often answers
        # from its own weights even when told to search.
        "browsed": ub.get("browsed"),
        "sources": ub.get("sources") or [],
        # True when the text came from the UI's own Copy button (canonical
        # markdown). False means the innerText fallback, where pipe tables
        # arrive tab-separated and LaTeX is lost to KaTeX rendering.
        "markdown": ub.get("markdown", False),
        "tables": ub.get("tables") or [],
        "code_blocks": ub.get("code_blocks") or [],
        # Files Gemini GENERATED, already downloaded to disk. Each has
        # name/path/bytes/type, plus text inline for small text payloads.
        "files": ub.get("files") or [],
    }
