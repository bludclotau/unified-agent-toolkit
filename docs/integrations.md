# Cloned integrations

These six repositories are shallow clones on bot-vm at `/home/wendy/waffle_house/integrations`. They are upstream projects, so this toolkit records how they attach instead of vendoring their trees.

The Discord orchestrator lists them from `GET /integrations`. It does not start them. A second process logging into Discord with the same tokens would kick Wendy, Tabatha, and gumbo-slice offline. Browser actions are only available through the authenticated control API.

Discord chat completions stay on `http://10.1.1.122:8081/v1/chat/completions` either way.

| Directory | Upstream | On this VM |
|---|---|---|
| `browser-use` | https://github.com/browser-use/browser-use | Clone present. Python package dir `browser_use` is on disk. Not installed into the router venv. |
| `browser-agent` | https://github.com/karthi11040/browser-agent | Clone present. CLI entry is `bin/agent.ts`. `POST /integrations/browser-agent/invoke` runs `npx tsx bin/agent.ts snapshot <url>` when `npx` is available. |
| `agent-browser` | https://github.com/vercel-labs/agent-browser | Clone present. The `agent-browser` binary is not on `PATH`, and Chrome for Testing is not installed. |
| `derpr-python` | https://github.com/Addrick/derpr-python | Clone present. Not started. |
| `aizen` | https://github.com/dawnofcd/aizen | Clone present. The `aizen` binary is not installed. |
| `letta` | https://github.com/letta-ai/letta | Clone present. This upstream tree is the docs-and-policy checkout. No server is listening on `127.0.0.1:8283`. |

## browser-use

Python browser agent. A local run can point its OpenAI-compatible client at `http://10.1.1.122:8081/v1`. The orchestrator only checks that the clone and the `browser_use` package directory exist. It does not launch a browser from a Discord message.

## browser-agent

Playwright agent with an accessibility-tree snapshot CLI. The control API accepts a snapshot of one `http` or `https` URL. Discord users cannot pass a shell command through chat. Playwright's Chromium build is not installed yet, so a snapshot call fails until `npx playwright install chromium` has been run inside that clone.

## agent-browser

Vercel browser-automation CLI. When the binary is installed, `POST /integrations/agent-browser/invoke` allows three actions: `open`, `snapshot`, and `close`. `open` and `snapshot` require an `http` or `https` URL. Anything else is rejected. Install, from that clone, is `npm install -g agent-browser` and then `agent-browser install`.

## derpr-python

Addrick's persona orchestrator (Discord, portal, tiered memory). It wants its own `DISCORD_API_KEY` and a `LOCAL_LLM_URL`. On this machine that URL should be `http://10.1.1.122:8081/v1`. Leave it stopped while `discord-orchestrator.service` holds the three bot tokens. Its own README says the tree is still moving and to pin a commit rather than a branch. This clone is depth 1 of the default branch.

## aizen

Terminal coding agent from `dawnofcd/aizen`. It speaks OpenAI-compatible `/v1/chat/completions`, which matches the Qwen node. The clone is source only. `GET /integrations` reports `bin: null` until an `aizen` binary is on `PATH`. The orchestrator does not shell out to it.

## letta

Upstream README says active development moved to [letta-ai/letta-code](https://github.com/letta-ai/letta-code). The clone here is the pointer repository (license, policy, and the README). The orchestrator probes `http://127.0.0.1:8283/v1/health/` and currently gets a connection error. Discord transcripts are stored in Postgres table `messages` by `llm-multibot-cluster/orchestrator`. That log is independent of a Letta server.

## What the control API will not do

`POST /integrations/:name/invoke` runs a browser snapshot only for `agent-browser` and `browser-agent`, and only with the API token. `gguf-router` invoke is a health check. The other names return a status error and do not execute the clone.
