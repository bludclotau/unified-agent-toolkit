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


def persist_login(persona: str, origin: str, payload: dict) -> None:
    import db

    db.upsert_credential(persona, origin, payload)


def fetch_login(persona: str, url: str):
    import db

    return db.get_credential(persona, url)


def retire_plaintext(persona: str) -> None:
    path = _login_path(persona)
    if path.is_file():
        path.unlink()


def save_login(persona: str, url: str, username: str, password: str) -> str:
    origin = origin_of(url)
    persist_login(
        persona,
        origin,
        {"username": username, "password": password, "login_url": url},
    )
    retire_plaintext(persona)
    return origin


def load_login(persona: str, url: str):
    data = fetch_login(persona, url)
    if isinstance(data, dict) and data.get("password"):
        return data
    return None


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


def _refs_from_snapshot(text: str):
    user = password = submit = None
    for line in (text or "").splitlines():
        if "ref=" not in line:
            continue
        ref = line.split("ref=")[1].split("]")[0].split(",")[0].strip()
        if not ref.startswith("@"):
            ref = f"@{ref}"
        low = line.lower()
        if "password" in low and password is None:
            password = ref
        elif "button" in low or "submit" in low:
            submit = ref
        elif "textbox" in low or "input" in low:
            if user is None:
                user = ref
            elif password is None:
                password = ref
    return user, password, submit


def browser_login(persona, url, username, username_ref=None, password_ref=None, submit_ref=None, password=None, browser=None):
    try:
        target = check_url(url)
        user = check_text(username, limit=200)
        user_ref = check_ref(username_ref) if username_ref else None
        pass_ref = check_ref(password_ref) if password_ref else None
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

    runner = browser or AgentBrowser()
    commands = []
    # Refs from an earlier snapshot belong to the page already open.
    # Opening again renumbers them.
    if not (user_ref and pass_ref):
        opened = runner.sequence(persona, [["open", target], ["snapshot"]])
        if not opened.get("ok"):
            opened["stored"] = True
            opened["origin"] = origin
            return redact(opened)
        found_user, found_pass, found_submit = _refs_from_snapshot(opened.get("stdout") or "")
        user_ref = user_ref or found_user
        pass_ref = pass_ref or found_pass
        submit = submit or found_submit
        if not user_ref or not pass_ref:
            return {"ok": False, "stored": True, "origin": origin, "error": "login fields were not in the snapshot"}
    commands.extend([
        ["fill", user_ref, user],
        ["fill", pass_ref, secret],
    ])
    commands.append(["click", submit] if submit else ["press", "Enter"])
    result = runner.sequence(persona, commands)
    result["origin"] = origin
    result["stored"] = True
    if not result.get("ok"):
        failed = next((step for step in result.get("steps") or [] if not step.get("ok")), {})
        result["error"] = failed.get("stderr") or failed.get("stdout") or "browser login failed"
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


def _has_child(root: Path, prefix: str) -> bool:
    try:
        return any(path.name.startswith(prefix) for path in root.iterdir())
    except OSError:
        return False


def binary_status() -> dict:
    binary = os.environ.get("AGENT_BROWSER_BIN", "agent-browser")
    path = binary if os.path.isabs(binary) else None
    if path is None:
        for directory in os.environ.get("PATH", "").split(os.pathsep):
            candidate = os.path.join(directory, binary)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                path = candidate
                break
    home = Path(os.environ.get("HOME", "/home/wendy"))
    chrome = _has_child(home / ".agent-browser" / "browsers", "chrome-")
    chromium_root = home / ".cache" / "ms-playwright"
    chromium = _has_child(chromium_root, "chromium-")
    clone = Path(os.environ.get(
        "BROWSER_AGENT_DIR",
        "/home/wendy/waffle_house/integrations/browser-agent",
    ))
    package = (clone / "node_modules" / "playwright").is_dir()
    return {
        "binary": binary,
        "path": path,
        "chrome": chrome,
        "ready": bool(path) and chrome,
        "browser_agent": {
            "chromium": chromium,
            "package": package,
            "ready": chromium and package,
            "primary": False,
        },
    }
