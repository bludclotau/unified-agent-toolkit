"""One GBNF-constrained tool call per step, executed on the persona session."""

import json
from pathlib import Path

import requests
import yaml

from tools.browser import execute, redact
from tools.grammar import PLAN_TOOLS, TOOL_GRAMMAR

BASE_DIR = Path(__file__).resolve().parent.parent
MAX_STEPS = 6


def _endpoint() -> str:
    with open(BASE_DIR / "config.yaml", encoding="utf-8") as handle:
        config = yaml.safe_load(handle) or {}
    models = config.get("models") or {}
    return models.get("qwen") or "http://10.1.1.122:8081/completion"


def complete(prompt: str, timeout: int = 90) -> str:
    response = requests.post(
        _endpoint(),
        json={
            "prompt": prompt,
            "n_predict": 180,
            "temperature": 0,
            "grammar": TOOL_GRAMMAR,
        },
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    return (payload.get("content") or "").strip()


def _prompt(persona: str, goal: str, steps: list) -> str:
    history = json.dumps(redact(steps), ensure_ascii=False)[:6000]
    names = ", ".join(PLAN_TOOLS)
    return (
        f"You are the browser planner for persona {persona}.\n"
        f"Goal: {goal}\n"
        f"Allowed tools: {names}.\n"
        "Use browser_read before click, type, or submit. "
        "When the goal is finished, call done with args text set to a short answer.\n"
        f"Previous steps: {history}\n"
        "Reply with one JSON object.\n"
        "Assistant:"
    )


def _parse(raw: str) -> dict:
    try:
        call = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"planner returned non-JSON: {raw[:180]}") from exc
    tool = call.get("tool")
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    if tool not in PLAN_TOOLS:
        raise ValueError(f"planner chose {tool}")
    return {"tool": tool, "args": args}


def plan(persona, goal, max_steps=4, complete_fn=None, execute_fn=None):
    if not isinstance(goal, str) or not goal.strip():
        return {"ok": False, "error": "goal is required"}
    try:
        steps_allowed = int(max_steps)
    except (TypeError, ValueError):
        return {"ok": False, "error": "max_steps must be an integer"}
    steps_allowed = max(1, min(steps_allowed, MAX_STEPS))
    infer = complete_fn or complete
    act = execute_fn or execute
    trace = []
    for _ in range(steps_allowed):
        try:
            raw = infer(_prompt(persona, goal.strip(), trace))
            call = _parse(raw)
        except (requests.RequestException, ValueError) as exc:
            return {"ok": False, "error": str(exc), "steps": trace}
        if call["tool"] == "done":
            return {
                "ok": True,
                "final": str(call["args"].get("text") or ""),
                "steps": trace,
            }
        result = act(persona, call["tool"], call["args"])
        trace.append({
            "tool": call["tool"],
            "args": redact(call["args"]),
            "ok": bool(result.get("ok")) if isinstance(result, dict) else False,
            "output": (result.get("stdout") or result.get("error") or "")[:2000]
            if isinstance(result, dict) else "",
        })
        if isinstance(result, dict) and not result.get("ok"):
            return {"ok": False, "error": result.get("error") or "tool failed", "steps": trace}
    return {"ok": False, "error": "max steps", "steps": trace}
