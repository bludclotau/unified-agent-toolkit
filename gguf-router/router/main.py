import hmac
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import json
import yaml
import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

import db
from cleaner import clean_output
from persona_engine import apply
from tools.browser import redact
from tools.registry import run_tool, tool_catalog

BASE_DIR = Path(__file__).resolve().parent

with open(BASE_DIR / "config.yaml", encoding="utf-8") as fh:
    CONFIG = yaml.safe_load(fh)

with open(BASE_DIR / "personas.json", encoding="utf-8") as fh:
    PERSONAS = json.load(fh)

with open(BASE_DIR / "tasks.json", encoding="utf-8") as fh:
    TASKS = json.load(fh)

MODELS = CONFIG["models"]
DEFAULT_MODEL = "qwen"
REQUEST_TIMEOUT_S = 120
COOLDOWN_SECONDS = 2


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_schema()
    yield


app = FastAPI(title="gguf-router", lifespan=lifespan)


class RouteRequest(BaseModel):
    prompt: str
    persona: Optional[str] = None
    task: Optional[str] = None
    user_id: Optional[str] = "unknown"
    bot_name: Optional[str] = "discord"
    tool: Optional[str] = None
    args: Optional[dict] = None
    n_predict: Optional[int] = Field(default=256)
    max_tokens: Optional[int] = None
    stream: bool = False


def select_model(persona: Optional[str], task: Optional[str]) -> str:
    if persona:
        mapped = PERSONAS.get(persona) or PERSONAS.get(persona.lower())
        if mapped:
            return mapped
        if persona in MODELS or (persona and persona.lower() in MODELS):
            return persona if persona in MODELS else persona.lower()
    if task:
        mapped = TASKS.get(task) or TASKS.get(task.lower())
        if mapped:
            return mapped
        if task in MODELS or (task and task.lower() in MODELS):
            return task if task in MODELS else task.lower()
    return DEFAULT_MODEL


def extract_raw_text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    if not isinstance(payload, dict):
        return str(payload)

    for key in ("content", "reply", "text", "response"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value

    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            if isinstance(first.get("text"), str) and first["text"]:
                return first["text"]
            message = first.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                return message["content"]
    return json.dumps(payload)


def _browser_gate(name: Optional[str], request: Request) -> None:
    """Discord has no tool token. Keyhole sends the same bearer as the control API."""
    if not name or not str(name).startswith("browser_"):
        return
    expected = os.environ.get("TOOL_API_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=503, detail="TOOL_API_TOKEN is not configured")
    provided = request.headers.get("x-tool-token", "")
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        provided = provided or auth[7:].strip()
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health() -> dict[str, Any]:
    catalog = tool_catalog()
    return {"status": "router-ok", "tools": catalog["tools"], "browser": catalog["browser"]}


@app.get("/tools")
def tools() -> dict[str, Any]:
    return tool_catalog()


@app.get("/debug/login", response_class=HTMLResponse)
def debug_login():
    """Local login fixture. Not linked from Keyhole."""
    return """<!doctype html><html><head><title>Log in</title></head><body>
    <h1>Log in</h1>
    <form method="get" action="/debug/login/go">
      <input name="username" type="text">
      <input name="password" type="password">
      <button type="submit">Log in</button>
    </form>
    </body></html>"""


@app.get("/debug/login/go")
def debug_login_go(username: str = "", password: str = ""):
    if username == "wendy" and password == "snacktime":
        resp = RedirectResponse("/debug/secret", status_code=303)
        resp.set_cookie("fixture_auth", "wendy", httponly=True)
        return resp
    return HTMLResponse("<html><title>Log in</title><p>bad credentials</p></html>", status_code=401)


@app.get("/debug/secret", response_class=HTMLResponse)
def debug_secret(request: Request):
    if request.cookies.get("fixture_auth") != "wendy":
        return RedirectResponse("/debug/login", status_code=303)
    return "<html><title>Secret</title><h1>SECRET waffle-iron-42</h1></html>"


@app.post("/tool")
def tool(payload: dict, request: Request) -> Any:
    name = payload.get("tool")
    args = payload.get("args", {}) or {}
    user_id = payload.get("user_id", "unknown")
    bot_name = payload.get("bot_name", "discord")
    persona = payload.get("persona") or bot_name or "default"
    _browser_gate(name, request)

    result = run_tool(name, args, persona=persona)
    safe = redact(result)
    db.async_write(db.save_raw_output, f"tool:{user_id}:{name}", str(safe))
    db.log_tool(user_id, name, str(safe))
    return {"result": safe, "user_id": user_id, "bot_name": bot_name, "persona": persona}


@app.post("/route")
def route(payload: RouteRequest, request: Request) -> Any:
    prompt = payload.prompt
    persona = payload.persona
    task = payload.task
    user_id = payload.user_id or "unknown"
    bot_name = payload.bot_name or "discord"

    if db.check_cooldown(user_id):
        return {"clean": "Cooldown active.", "raw": None}

    tool_name = payload.tool
    tool_result = None
    if tool_name:
        _browser_gate(tool_name, request)
        tool_result = run_tool(tool_name, payload.args or {}, persona=persona or bot_name)
        safe_tool = redact(tool_result)
        db.async_write(db.save_raw_output, f"tool:{user_id}:{tool_name}", str(safe_tool))
        db.log_tool(user_id, tool_name, str(safe_tool))
        tool_result = safe_tool

    final_prompt, model = apply(
        persona,
        task,
        prompt,
        user_id,
        tool=tool_name,
        tool_result=tool_result,
    )
    endpoint = MODELS.get(model, MODELS["qwen"])

    if model == "qwen":
        try:
            requests.get("http://10.1.1.122:8081/health", timeout=2)
        except Exception:
            model = "dolphin"
            endpoint = MODELS["dolphin"]

    n_predict = payload.n_predict if payload.n_predict is not None else payload.max_tokens
    if n_predict is None:
        n_predict = 256

    try:
        r = requests.post(
            endpoint,
            json={"prompt": final_prompt, "n_predict": n_predict},
            timeout=120,
        )
        r.raise_for_status()
        raw = r.json().get("content", "")
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"{model} request failed: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"{model} returned non-JSON") from exc

    db.async_write(db.save_raw_output, f"raw:{user_id}", raw)
    clean = clean_output(raw)
    db.async_write(db.update_conversation, user_id, bot_name, persona, task, clean)
    db.set_cooldown(user_id, COOLDOWN_SECONDS)

    return {
        "clean": clean,
        "raw": raw,
        "content": clean,
        "reply": clean,
        "model": model,
        "persona": persona,
        "task": task,
        "user_id": user_id,
        "bot_name": bot_name,
    }
