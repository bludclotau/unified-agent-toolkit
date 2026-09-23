# Discord orchestrator

One Node process logs in every persona from `/etc/discord-bots/*.env`. Each file supplies that bot's Discord token, channel list, and persona text. Chat completions go to `http://10.1.1.122:8081/v1/chat/completions`. A single reply queue holds the next bot until the previous send has finished and a jittered gap has elapsed.

Bot-to-bot replies are off unless the control API enables them for a persona. When they are on, a channel chain records who already spoke. A bot cannot answer itself, cannot speak twice in the same chain, and cannot extend a chain past `MAX_BOT_CHAIN`. Energy halves over `DECAY_HALF_LIFE_MS` and is multiplied by `DECAY_FACTOR` after every bot send. Direct @mentions from people still answer. Other human messages get one decaying chance, shared by the cluster.

Every inbound message and every outbound send is inserted into `messages` in the `agent_cluster` database. The control API listens on `127.0.0.1:8787` and requires `API_TOKEN`. Keyhole exposes it on the LAN at `/api/orchestrator/`.

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8787/status
curl -s -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":true}' http://127.0.0.1:8787/bots/wendy/bot-messages
curl -s -H "Authorization: Bearer $API_TOKEN" -X POST http://127.0.0.1:8787/bots/gumbo/pause
```

Layout:

```
src/index.js                  process entry
src/config.js                 /etc/discord-bots loader
src/discord/hub.js            one client per persona
src/queue/reply-queue.js      single-flight send gap
src/conversation/decay.js     energy half-life
src/conversation/loop-guard.js
src/llm/client.js             OpenAI chat completions
src/db/log.js                 messages table
src/api/server.js             control API
src/integrations/index.js     router, keyhole, browser agents, derpr, aizen, letta
sql/messages.sql
systemd/discord-orchestrator.service
```

Cloned integrations live in `/home/wendy/waffle_house/integrations`. `GET /integrations` reports which ones are on disk and which HTTP ports answer. `POST /integrations/agent-browser/invoke` accepts only `open`, `snapshot`, and `close` with an `http` or `https` URL. derpr-python is not started from here, because a second Discord login would kick these bots offline.
