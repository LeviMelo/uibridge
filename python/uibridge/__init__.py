"""
uibridge - use your own Gemini and ChatGPT subscriptions from Python.

    import uibridge

    answer = uibridge.ask("What is a systematic review?", model="gemini-pro")
    print(answer)              # the model's answer, exactly as it wrote it

This is a thin client for the uibridge daemon on this machine
(http://127.0.0.1:8477). The daemon drives a real, signed-in browser; this
module only talks to the daemon. If the daemon is not running, the first call
starts it in the background.

Nothing here edits, cleans or summarises what the model said: `answer.text` is
the provider's own text, unchanged. Everything else on an Answer DESCRIBES the
text - it never replaces it.

Standard library only. The full guide is docs/PYTHON.md in the uibridge
repository.
"""
from __future__ import annotations

import http.client
import json as _json
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request

__version__ = "0.4.0"

__all__ = [
    "ask", "models", "export", "threads", "result", "status", "cancel",
    "health", "is_running", "start",
    "Client", "Answer",
    "BridgeError", "NotRunning", "SignedOut", "Challenge", "InvalidRequest", "OutcomeUnknown",
]

DEFAULT_URL = "http://127.0.0.1:8477"

# A loopback daemon must never be reached through a proxy. urllib honours
# HTTP_PROXY by default, so on a machine with a corporate proxy configured
# every call here would otherwise be sent to that proxy and fail.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class BridgeError(Exception):
    """Something stopped an answer from being retrieved.

    `code` is uibridge's own error type (the Errors table in README.md), so a
    program can branch on it instead of matching message text. `retryable` is
    the daemon's verdict on whether sending the SAME request again is both
    safe and worth it - it is False whenever the prompt may already have
    reached the site. `hint` is a plain-English next step, when there is one.
    """

    def __init__(self, message, *, code="bridge_error", status=None, retryable=False,
                 detail=None, key=None, hint=None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.retryable = retryable
        self.detail = detail
        self.key = key
        self.hint = hint

    def __str__(self):
        text = f"[{self.code}] {self.message}"
        return f"{text}\n  What to do: {self.hint}" if self.hint else text


class NotRunning(BridgeError):
    """No uibridge daemon is answering, and one could not be started."""


class SignedOut(BridgeError):
    """That provider's browser profile is not signed in."""


class Challenge(BridgeError):
    """The site is showing a human-verification check. uibridge never solves one."""


class InvalidRequest(BridgeError):
    """The request itself is wrong: an unknown model, a missing file, a bad schema."""


class OutcomeUnknown(BridgeError):
    """It is not known whether the prompt reached the site.

    Raised when the connection dropped or timed out while an answer was being
    produced, and for the daemon's own `outcome_unknown`. Asking again might
    post a DUPLICATE message into your conversation. If you passed `key=`,
    fetch the saved answer with uibridge.result(key) instead of re-asking.
    """


_BY_CODE = {
    "signed_out": SignedOut,
    "challenge": Challenge,
    "invalid_request": InvalidRequest,
    "outcome_unknown": OutcomeUnknown,
    "daemon_not_running": NotRunning,
    "daemon_start_failed": NotRunning,
}

# What a person should DO about each error they are likely to meet. The
# daemon's own message says what happened; this says what comes next.
_HINTS = {
    "signed_out": "sign in once, in the window that opens:  uibridge login gemini  (or: uibridge login chatgpt)",
    "challenge": "the site wants a human check. uibridge will not answer it for you - see "
                 "'Verification checks' in docs/PYTHON.md.",
    "rate_limited": "the site said 'too many requests'. Wait a few minutes, then send fewer requests at once.",
    "notice_blocking": "one of the site's own pop-ups kept covering the page. Retrying usually works.",
    "queue_full": "too many requests are already waiting. Send fewer at once.",
    "model_unverified": "uibridge could not confirm the model you asked for, so it refused rather than "
                        "risk a mislabelled answer. Retry, or pick another model id (uibridge.models()).",
    "model_not_applied": "the site would not switch to that model. Retry, or pick another model id.",
    "mode_not_applied": "the site would not switch that mode (e.g. thinking) on or off. Retry.",
    "invalid_response_format": "the answer did not match your schema. Nothing was repaired or guessed. "
                               "Retry, or make the schema simpler.",
    "idempotency_conflict": "that key was already used for a DIFFERENT question. Use a new key for a new question.",
    "outcome_unknown": "check the conversation in the browser before asking again. If you used key=..., "
                       "call uibridge.result(key) to fetch the saved answer.",
    "empty_response": "the site finished without writing anything. Asking again is reasonable.",
    "ui_contract": "the site's page changed in a way uibridge does not recognise yet. This needs a code "
                   "fix - keep this message.",
    "not_calibrated": "uibridge has not been taught how to do that on this provider.",
    "upload_failed": "the site refused the file. Check it opens, and that the site accepts that type.",
    "upload_not_registered": "the file never reached the page, so nothing was sent. Asking again is safe.",
    "timeout": "the site took longer than allowed. Asking again is reasonable for a long answer.",
    "request_timeout": "the whole request took longer than allowed (15 minutes by default).",
    "daemon_other_home": "a different uibridge (another state folder) owns this port. Stop it:  uibridge stop",
    "thread_unknown": "this machine has no record of that conversation id. Check you copied it correctly.",
    "browser_unavailable": "uibridge could not start or reach its browser. Try:  uibridge stop  then ask again.",
    "browser_gone": "the browser closed. Asking again will start a fresh one.",
}


def _from_http(err: urllib.error.HTTPError, key):
    try:
        payload = _json.loads(err.read() or b"{}")
    except Exception:
        payload = {}
    body = payload.get("error") if isinstance(payload, dict) else None
    body = body if isinstance(body, dict) else {}
    code = body.get("type") or f"http_{err.code}"
    message = body.get("message") or f"uibridge answered HTTP {err.code}"
    cls = _BY_CODE.get(code) or (InvalidRequest if err.code == 400 else BridgeError)
    return cls(message, code=code, status=err.code, retryable=bool(body.get("retryable")),
               detail=body.get("detail"), key=key, hint=_HINTS.get(code))


# ---------------------------------------------------------------------------
# Answer
# ---------------------------------------------------------------------------

class Answer:
    """One answer, plus uibridge's account of how it was obtained.

    `text` is the model's own words; `print(answer)` prints exactly that.
    Everything else describes the answer and never changes it. `raw` is the
    complete response, for any field not surfaced here.
    """

    def __init__(self, response: dict, key: str | None = None):
        self.raw = response
        self.key = key
        self._ub = response.get("_uibridge") or {}
        choice = (response.get("choices") or [{}])[0]
        self.text = (choice.get("message") or {}).get("content") or ""
        self.finish_reason = choice.get("finish_reason")

    def __str__(self):
        return self.text

    def __repr__(self):
        return f"<uibridge.Answer model={self.model!r} chars={len(self.text)} thread_id={self.thread_id!r}>"

    # --- identity ----------------------------------------------------------

    @property
    def model(self):
        """The model id you asked for."""
        return self.raw.get("model")

    @property
    def provider(self):
        return self._ub.get("provider")

    @property
    def thread_id(self):
        """The conversation's own id. Pass it back as `thread=` to continue it."""
        return self._ub.get("thread_id")

    @property
    def request_id(self):
        return self._ub.get("request_id")

    @property
    def elapsed_ms(self):
        return self._ub.get("elapsed_ms")

    @property
    def seconds(self):
        ms = self.elapsed_ms
        return None if ms is None else ms / 1000

    # --- derived from the text, never instead of it ------------------------

    @property
    def json(self):
        """The JSON in the answer, parsed - or None if it contains none.

        Without `schema=`/`json=True` this is a best-effort read of the first
        JSON the answer contains, and nothing checked its shape. With them,
        the daemon has already validated it, or raised.
        """
        return self._ub.get("json")

    @property
    def tables(self):
        """Markdown tables in the answer, as [{"header": [...], "rows": [...]}]."""
        return self._ub.get("tables") or []

    @property
    def code_blocks(self):
        return self._ub.get("code_blocks") or []

    @property
    def files(self):
        """Files the model GENERATED, already downloaded: [{"name", "path", "bytes", ...}]."""
        return self._ub.get("files") or []

    @property
    def citations(self):
        """ChatGPT only: each inline citation, with `at` (its character offset in text) and `url`."""
        return self._ub.get("citations") or []

    @property
    def sources(self):
        """Everything the turn consulted when it searched the web."""
        return self._ub.get("sources") or []

    # --- how far to trust it -----------------------------------------------

    @property
    def model_verified(self):
        """True when uibridge confirmed the page really used the model you asked for."""
        return ((self._ub.get("provenance") or {}).get("model") or {}).get("verified")

    @property
    def model_applied(self):
        """What the page itself said it was set to."""
        return ((self._ub.get("provenance") or {}).get("model") or {}).get("applied")

    @property
    def extraction(self):
        """How the text was read: 'wire', 'copy', 'dom-markdown' or 'rendered'."""
        return self._ub.get("extraction")

    @property
    def truncated(self):
        return bool(self._ub.get("truncated")) or self.finish_reason == "length"

    @property
    def suspect(self):
        """The answer OPENS like a failure message but matches no known one. Read it."""
        return bool(self._ub.get("provider_error_suspected"))

    @property
    def warnings(self):
        """Plain-English notes on anything about this answer worth a second look.

        Empty for an ordinary answer. Every note restates a field uibridge
        already reports; nothing here judges the answer's content.
        """
        ub = self._ub
        notes = []
        if self.truncated:
            notes.append("the answer was cut off before the site said it had finished")
        verified = self.model_verified
        if verified is False:
            notes.append(f"the model could not be confirmed: you asked for {self.model!r}, "
                         f"the page showed {self.model_applied!r}")
        elif verified is None and self.model in ("gemini", "chatgpt"):
            notes.append(f"{self.model!r} means whichever model the site had selected - "
                         "use a specific id such as 'gemini-pro' when it matters which model answered")
        if ub.get("provider_error_suspected"):
            notes.append("the answer opens like a failure message - read it before relying on it")
        extraction = ub.get("extraction")
        if extraction == "rendered":
            notes.append("the text was read off the screen, so table and code formatting were lost")
        elif extraction == "dom-markdown":
            notes.append("copying the answer failed, so its markdown was rebuilt from the page; "
                         "formatting may differ from the original")
        if ub.get("lossy_math"):
            notes.append("maths is rendered symbols, not LaTeX source")
        if ub.get("throttle_notice"):
            notes.append("the site was showing a 'too many requests' notice - slow down")
        unsupported = ub.get("unsupported_parameters") or []
        if unsupported:
            notes.append("ignored, because a chat UI has no setting for them: " + ", ".join(map(str, unsupported)))
        for f in self.files:
            if f.get("error"):
                notes.append(f"generated file {f.get('name')!r} could not be downloaded: {f['error']}")
        return notes


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class Client:
    """A connection to one uibridge daemon.

    You only need this for a non-default address or different timeouts; the
    module-level functions (uibridge.ask, ...) use a shared default Client.

        client = uibridge.Client("http://127.0.0.1:8477", timeout=600)
    """

    def __init__(self, url: str | None = None, *, timeout: float = 960.0, auto_start: bool = True):
        url = (url or os.environ.get("UIBRIDGE_URL") or DEFAULT_URL).rstrip("/")
        if url.endswith("/v1"):
            url = url[: -len("/v1")]
        self.url = url
        # Longer than the daemon's own 15-minute request budget, so a slow
        # answer arrives as the daemon's TYPED timeout rather than as a local
        # one that cannot say whether the prompt was sent.
        self.timeout = timeout
        self.auto_start = auto_start
        self._start_lock = threading.Lock()

    # --- plumbing ----------------------------------------------------------

    def _request(self, method, path, body=None, *, headers=None, timeout=None, key=None,
                 inference=False, _started=False):
        data = None if body is None else _json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.url + path, data=data, method=method,
            headers={"Content-Type": "application/json", **(headers or {})},
        )
        try:
            with _OPENER.open(request, timeout=timeout or self.timeout) as response:
                raw = response.read()
                return _json.loads(raw) if raw else None
        # HTTPError is a URLError, so it has to be caught first.
        except urllib.error.HTTPError as err:
            raise _from_http(err, key) from None
        except urllib.error.URLError as err:
            reason = getattr(err, "reason", None)
            if isinstance(reason, ConnectionRefusedError):
                # REFUSED means nothing was received: the request never reached
                # a daemon, so starting one and sending it again cannot post a
                # duplicate message.
                if self.auto_start and not _started:
                    self.start()
                    return self._request(method, path, body, headers=headers, timeout=timeout, key=key,
                                         inference=inference, _started=True)
                raise NotRunning(f"uibridge is not running at {self.url}.", code="daemon_not_running",
                                 hint="start it with:  uibridge serve   (or let this module start it: "
                                      "auto_start=True, the default)") from None
            if isinstance(reason, (TimeoutError, socket.timeout)):
                raise self._lost(timeout, key, inference) from None
            raise BridgeError(f"could not reach uibridge at {self.url}: {reason}", code="network",
                              retryable=True) from None
        except (TimeoutError, socket.timeout):
            raise self._lost(timeout, key, inference) from None
        except (ConnectionError, http.client.HTTPException) as err:
            if inference:
                raise self._lost(timeout, key, inference, cause=err) from None
            raise BridgeError(f"the connection to uibridge broke: {err}", code="network", retryable=True) from None

    def _lost(self, timeout, key, inference, cause=None):
        if not inference:
            return BridgeError(f"uibridge did not answer within {timeout or self.timeout:.0f}s.",
                               code="client_timeout", retryable=True)
        what = f"the connection failed ({cause})" if cause else \
            f"no answer arrived within {timeout or self.timeout:.0f}s and the wait was abandoned"
        hint = (f"the answer may still arrive - fetch it with:  uibridge.result({key!r})" if key else
                "check the conversation in the browser before asking again. Next time pass key='...' "
                "so a lost connection can be recovered instead of re-asked.")
        return OutcomeUnknown(f"{what}. The prompt may or may not have reached the site.",
                              code="outcome_unknown", key=key, hint=hint)

    # --- the daemon itself -------------------------------------------------

    def health(self, timeout: float = 3.0):
        """The daemon's health report, or None when nothing is answering."""
        try:
            with _OPENER.open(self.url + "/health", timeout=timeout) as response:
                return _json.loads(response.read())
        except Exception:
            return None

    def is_running(self) -> bool:
        return self.health() is not None

    def start(self, wait: float = 45.0) -> dict:
        """Start the uibridge daemon in the background, unless it is already up.

        It keeps running after this program ends, so later scripts reuse the
        same warm browser. Stop it with `uibridge stop`.
        """
        with self._start_lock:
            up = self.health()
            if up:
                return up
            exe, node = shutil.which("uibridge"), shutil.which("node")
            if not exe or not node:
                raise NotRunning(
                    "uibridge is not running, and it could not be started from here because the "
                    f"{'`uibridge`' if not exe else '`node`'} command is not on this machine's PATH.",
                    code="daemon_not_running",
                    hint="in the uibridge folder, run once:  npm install -g .   - or start it yourself:  uibridge serve")
            try:
                found = subprocess.run([exe, "paths", "--json"], capture_output=True, text=True,
                                       timeout=60, check=True)
                paths = _json.loads(found.stdout)
            except Exception as err:
                raise NotRunning(f"could not ask uibridge where it is installed: {err}",
                                 code="daemon_start_failed", hint="start it yourself:  uibridge serve") from None
            code_dir = paths["code"]
            log_path = paths.get("daemon_log") or os.path.join(paths["home"], ".uibridge", "daemon.log")
            os.makedirs(os.path.dirname(log_path), exist_ok=True)
            options = {"cwd": code_dir, "stdin": subprocess.DEVNULL}
            if os.name == "nt":
                # Its own process group, and no console: closing the terminal
                # that ran this script must not take the daemon with it.
                options["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                options["start_new_session"] = True
            with open(log_path, "ab") as log:
                # The same launch the CLI performs (src/core/client.mjs
                # ensureDaemon): node running this checkout's own entry point.
                subprocess.Popen([node, os.path.join(code_dir, "bin", "uibridge.mjs"), "serve"],
                                 stdout=log, stderr=log, **options)
            deadline = time.monotonic() + wait
            while time.monotonic() < deadline:
                time.sleep(0.5)
                up = self.health()
                if up:
                    return up
            raise NotRunning(f"uibridge did not come up within {wait:.0f}s. Its log is: {log_path}",
                             code="daemon_start_failed", hint="read the end of that log, or run  uibridge serve  "
                                                              "in a terminal to watch it start")

    # --- asking --------------------------------------------------------------

    def ask(self, prompt: str, model: str, *, thread: str | None = None, files=None,
            thinking: bool | None = None, schema: dict | None = None, json: bool = False,
            key: str | None = None, timeout: float | None = None) -> Answer:
        """Send one message and return the answer.

        prompt    what to say.
        model     which model - see uibridge.models(), e.g. "gemini-pro", "chatgpt-5.6-medium".
        thread    a previous answer's thread_id, to continue that conversation.
                  Leave it out to start a fresh conversation.
        files     a path, or a list of paths, to attach. Relative paths are
                  resolved from YOUR current folder.
        thinking  Gemini only: True/False to turn extended thinking on/off.
                  (ChatGPT's effort is part of the model id: -instant/-medium/-high.)
        schema    a JSON Schema the answer must match; answer.json is the result.
                  An answer that does not match raises instead of being repaired.
        json      True to require any valid JSON (no particular shape).
        key       a name for this exact request, e.g. "study-42-v1". With a key,
                  sending the same request again never posts a second message:
                  it returns the saved answer. See docs/PYTHON.md.
        timeout   seconds to wait, if not the client's default.
        """
        if not isinstance(prompt, str) or not prompt.strip():
            raise InvalidRequest("prompt must be a non-empty string", code="invalid_request")
        if not isinstance(model, str) or not model:
            raise InvalidRequest("model must be a model id such as 'gemini-pro' - see uibridge.models()",
                                 code="invalid_request")
        if schema is not None and json:
            raise InvalidRequest("pass either schema=... or json=True, not both", code="invalid_request")

        body = {"model": model, "messages": [{"role": "user", "content": prompt}]}
        if thread:
            body["thread_id"] = thread
        if files:
            if isinstance(files, (str, os.PathLike)):
                files = [files]
            # The DAEMON opens these files, and it runs in a different folder.
            # A relative path would be looked up there, not where you are.
            body["files"] = [os.path.abspath(os.fspath(f)) for f in files]
        if thinking is not None:
            body["modes"] = {"thinking": bool(thinking)}
        if schema is not None:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}}
        elif json:
            body["response_format"] = {"type": "json_object"}

        headers = {"Idempotency-Key": key} if key else None
        response = self._request("POST", "/v1/chat/completions", body, headers=headers,
                                 timeout=timeout, key=key, inference=True)
        return Answer(response, key=key)

    # --- keyed requests ------------------------------------------------------

    def result(self, key: str, *, timeout: float | None = None) -> Answer:
        """The saved answer for a request sent with key=. Waits if it is still running.

        Never sends anything to the site.
        """
        return Answer(self._request("GET", "/v1/requests/result", headers={"Idempotency-Key": key},
                                    timeout=timeout, key=key), key=key)

    def status(self, key: str) -> dict:
        """Where a keyed request is: running, completed, failed or cancelled."""
        return self._request("GET", "/v1/requests/status", headers={"Idempotency-Key": key}, timeout=30, key=key)

    def cancel(self, key: str) -> dict:
        """Stop a keyed request that is still running."""
        return self._request("POST", "/v1/requests/cancel", {}, headers={"Idempotency-Key": key},
                             timeout=30, key=key)

    # --- everything else -----------------------------------------------------

    def models(self) -> list:
        """Every model id you can pass as model=."""
        return [m["id"] for m in (self._request("GET", "/v1/models", timeout=30) or {}).get("data", [])]

    def export(self, provider: str, thread_id: str, *, files: bool = False, timeout: float | None = None) -> dict:
        """Every message of a conversation, in order, read back from the site.

        files=True also downloads every file the conversation generated.
        """
        return self._request("POST", "/v1/threads/export",
                             {"provider": provider, "thread_id": thread_id, "files": bool(files)},
                             timeout=timeout)

    def threads(self, provider: str | None = None):
        """Conversations this machine has a local record of."""
        return self._request("POST", "/v1/threads/list", {"provider": provider} if provider else {}, timeout=30)


# ---------------------------------------------------------------------------
# Module-level shortcuts, sharing one default Client
# ---------------------------------------------------------------------------

_default: Client | None = None
_default_lock = threading.Lock()


def _client() -> Client:
    global _default
    with _default_lock:
        if _default is None:
            _default = Client()
        return _default


def ask(prompt: str, model: str, **options) -> Answer:
    """Send one message and return the answer. See Client.ask for every option."""
    return _client().ask(prompt, model, **options)


def models() -> list:
    return _client().models()


def export(provider: str, thread_id: str, **options) -> dict:
    return _client().export(provider, thread_id, **options)


def threads(provider: str | None = None):
    return _client().threads(provider)


def result(key: str, **options) -> Answer:
    return _client().result(key, **options)


def status(key: str) -> dict:
    return _client().status(key)


def cancel(key: str) -> dict:
    return _client().cancel(key)


def health():
    return _client().health()


def is_running() -> bool:
    return _client().is_running()


def start(**options) -> dict:
    return _client().start(**options)
