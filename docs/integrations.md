# Cloned integrations

These six repositories are shallow clones on bot-vm at `/home/wendy/waffle_house/integrations`. They are upstream projects. This toolkit records how they attach instead of vendoring their trees.

Discord chat does not call any of them. `llm-multibot-cluster/orchestrator/src/discord/hub.js` never imports the integration runner. Browser actions require `TOOL_API_TOKEN` on gguf-router, sent by Keyhole as `X-Tool-Token` or `Authorization: Bearer`. That token is the same value as the orchestrator `API_TOKEN`. A Discord message has no way to present it.

`GET /integrations` on the orchestrator reports `ready` and `primary`, not just whether the clone exists. Keyhole's Tools tab reads that endpoint and can run an action.

| Directory | Upstream | This pass |
|---|---|---|
| `browser-use` | https://github.com/browser-use/browser-use | Cloned. Not loaded into the router. |
| `browser-agent` | https://github.com/karthi11040/browser-agent | Snapshot CLI works from the control API. |
| `agent-browser` | https://github.com/vercel-labs/agent-browser | Primary executor. |
| `derpr-python` | https://github.com/Addrick/derpr-python | Still not started. |
| `aizen` | https://github.com/dawnofcd/aizen | Still not started. |
| `letta` | https://github.com/letta-ai/letta | Still not started. No server on port 8283. |

## Decision

agent-browser is primary. gguf-router shells out to it with `--session gguf-<persona> --restore`, so each persona keeps its own cookies. The router owns the tool names and the GBNF planner. The CLI owns the browser process.

browser-use stays a library on disk. Its agent runs a second model loop, which would ignore the router's grammar and the single llama.cpp endpoint. Putting it in-process would also mean a second browser beside the persona sessions that already exist. The control API reports it as `ready: false` and `primary: false`.

browser-agent stays a one-shot accessibility snapshot (`npx tsx bin/agent.ts snapshot <url>`, headless). Its own autonomous loop wants an OpenRouter key, so it is not the planner.

## Router tools

`POST /tool` accepts these once the token header is present:

| Tool | What it runs |
|---|---|
| `browser_goto` | `open <url>` |
| `browser_read` | `open` when a url is set, then `snapshot`, then `read` |
| `browser_click` | `click @ref` |
| `browser_type` | `fill @ref <text>` |
| `browser_submit` | `click @ref`, or `press Enter` when no ref is given |
| `browser_login` | Stores username and password for that persona and origin, then fills the refs. The password is not returned and is not given to the planner. |
| `browser_close` | `close` |
| `browser_plan` | Asks Qwen at `10.1.1.122:8081/completion` for one GBNF-constrained tool call at a time, then runs it on that persona's session. The grammar allows goto, read, click, type, submit, and done. It does not allow login. |

`web_fetch` is unchanged and does not require the token. Extra fields such as `persona` are stripped before it is called.

Logins are written to `/var/lib/gguf-router/browser-creds/gguf-<persona>/logins.json` mode `600`. Postgres tool logs go through the same redaction, so a stored password does not land in `cache` or `tools`.

Persona memory for chat is still `conversations.last_message` from the router database. The planner reads its own step trace for the current call. It does not grow a second memory store.

## Control API

`POST /integrations/agent-browser/invoke` allowlists `open`, `snapshot`, `read`, `click`, `fill`, `type`, `press`, and `close`. A snapshot with a url opens the page first. Refs must look like `@e1`. Urls must be `http` or `https` and must not carry userinfo.

`POST /integrations/browser-agent/invoke` still only takes `{ "url": "https://..." }` and returns the accessibility tree.

`POST /integrations/browser-use/invoke` still refuses to run it.

## Keyhole

The Tools tab has a token field (session storage for that tab), a status button for the three browser clones, and a form for the router tools. Two extra buttons call the orchestrator snapshot invokes. The operator is the authenticated party. A raw Discord message is not.

## Left alone

derpr-python, aizen, and letta are still not started. derpr would take the Discord tokens. aizen has no binary on `PATH`. letta's clone is the docs-and-policy tree, and nothing is listening on `127.0.0.1:8283`. Discord transcripts stay in the orchestrator's `messages` table.
