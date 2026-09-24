import inspect

from tools.browser import binary_status, execute
from tools.planner import plan
from tools.web import fetch_page

TOOL_REGISTRY = {
    "web_fetch": fetch_page,
    "browser_goto": execute,
    "browser_read": execute,
    "browser_click": execute,
    "browser_type": execute,
    "browser_submit": execute,
    "browser_login": execute,
    "browser_close": execute,
    "browser_plan": plan,
}

BROWSER_TOOLS = tuple(name for name in TOOL_REGISTRY if name.startswith("browser_"))


def run_tool(name, args, persona=None):
    tool = TOOL_REGISTRY.get(name)
    if not tool:
        return {"error": "unknown tool"}
    payload = dict(args or {})
    for dropped in ("persona", "user_id", "bot_name", "tool"):
        payload.pop(dropped, None)
    if name in BROWSER_TOOLS and name != "browser_plan":
        return execute(persona or "default", name, payload)
    if name == "browser_plan":
        return plan(
            persona or "default",
            payload.get("goal"),
            max_steps=payload.get("max_steps", 4),
        )
    accepted = {
        key for key, param in inspect.signature(tool).parameters.items()
        if param.kind in (param.POSITIONAL_OR_KEYWORD, param.KEYWORD_ONLY)
    }
    filtered = {key: value for key, value in payload.items() if key in accepted}
    return tool(**filtered)


def tool_catalog() -> dict:
    return {
        "tools": list(TOOL_REGISTRY),
        "browser": binary_status(),
        "primary": "agent-browser",
    }
