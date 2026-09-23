#!/bin/bash
# Idempotent browser setup for gguf-router.
# Installs agent-browser and Playwright Chromium if they are missing,
# and ensures /etc/gguf-router/tool.env has TOOL_API_TOKEN plus CREDENTIALS_KEY.
set -euo pipefail

NPM="${NPM:-/usr/local/bin/npm}"
NPX="${NPX:-/usr/local/bin/npx}"
[ -x "$NPM" ] || NPM="$(command -v npm)"
[ -x "$NPX" ] || NPX="$(command -v npx)"

CLONE="${BROWSER_AGENT_DIR:-/home/wendy/waffle_house/integrations/browser-agent}"
HOME_WENDY="${WENDY_HOME:-/home/wendy}"
TOOL_ENV="${TOOL_ENV:-/etc/gguf-router/tool.env}"
ORCH_ENV="${ORCH_ENV:-/etc/discord-bots/orchestrator.env}"
VENV_PY="${VENV_PY:-/home/wendy/waffle_house/gguf-router/.venv/bin/python}"

if ! command -v agent-browser >/dev/null 2>&1; then
  "$NPM" install -g agent-browser
fi

if ! compgen -G "$HOME_WENDY/.agent-browser/browsers/chrome-*" >/dev/null; then
  sudo -u wendy -H agent-browser install
fi

if ! compgen -G "$HOME_WENDY/.cache/ms-playwright/chromium-*" >/dev/null; then
  if [ ! -d "$CLONE/node_modules/playwright" ]; then
    sudo -u wendy -H bash -lc "cd '$CLONE' && '$NPM' install --no-fund --no-audit"
  fi
  sudo -u wendy -H bash -lc "cd '$CLONE' && '$NPX' playwright install chromium"
fi

install -d -m 755 /etc/gguf-router
"$VENV_PY" - <<PY
import os
from pathlib import Path
from cryptography.fernet import Fernet

tool = Path("${TOOL_ENV}")
orch = Path("${ORCH_ENV}")
values = {}
if tool.is_file():
    for line in tool.read_text().splitlines():
        if not line.strip() or line.strip().startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip()
if not values.get("TOOL_API_TOKEN") and orch.is_file():
    for line in orch.read_text().splitlines():
        if line.startswith("API_TOKEN="):
            values["TOOL_API_TOKEN"] = line.split("=", 1)[1].strip()
            break
if not values.get("TOOL_API_TOKEN"):
    raise SystemExit("TOOL_API_TOKEN missing and orchestrator API_TOKEN was not found")
if not values.get("CREDENTIALS_KEY"):
    values["CREDENTIALS_KEY"] = Fernet.generate_key().decode()
values.setdefault("BROWSER_CRED_DIR", "/var/lib/gguf-router/browser-creds")
text = "".join(f"{key}={values[key]}\n" for key in ("TOOL_API_TOKEN", "CREDENTIALS_KEY", "BROWSER_CRED_DIR"))
tool.write_text(text)
os.chmod(tool, 0o600)
PY

install -d -o wendy -g discordbots -m 750 /var/lib/gguf-router /var/lib/gguf-router/browser-creds
echo "browser bootstrap ok"
