"""Persona-scoped browser tools.

agent-browser is the executor. One `--session` per persona, with `--restore`,
so cookies survive later tool calls. browser-use is not imported here.
"""

import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse

HTTP_SCHEMES = {"http", "https"}
REF_RE = re.compile(r"^@?[A-Za-z][A-Za-z0-9_:-]{0,63}$")
KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+_-]{0,24}$")
SECRET_KEYS = {"password", "token", "secret", "api_key", "authorization"}


def session_name(persona: str) -> str:
    raw = (persona or "default").strip().lower()
    cleaned = re.sub(r"[^a-z0-9_-]", "-", raw).strip("-") or "default"
    return "gguf-" + cleaned[:40]


def check_url(url: str) -> str:
    if not isinstance(url, str) or not url.strip():
        raise ValueError("url is required")
    parsed = urlparse(url.strip())
    if parsed.scheme not in HTTP_SCHEMES or not parsed.netloc:
        raise ValueError("url must be http or https")
    if parsed.username or parsed.password:
        raise ValueError("url must not contain credentials")
    return url.strip()


def check_ref(ref: str) -> str:
    if not isinstance(ref, str) or not REF_RE.match(ref.strip()):
        raise ValueError("ref must be an @ref such as @e1")
    ref = ref.strip()
    return ref if ref.startswith("@") else f"@{ref}"


def check_text(text: str, limit: int = 4000) -> str:
    if not isinstance(text, str):
        raise ValueError("text is required")
    if "\x00" in text or "\n" in text or "\r" in text:
        raise ValueError("text must be a single line")
    text = text.strip()
    if not text:
        raise ValueError("text is required")
    if len(text) > limit:
        raise ValueError("text is too long")
    return text


def check_key(key: str) -> str:
    if not isinstance(key, str) or not KEY_RE.match(key.strip()):
        raise ValueError("key is not allowed")
    return key.strip()


