const express = require("express");

function createApi(ctx) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.use((req, res, next) => {
    if (!ctx.token) {
      res.status(503).json({ error: "API_TOKEN is not configured" });
      return;
    }
    const header = req.get("authorization") || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const provided = bearer || req.get("x-api-token") || "";
    if (provided !== ctx.token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, bots: ctx.hub.list().length });
  });

  app.get("/status", (_req, res) => {
    res.json(ctx.hub.status());
  });

  app.get("/bots", (_req, res) => {
    res.json({ bots: ctx.hub.list() });
  });

  app.post("/bots/:name/pause", (req, res) => {
    const bot = ctx.hub.setPaused(req.params.name, true);
    if (!bot) return res.status(404).json({ error: "unknown bot" });
    res.json(bot);
  });

  app.post("/bots/:name/resume", (req, res) => {
    const bot = ctx.hub.setPaused(req.params.name, false);
    if (!bot) return res.status(404).json({ error: "unknown bot" });
    res.json(bot);
  });

  app.post("/bots/:name/bot-messages", (req, res) => {
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be boolean" });
    }
    const bot = ctx.hub.setAllowBotMessages(req.params.name, req.body.enabled);
    if (!bot) return res.status(404).json({ error: "unknown bot" });
    res.json(bot);
  });

  app.get("/queue", (_req, res) => {
    res.json(ctx.queue.snapshot());
  });

  app.get("/decay", (_req, res) => {
    res.json({
      factor: ctx.decay.factor,
      halfLifeMs: ctx.decay.halfLifeMs,
      minEnergy: ctx.decay.minEnergy,
      ambientRate: ctx.decay.ambientRate,
      maxBotChain: ctx.loop.maxChain,
    });
  });

  app.put("/decay", (req, res) => {
    const body = req.body || {};
    if (body.factor !== undefined) ctx.decay.factor = Number(body.factor);
    if (body.halfLifeMs !== undefined) ctx.decay.halfLifeMs = Number(body.halfLifeMs);
    if (body.minEnergy !== undefined) ctx.decay.minEnergy = Number(body.minEnergy);
    if (body.ambientRate !== undefined) ctx.decay.ambientRate = Number(body.ambientRate);
    if (body.maxBotChain !== undefined) ctx.loop.maxChain = Number(body.maxBotChain);
    res.json({
      factor: ctx.decay.factor,
      halfLifeMs: ctx.decay.halfLifeMs,
      minEnergy: ctx.decay.minEnergy,
      ambientRate: ctx.decay.ambientRate,
      maxBotChain: ctx.loop.maxChain,
    });
  });

  app.post("/mode", (req, res) => {
    const mode = String(req.body?.mode || "").toLowerCase();
    if (!ctx.hub.setMode(mode)) return res.status(400).json({ error: "unknown mode" });
    res.json({ mode });
  });

  app.post("/say", async (req, res) => {
    const { bot, channelId, content } = req.body || {};
    if (!bot || !channelId || !content) {
      return res.status(400).json({ error: "bot, channelId, and content are required" });
    }
    try {
      const result = await ctx.hub.say(bot, channelId, String(content).slice(0, 1900));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/integrations", async (_req, res) => {
    res.json(await ctx.integrations.status());
  });

  app.post("/integrations/:name/invoke", async (req, res) => {
    const result = await ctx.integrations.invoke(req.params.name, req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  });

  return app;
}

module.exports = { createApi };
