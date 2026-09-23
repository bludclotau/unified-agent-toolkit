const fs = require("fs");
const path = require("path");

const SKIP_ENV = new Set(["sequencer.env", "orchestrator.env"]);

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function readEnvFile(file) {
  return parseEnv(fs.readFileSync(file, "utf8"));
}

function chatCompletionsUrl(primary) {
  const base = String(primary || "http://10.1.1.122:8081").replace(/\/+$/, "");
  if (base.endsWith("/v1/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadBots(configDir) {
  if (!fs.existsSync(configDir)) return [];
  return fs
    .readdirSync(configDir)
    .filter((name) => name.endsWith(".env") && !SKIP_ENV.has(name))
    .sort()
    .map((name) => {
      const env = readEnvFile(path.join(configDir, name));
      if (!env.DISCORD_TOKEN || !env.BOT_NAME) return null;
      return {
        name: env.BOT_NAME,
        token: env.DISCORD_TOKEN,
        channels: (env.ALLOWED_CHANNELS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        personaFile: env.PERSONA_FILE || "",
        allowBotMessages: env.ALLOW_BOT_MESSAGES === "true",
        source: name,
      };
    })
    .filter(Boolean);
}

function loadPersonaText(file, botName) {
  if (file && fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8").trim();
    if (text) return text;
  }
  return `You are ${botName}. Stay in character and keep replies short.`;
}

function loadConfig(env = process.env) {
  const configDir = env.CONFIG_DIR || "/etc/discord-bots";
  let sequencer = {};
  const sequencerPath = path.join(configDir, "sequencer.env");
  if (fs.existsSync(sequencerPath)) sequencer = readEnvFile(sequencerPath);

  const llmPrimary = env.LLM_URL || sequencer.LLM_PRIMARY_URL || "http://10.1.1.122:8081";
  return {
    configDir,
    bots: loadBots(configDir),
    llmUrl: chatCompletionsUrl(llmPrimary),
    llmModel: env.LLM_MODEL || sequencer.LLM_MODEL || "qwen2.5-7b-instruct-q4_k_m",
    databaseUrl: env.DATABASE_URL || env.POSTGRES_DSN || "",
    apiHost: env.API_HOST || "127.0.0.1",
    apiPort: num(env.API_PORT, 8787),
    apiToken: env.API_TOKEN || "",
    ggufRouterUrl: (env.GGUF_ROUTER_URL || "http://127.0.0.1:9000").replace(/\/+$/, ""),
    keyholeUrl: (env.KEYHOLE_URL || "http://127.0.0.1:8080").replace(/\/+$/, ""),
    lettaUrl: (env.LETTA_URL || "http://127.0.0.1:8283").replace(/\/+$/, ""),
    integrationsDir: env.INTEGRATIONS_DIR || "/home/wendy/waffle_house/integrations",
    decay: {
      factor: num(env.DECAY_FACTOR, 0.55),
      halfLifeMs: num(env.DECAY_HALF_LIFE_MS, 180000),
      minEnergy: num(env.MIN_ENERGY, 0.18),
      ambientRate: num(env.AMBIENT_RATE, 0.35),
    },
    maxBotChain: num(env.MAX_BOT_CHAIN, 3),
    replyGapMinMs: num(env.REPLY_GAP_MIN_MS, 1800),
    replyGapMaxMs: num(env.REPLY_GAP_MAX_MS, 4200),
    llmTimeoutMs: num(env.LLM_TIMEOUT_MS, 90000),
    llmMaxTokens: num(env.LLM_MAX_TOKENS, 256),
  };
}

module.exports = {
  parseEnv,
  readEnvFile,
  chatCompletionsUrl,
  loadBots,
  loadPersonaText,
  loadConfig,
};