def redact(value):
    if isinstance(value, dict):
        return {
            key: ("***" if str(key).lower() in SECRET_KEYS else redact(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def cred_root() -> Path:
    return Path(os.environ.get("BROWSER_CRED_DIR", "/var/lib/gguf-router/browser-creds"))


def _login_path(persona: str) -> Path:
    return cred_root() / session_name(persona) / "logins.json"


def origin_of(url: str) -> str:
    parsed = urlparse(check_url(url))
    return f"{parsed.scheme}://{parsed.netloc}"


def save_login(persona: str, url: str, username: str, password: str) -> str:
    origin = origin_of(url)
    path = _login_path(persona)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {}
    if not isinstance(data, dict):
        data = {}
    data[origin] = {"username": username, "password": password}
    path.write_text(json.dumps(data), encoding="utf-8")
    os.chmod(path, 0o600)
    return origin


def load_login(persona: str, url: str):
    path = _login_path(persona)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    row = data.get(origin_of(url)) if isinstance(data, dict) else None
    if not isinstance(row, dict) or not row.get("password"):
        return None
    return row


class AgentBrowser:
    def __init__(self, binary=None, run=None, timeout=45):
        self.binary = binary or os.environ.get("AGENT_BROWSER_BIN", "agent-browser")
        self.timeout = timeout
        self._run = run or self._subprocess

    def _subprocess(self, args, timeout):
        try:
            proc = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except FileNotFoundError:
            return {"code": 127, "stdout": "", "stderr": f"{self.binary} is not on PATH"}
        except subprocess.TimeoutExpired:
            return {"code": 124, "stdout": "", "stderr": "timed out"}
        return {
            "code": proc.returncode,
            "stdout": (proc.stdout or "")[-8000:],
            "stderr": (proc.stderr or "")[-4000:],
        }

    def command(self, persona: str, argv: list, timeout=None):
        session = session_name(persona)
        result = self._run(
            [self.binary, "--session", session, "--restore", *argv],
            timeout or self.timeout,
        )
        return {
            "ok": result.get("code") == 0,
            "session": session,
            "argv": argv,
            "code": result.get("code"),
            "stdout": (result.get("stdout") or "").strip(),
            "stderr": (result.get("stderr") or "").strip(),
        }

    def sequence(self, persona: str, commands: list):
        steps = []
        for argv in commands:
            step = self.command(persona, argv)
            steps.append(step)
            if not step["ok"]:
                return {"ok": False, "session": session_name(persona), "steps": steps}
        text = "\n".join(step["stdout"] for step in steps if step["stdout"]).strip()
        return {"ok": True, "session": session_name(persona), "stdout": text, "steps": steps}


def _fail(exc: Exception) -> dict:
    return {"ok": False, "error": str(exc)}


def browser_goto(persona, url, browser=None):
    try:
        target = check_url(url)
    except ValueError as exc:
        return _fail(exc)
    return (browser or AgentBrowser()).sequence(persona, [["open", target]])


def browser_read(persona, url=None, browser=None):
    commands = []
    try:
        if url:
            commands.append(["open", check_url(url)])
    except ValueError as exc:
        return _fail(exc)
    commands.append(["snapshot"])
    commands.append(["read"])
    return (browser or AgentBrowser()).sequence(persona, commands)


def browser_click(persona, ref, browser=None):
    try:
        target = check_ref(ref)
    except ValueError as exc:
        return _fail(exc)
    return (browser or AgentBrowser()).sequence(persona, [["click", target]])


def browser_type(persona, ref, text, browser=None):
    try:
        commands = [["fill", check_ref(ref), check_text(text)]]
    except ValueError as exc:
        return _fail(exc)
    return (browser or AgentBrowser()).sequence(persona, commands)


def browser_submit(persona, ref=None, browser=None):
    try:
        argv = ["click", check_ref(ref)] if ref else ["press", "Enter"]
    except ValueError as exc:
        return _fail(exc)
    return (browser or AgentBrowser()).sequence(persona, [argv])


def browser_close(persona, browser=None):
    return (browser or AgentBrowser()).sequence(persona, [["close"]])


def browser_login(persona, url, username, username_ref, password_ref, submit_ref=None, password=None, browser=None):
    try:
        target = check_url(url)
        user = check_text(username, limit=200)
        user_ref = check_ref(username_ref)
        pass_ref = check_ref(password_ref)
        submit = check_ref(submit_ref) if submit_ref else None
    except ValueError as exc:
        return _fail(exc)

    secret = password
    if secret:
        try:
            secret = check_text(secret, limit=500)
        except ValueError as exc:
            return _fail(exc)
        try:
            origin = save_login(persona, target, user, secret)
        except OSError as exc:
            return {"ok": False, "error": f"could not store login: {exc}"}
    else:
        stored = load_login(persona, target)
        if not stored:
            return {"ok": False, "error": "no stored login for this origin"}
        secret = stored["password"]
        origin = origin_of(target)

    commands = [
        ["open", target],
        ["fill", user_ref, user],
        ["fill", pass_ref, secret],
    ]
    if submit:
        commands.append(["click", submit])
    else:
        commands.append(["press", "Enter"])
    result = (browser or AgentBrowser()).sequence(persona, commands)
    result["origin"] = origin
    result["stored"] = True
    result.pop("steps", None)
    return redact(result)


def execute(persona, name, args, browser=None):
    args = dict(args or {})
    if name == "browser_goto":
        return browser_goto(persona, args.get("url"), browser=browser)
    if name == "browser_read":
        return browser_read(persona, args.get("url"), browser=browser)
    if name == "browser_click":
        return browser_click(persona, args.get("ref"), browser=browser)
    if name == "browser_type":
        return browser_type(persona, args.get("ref"), args.get("text"), browser=browser)
    if name == "browser_submit":
        return browser_submit(persona, args.get("ref"), browser=browser)
    if name == "browser_close":
        return browser_close(persona, browser=browser)
    if name == "browser_login":
        return browser_login(
            persona,
            args.get("url"),
            args.get("username"),
            args.get("username_ref"),
            args.get("password_ref"),
            args.get("submit_ref"),
            args.get("password"),
            browser=browser,
        )
    return {"ok": False, "error": f"unknown browser tool {name}"}


def binary_status() -> dict:
    binary = os.environ.get("AGENT_BROWSER_BIN", "agent-browser")
    path = binary if os.path.isabs(binary) else None
    if path is None:
        for directory in os.environ.get("PATH", "").split(os.pathsep):
            candidate = os.path.join(directory, binary)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                path = candidate
                break
    return {"binary": binary, "path": path, "ready": bool(path)}
