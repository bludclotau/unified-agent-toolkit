import json
import os
import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet

import cred_crypto
from tools.browser import (
    browser_login,
    browser_read,
    check_url,
    execute,
    redact,
    save_login,
    session_name,
)
from tools.grammar import PLAN_TOOLS, TOOL_GRAMMAR
from tools.planner import plan
from tools.registry import TOOL_REGISTRY, run_tool


class BrowserToolTests(unittest.TestCase):
    def test_session_name_is_persona_scoped(self):
        self.assertEqual(session_name("Wendy"), "gguf-wendy")
        self.assertEqual(session_name("tabatha"), session_name("Tabatha"))
        self.assertNotEqual(session_name("wendy"), session_name("gumbo"))

    def test_urls_reject_credentials_and_other_schemes(self):
        self.assertEqual(check_url("https://example.com/a"), "https://example.com/a")
        with self.assertRaises(ValueError):
            check_url("file:///etc/passwd")
        with self.assertRaises(ValueError):
            check_url("https://user:secret@example.com")

    def test_login_password_is_not_returned(self):
        calls = []

        def runner(args, timeout):
            calls.append(args)
            return {"code": 0, "stdout": "ok", "stderr": ""}

        stored = {}

        def persist(persona, origin, payload):
            stored["persona"] = persona
            stored["origin"] = origin
            stored["payload"] = payload

        from tools import browser as browser_mod
        from tools.browser import AgentBrowser
        original = browser_mod.persist_login
        browser_mod.persist_login = persist
        try:
            with tempfile.TemporaryDirectory() as directory:
                os.environ["BROWSER_CRED_DIR"] = directory
                result = browser_login(
                    "wendy",
                    "https://example.com/login",
                    "ada",
                    "@e1",
                    "@e2",
                    "@e3",
                    password="s3cret",
                    browser=AgentBrowser(run=runner),
                )
                self.assertFalse((Path(directory) / "gguf-wendy" / "logins.json").exists())
        finally:
            browser_mod.persist_login = original
        self.assertTrue(result["ok"])
        self.assertNotIn("s3cret", json.dumps(result))
        self.assertEqual(stored["payload"]["password"], "s3cret")
        self.assertEqual(stored["origin"], "https://example.com")

    def test_fernet_blob_hides_the_password(self):
        os.environ["CREDENTIALS_KEY"] = Fernet.generate_key().decode()
        cred_crypto.reset_for_tests()
        blob = cred_crypto.encrypt_payload({"username": "wendy", "password": "snacktime"})
        self.assertTrue(blob.startswith("enc:v1:"))
        self.assertNotIn("snacktime", blob)
        self.assertEqual(cred_crypto.decrypt_blob(blob)["password"], "snacktime")

    def test_read_opens_then_snapshots(self):
        calls = []

        def runner(args, timeout):
            calls.append(args)
            return {"code": 0, "stdout": "SNAPSHOT", "stderr": ""}

        from tools.browser import AgentBrowser
        result = browser_read("wendy", "https://example.com", browser=AgentBrowser(run=runner))
        self.assertTrue(result["ok"])
        argv = [call[4:] for call in calls]
        self.assertEqual(argv[0], ["open", "https://example.com"])
        self.assertEqual(argv[1], ["snapshot"])
        self.assertEqual(calls[0][1:4], ["--session", "gguf-wendy", "--restore"])

    def test_web_fetch_drops_persona(self):
        seen = {}

        def fake(url):
            seen["url"] = url
            return {"ok": True}

        original = TOOL_REGISTRY["web_fetch"]
        TOOL_REGISTRY["web_fetch"] = fake
        try:
            result = run_tool("web_fetch", {"url": "https://example.com", "persona": "wendy"})
        finally:
            TOOL_REGISTRY["web_fetch"] = original
        self.assertEqual(result["ok"], True)
        self.assertEqual(seen["url"], "https://example.com")

    def test_planner_stops_on_done_without_a_browser(self):
        def infer(_prompt):
            return '{"tool":"done","args":{"text":"heading found"}}'

        result = plan("wendy", "read the heading", complete_fn=infer, execute_fn=lambda *a, **k: {"ok": True})
        self.assertTrue(result["ok"])
        self.assertEqual(result["final"], "heading found")
        self.assertEqual(result["steps"], [])

    def test_planner_runs_one_browser_tool_then_stops(self):
        replies = iter([
            '{"tool":"browser_goto","args":{"url":"https://example.com"}}',
            '{"tool":"done","args":{"text":"done"}}',
        ])
        seen = []

        def infer(_prompt):
            return next(replies)

        def act(persona, name, args):
            seen.append((persona, name, args))
            return {"ok": True, "stdout": "opened"}

        result = plan("gumbo", "open example", max_steps=3, complete_fn=infer, execute_fn=act)
        self.assertTrue(result["ok"])
        self.assertEqual(seen, [("gumbo", "browser_goto", {"url": "https://example.com"})])

    def test_grammar_lists_the_planner_tools_and_not_login(self):
        for name in PLAN_TOOLS:
            self.assertIn(f'\\"{name}\\"', TOOL_GRAMMAR)
        self.assertNotIn("browser_login", TOOL_GRAMMAR)

    def test_redact_and_execute_reject_bad_refs(self):
        self.assertEqual(redact({"password": "nope", "url": "https://a"})["password"], "***")
        result = execute("wendy", "browser_click", {"ref": "button; rm"})
        self.assertFalse(result["ok"])

    def test_saved_login_roundtrip_without_repeating_the_password_to_the_model(self):
        from tools import browser as browser_mod
        captured = {}

        def persist(persona, origin, payload):
            captured["payload"] = payload
            captured["origin"] = origin

        original = browser_mod.persist_login
        browser_mod.persist_login = persist
        try:
            with tempfile.TemporaryDirectory() as directory:
                os.environ["BROWSER_CRED_DIR"] = directory
                origin = save_login("wendy", "https://example.com/in", "ada", "hidden")
                self.assertFalse(list(Path(directory).rglob("logins.json")))
        finally:
            browser_mod.persist_login = original
        self.assertEqual(origin, "https://example.com")
        self.assertEqual(captured["payload"]["password"], "hidden")


if __name__ == "__main__":
    unittest.main()
