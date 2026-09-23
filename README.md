# Unified agent toolkit

Discord persona cluster, GGUF router, and Keyhole LAN console in one repo. Live bots on bot-vm still run from the split checkouts under `/home/wendy/waffle_house`. This repository is the source that gets pushed.

Secrets stay off this tree. Discord tokens and the control-API token live in `/etc/discord-bots`. The router database URL lives in `gguf-router/.env`, copied from `.env.example` on the host.

## Parts

| Directory | What it is | Live on bot-vm |
|---|---|---|
| `llm-multibot-cluster/` | Persona bots and the single-process orchestrator | `discord-orchestrator.service`, port 8787 |
| `gguf-router/` | FastAPI router in front of the llama.cpp nodes | `gguf-router.service`, port 9000 |
| `keyhole/` | Static LAN console and nginx proxy | nginx on 8080, 8000, 8888, and 8443 |

Chat completions for the Discord orchestrator go to `http://10.1.1.122:8081/v1/chat/completions`. The router still serves `POST /route` for Keyhole and for anything that wants persona memory plus the output cleaner. Qwen is `10.1.1.122:8081`. Dolphin is `10.1.1.122:8082`.

## Orchestrator

`llm-multibot-cluster/orchestrator` loads one env file per persona from `/etc/discord-bots`, logs each bot in with its own token, and sends replies through one queue so two bots never speak at once. Energy decays over time. A bot cannot answer itself, cannot speak twice in one bot-to-bot chain, and stops after three hops. Messages are inserted into the `messages` table in Postgres database `agent_cluster`.

```bash
cd llm-multibot-cluster/orchestrator
npm install
npm test
node src/index.js
```

Control API (bearer `API_TOKEN`, also proxied by Keyhole at `/api/orchestrator/`):

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8787/status
```

## Router

```bash
cd gguf-router
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/uvicorn main:app --app-dir router --host 0.0.0.0 --port 9000
```

`systemd/gguf-router.service` is the original snerloc unit. `systemd/gguf-router.local.service` is the bot-vm unit.

## Keyhole

`nginx/default.conf` targets the snerloc router at `10.1.1.106:9000`. `nginx/local.conf` targets the router and orchestrator on this VM. HTML is served from `/var/lib/keyhole/html` by that local config.

```bash
# from keyhole/, with podman, using the upstream compose
podman compose up -d
```

## Cloned integrations

browser-use, browser-agent, and agent-browser are wired from the router and Keyhole. agent-browser is the primary executor, with one restored session per persona. browser-use is not loaded into the router. derpr-python, aizen, and letta are still not started. Details are in [docs/integrations.md](docs/integrations.md).
