# keyhole

LAN console for the llama.cpp cluster behind [gguf-router](https://github.com/bludclotau/gguf-router).

This is the web UI that operators use on the LAN. Discord bots keep talking to gguf-router. Keyhole talks to **both**: it streams chat straight at the llama.cpp nodes, and it calls the router for personas, `/route`, and `/tool`.

Live on velma: `http://10.1.1.222:8080/` (also `:8000`, `:8888`, `https://10.1.1.222:8443`).

## Layout

```
html/index.html      UI shell
html/core.js         state, persistence, health pill
html/ui.js           node/persona/cluster render + probes
html/app.js          streaming chat, /route, /tool
html/catalog.json    node map + persona prompts (copied from gguf-router)
nginx/default.conf   reverse proxy
compose.yaml         nginx:alpine, host network
```

nginx same-origin proxies:

| path | upstream |
|------|----------|
| `/api/nodes/qwen/` | `10.1.1.122:8081` |
| `/api/nodes/dolphin/` | `10.1.1.122:8082` |
| `/api/router/` | `10.1.1.106:9000` (snerloc) |

Direct node calls: `GET /health`, `GET /v1/models`, `GET /props`, `GET /slots`, `POST /v1/chat/completions` (stream).

Router calls: `GET /health`, `POST /route`, `POST /tool`.

## Run

```bash
# TLS is optional for :8080
openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout certs/key.pem -out certs/cert.pem -subj "/CN=keyhole"

podman compose up -d
podman exec llm-chat nginx -s reload   # after nginx conf edits
```

HTML is bind-mounted; a reload of the browser is enough after `html/` edits.

## What gguf-router already provides

Keyhole treats the router repo as the source of truth:

- `router/config.yaml` — qwen `122:8081`, dolphin `122:8082`
- `router/personas.json` + `router/tasks.json` — model pick
- `router/persona_prompts.yaml` — system pre-prompts (mirrored in `html/catalog.json`)
- `POST /route` — `prompt`, `persona`, `task`, `user_id`, `bot_name`, `n_predict`, optional `tool`/`args`
- `POST /tool` — `{ "tool": "web_fetch", "args": { "url": "..." } }`
- `GET /health` — currently `{ "status": "router-ok" }`
- Persona engine prepends the prompt, injects per-user memory from Postgres, logs `conversations`, 2s cooldown, output cleaner

The UI has four surfaces: **Chat** (direct stream, optional send via /route), **Cluster** (node props/slots + router health), **Personas** (full prompts), **Tools** (web_fetch + a /route lab).

## Ask of the gguf-router maintainer

Keyhole currently **copies** catalog data and **hardcodes** node IPs in nginx. That will drift. Changes on the router side that would let this UI stay honest:

1. **Catalog endpoint.** `GET /health` (or `GET /catalog`) should return `models`, `personas` (with prompts), `tasks`, `tools`, and node base URLs from `config.yaml`. Keyhole can then drop the static copy in `html/catalog.json`.
2. **Pass only tool args into tools.** Live `POST /tool` with `web_fetch` returns `fetch_page() got an unexpected keyword argument 'persona'`. `run_tool` should call `tool(**args)` and not spread the rest of the request.
3. **Streaming `/route`.** The request body already has `stream: true`, but the handler always does a blocking `/completion`. SSE (or OpenAI-style chunks) would let the Discord path and the web path share one backend.
4. **Read APIs for memory.** `GET /conversations?user_id=&persona=` (and maybe last cache/tool log) so Cluster can show what Discord already stored.
5. **Keep `raw` intact.** The cleaner truncates at the last period. Chat should keep using `raw` for code; a `clean` that does not chop mid-reply would help Discord too.

Do not expose `/debug/login` or `/debug/secret` as product surfaces.

When the catalog endpoint exists, keyhole should load it from `/api/router/catalog` and only use `catalog.json` as a fallback.
