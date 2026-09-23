const { loadConfig } = require("./config");
const { ReplyQueue } = require("./queue/reply-queue");
const { DecayTracker } = require("./conversation/decay");
const { LoopGuard } = require("./conversation/loop-guard");
const { LlmClient } = require("./llm/client");
const { MessageLog } = require("./db/log");
const { ChannelHistory } = require("./discord/history");
const { DiscordHub } = require("./discord/hub");
const { createApi } = require("./api/server");
const { createIntegrations } = require("./integrations");

async function main() {
  const config = loadConfig();
  if (!config.apiToken) {
    console.error("API_TOKEN is required in /etc/discord-bots/orchestrator.env");
    process.exit(1);
  }
  if (config.bots.length === 0) {
    console.error(`No persona env files found in ${config.configDir}`);
    process.exit(1);
  }

  const db = new MessageLog(config.databaseUrl);
  await db.init();

  const queue = new ReplyQueue({
    minGapMs: config.replyGapMinMs,
    maxGapMs: config.replyGapMaxMs,
  });
  const decay = new DecayTracker(config.decay);
  const loop = new LoopGuard({ maxChain: config.maxBotChain });
  const llm = new LlmClient({
    url: config.llmUrl,
    model: config.llmModel,
    timeoutMs: config.llmTimeoutMs,
    maxTokens: config.llmMaxTokens,
  });
  const history = new ChannelHistory(8);
  const integrations = createIntegrations(config);
  const hub = new DiscordHub({ bots: config.bots, queue, decay, loop, llm, db, history });

  const api = createApi({
    token: config.apiToken,
    hub,
    queue,
    decay,
    loop,
    integrations,
  });
  const server = await new Promise((resolve) => {
    const listener = api.listen(config.apiPort, config.apiHost, () => resolve(listener));
  });

  console.log(
    `orchestrator api http://${config.apiHost}:${config.apiPort} llm ${config.llmUrl} bots ${config.bots
      .map((bot) => bot.name)
      .join(",")}`
  );

  await hub.start();

  const shutdown = async () => {
    server.close();
    await hub.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
