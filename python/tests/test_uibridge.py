"""
Offline tests for the Python client.

Each run starts its OWN throwaway uibridge daemon, in a temporary state folder,
on a free port, with the scripted `echo` provider - no browser, no network, no
subscription spent. The user's real daemon on 8477 is never contacted.

    python -m unittest discover -s python/tests -v

The echo provider is steered by `@@directives` in the prompt (see
src/providers/echo/index.mjs): `@@json`, `@@table`, `@@file=name`,
`@@throw=code @@status=N`, `@@sleep=ms`, `@@truncated`, ...
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "python"))
import uibridge  # noqa: E402


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class EchoDaemon(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = Path(tempfile.mkdtemp(prefix="uibridge-py-"))
        cls.port = free_port()
        (cls.home / "config.json").write_text(json.dumps({"port": cls.port, "defaultProvider": "echo"}))
        env = {**os.environ, "UIBRIDGE_HOME": str(cls.home), "UIBRIDGE_TEST_PROVIDER": "1"}
        cls.log = open(cls.home / "daemon.log", "wb")
        cls.proc = subprocess.Popen([shutil.which("node"), str(REPO / "bin" / "uibridge.mjs"), "serve"],
                                    cwd=str(REPO), env=env, stdout=cls.log, stderr=cls.log)
        cls.url = f"http://127.0.0.1:{cls.port}"
        # auto_start=False: a test must never start the user's REAL daemon.
        cls.client = uibridge.Client(cls.url, auto_start=False, timeout=60)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if cls.client.health():
                break
            if cls.proc.poll() is not None:
                cls.log.flush()
                raise RuntimeError("the test daemon exited:\n" + (cls.home / "daemon.log").read_text(errors="replace"))
            time.sleep(0.2)
        else:
            raise RuntimeError("the test daemon never came up")
        # Point the module-level shortcuts at the throwaway daemon too.
        cls._saved_default = uibridge._default
        uibridge._default = cls.client

    @classmethod
    def tearDownClass(cls):
        uibridge._default = cls._saved_default
        try:
            urllib.request.urlopen(urllib.request.Request(cls.url + "/admin/shutdown", data=b"{}",
                                                          headers={"Content-Type": "application/json"}), timeout=5)
        except Exception:
            pass
        try:
            cls.proc.wait(10)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
            cls.proc.wait(5)
        cls.log.close()
        shutil.rmtree(cls.home, ignore_errors=True)

    # --- the basic promise ---------------------------------------------------

    def test_the_text_comes_back_exactly(self):
        prompt = "exact bytes: café · naïve · 42 | pipes \\ and backslashes"
        answer = self.client.ask(prompt, model="echo-fast")
        self.assertEqual(answer.text, prompt)
        self.assertEqual(str(answer), prompt, "print(answer) must print the text itself")
        self.assertTrue(answer.thread_id)
        self.assertEqual(answer.model, "echo-fast")
        self.assertIn("echo-fast", repr(answer))

    def test_module_level_ask(self):
        self.assertEqual(uibridge.ask("via the shortcut", model="echo-fast").text, "via the shortcut")

    def test_models_lists_what_can_be_asked(self):
        self.assertIn("echo-fast", self.client.models())

    def test_a_conversation_continues_in_the_same_thread(self):
        first = self.client.ask("turn one", model="echo-fast")
        second = self.client.ask("turn two", model="echo-fast", thread=first.thread_id)
        self.assertEqual(second.thread_id, first.thread_id)

    def test_export_reads_the_conversation_back(self):
        first = self.client.ask("first message to export", model="echo-fast")
        self.client.ask("second message to export", model="echo-fast", thread=first.thread_id)
        doc = self.client.export("echo", first.thread_id)
        said = [m["text"] for m in doc["messages"] if m["role"] == "user"]
        self.assertEqual(said, ["first message to export", "second message to export"])

    # --- derived fields ------------------------------------------------------

    def test_json_in_an_answer_is_parsed(self):
        self.assertEqual(self.client.ask("@@json hi", model="echo-fast").json, {"ok": True, "echo": "hi"})

    def test_a_schema_is_enforced_by_the_daemon(self):
        schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
        answer = self.client.ask("@@json structured", model="echo-fast", schema=schema)
        self.assertIs(answer.json["ok"], True)

    def test_an_answer_that_breaks_the_schema_raises_instead_of_being_repaired(self):
        schema = {"type": "object", "properties": {"missing": {"type": "string"}}, "required": ["missing"]}
        with self.assertRaises(uibridge.BridgeError) as caught:
            self.client.ask("@@json structured", model="echo-fast", schema=schema)
        self.assertEqual(caught.exception.code, "invalid_response_format")
        self.assertIn("schema", caught.exception.hint)

    def test_json_true_requires_valid_json(self):
        with self.assertRaises(uibridge.BridgeError) as caught:
            self.client.ask("plain prose, not json", model="echo-fast", json=True)
        self.assertEqual(caught.exception.code, "invalid_response_format")

    def test_schema_and_json_together_is_refused_locally(self):
        with self.assertRaises(uibridge.InvalidRequest):
            self.client.ask("x", model="echo-fast", schema={"type": "object"}, json=True)

    def test_tables_are_parsed(self):
        self.assertEqual(self.client.ask("@@table", model="echo-fast").tables[0]["header"], ["a", "b"])

    # --- files -----------------------------------------------------------------

    def test_a_relative_file_path_means_relative_to_the_caller(self):
        # The daemon runs in the repository folder. If the client passed the
        # path through unresolved, the daemon would look for it there.
        folder = Path(tempfile.mkdtemp(prefix="uibridge-py-files-"))
        (folder / "notes.txt").write_text("attached")
        before = os.getcwd()
        os.chdir(folder)
        try:
            answer = self.client.ask("read the attachment", model="echo-fast", files="notes.txt")
        finally:
            os.chdir(before)
            shutil.rmtree(folder, ignore_errors=True)
        self.assertEqual(answer.text, "read the attachment")

    def test_a_missing_file_is_refused_before_anything_is_sent(self):
        with self.assertRaises(uibridge.InvalidRequest) as caught:
            self.client.ask("x", model="echo-fast", files=["definitely-not-here.pdf"])
        self.assertEqual(caught.exception.status, 400)

    def test_a_generated_file_arrives_on_disk(self):
        answer = self.client.ask("@@file=out.csv make a file", model="echo-fast")
        self.assertEqual(len(answer.files), 1)
        self.assertTrue(Path(answer.files[0]["path"]).is_file())

    # --- errors are typed, and say what to do ----------------------------------

    def test_an_unknown_model_is_an_invalid_request(self):
        with self.assertRaises(uibridge.InvalidRequest) as caught:
            self.client.ask("x", model="no-such-model")
        self.assertEqual(caught.exception.status, 400)

    def test_signed_out_is_its_own_type_with_the_fix(self):
        with self.assertRaises(uibridge.SignedOut) as caught:
            self.client.ask("@@throw=signed_out @@status=401 x", model="echo-fast")
        self.assertIn("uibridge login", str(caught.exception))

    def test_a_challenge_is_its_own_type(self):
        with self.assertRaises(uibridge.Challenge):
            self.client.ask("@@throw=challenge @@status=503 x", model="echo-fast")

    def test_retryable_is_carried_through(self):
        with self.assertRaises(uibridge.BridgeError) as caught:
            self.client.ask("@@throw=rate_limited @@status=429 @@retryable=true x", model="echo-fast")
        self.assertEqual(caught.exception.code, "rate_limited")
        self.assertIs(caught.exception.retryable, True)

    def test_a_lost_connection_is_outcome_unknown_not_a_plain_timeout(self):
        # The single most important safety property: a caller must not be
        # told "timeout" and left to assume nothing was sent.
        impatient = uibridge.Client(self.url, auto_start=False, timeout=1)
        with self.assertRaises(uibridge.OutcomeUnknown) as caught:
            impatient.ask("@@sleep=4000 slow", model="echo-fast")
        self.assertIn("key=", caught.exception.hint)

    def test_nothing_listening_is_not_running(self):
        with self.assertRaises(uibridge.NotRunning):
            uibridge.Client(f"http://127.0.0.1:{free_port()}", auto_start=False).models()

    # --- keys: asking again never posts a second message -----------------------

    def test_the_same_key_returns_the_same_saved_answer(self):
        first = self.client.ask("keyed question", model="echo-fast", key="py-test-same-key")
        again = self.client.ask("keyed question", model="echo-fast", key="py-test-same-key")
        self.assertEqual(again.raw["id"], first.raw["id"], "a replay must be the saved response, not a new turn")
        self.assertEqual(self.client.result("py-test-same-key").raw["id"], first.raw["id"])
        self.assertEqual(self.client.status("py-test-same-key")["state"], "completed")

    def test_reusing_a_key_for_a_different_question_is_refused(self):
        self.client.ask("question A", model="echo-fast", key="py-test-conflict")
        with self.assertRaises(uibridge.BridgeError) as caught:
            self.client.ask("question B", model="echo-fast", key="py-test-conflict")
        self.assertEqual(caught.exception.code, "idempotency_conflict")

    def test_a_timed_out_keyed_request_can_be_recovered_without_re_asking(self):
        impatient = uibridge.Client(self.url, auto_start=False, timeout=1)
        with self.assertRaises(uibridge.OutcomeUnknown) as caught:
            impatient.ask("@@sleep=2500 recover me", model="echo-fast", key="py-test-recover")
        self.assertEqual(caught.exception.key, "py-test-recover")
        recovered = self.client.result("py-test-recover")
        self.assertEqual(recovered.text, "recover me")

    # --- warnings restate the envelope, in words -------------------------------

    def test_an_ordinary_answer_has_no_warnings(self):
        self.assertEqual(self.client.ask("ordinary", model="echo-fast").warnings, [])

    def test_a_truncated_answer_says_so(self):
        answer = self.client.ask("@@truncated cut short", model="echo-fast")
        self.assertTrue(answer.truncated)
        self.assertTrue(any("cut off" in w for w in answer.warnings))

    def test_a_suspect_answer_says_so(self):
        answer = self.client.ask("@@suspect", model="echo-fast")
        self.assertTrue(answer.suspect)
        self.assertTrue(any("failure message" in w for w in answer.warnings))


if __name__ == "__main__":
    unittest.main()
