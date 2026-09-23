const { Client, GatewayIntentBits } = require("discord.js");
const { loadPersonaText } = require("../config");
const { buildMessages } = require("../llm/client");

const MODES = ["chat", "debate", "story", "roleplay", "collaboration", "philosophy"];

function remember(set, key, cap = 500) {
  set.add(key);
  if (set.size <= cap) return;
  const oldest = set.values().next().value;
  set.delete(oldest);
}

class DiscordHub {
  constructor({ bots, queue, decay, loop, llm, db, history }) {
    this.bots = bots;
    this.queue = queue;
    this.decay = decay;
    this.loop = loop;
    this.llm = llm;
    this.db = db;
    this.history = history;
    this.clients = new Map();
    this.paused = new Set();
    this.allowBot = new Map(bots.map((bot) => [bot.name, bot.allowBotMessages]));
    this.mode = "chat";
    this.inboundLogged = new Set();
    this.humanNoted = new Set();
    this.historyNoted = new Set();
    this.ambientClaimed = new Set();
    this.commandClaimed = new Set();
  }

  list() {
    return this.bots.map((bot) => {
      const client = this.clients.get(bot.name);
      return {
        name: bot.name,
        id: client?.user?.id || null,
        tag: client?.user?.tag || null,
        ready: Boolean(client?.isReady?.()),
        paused: this.paused.has(bot.name),
        allowBotMessages: this.allowBot.get(bot.name) === true,
        channels: bot.channels,
        personaFile: bot.personaFile,
      };
    });
  }

  status() {
    return {
      mode: this.mode,
      queue: this.queue.snapshot(),
      bots: this.list(),
    };
  }

  setPaused(name, paused) {
    if (!this.bots.some((bot) => bot.name === name)) return null;
    if (paused) this.paused.add(name);
    else this.paused.delete(name);
    return this.list().find((bot) => bot.name === name);
  }

  setAllowBotMessages(name, enabled) {
    if (!this.bots.some((bot) => bot.name === name)) return null;
    this.allowBot.set(name, enabled);
    return this.list().find((bot) => bot.name === name);
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return false;
    this.mode = mode;
    return true;
  }

  clusterAuthorName(msg) {
    for (const [name, client] of this.clients) {
      if (client.user && msg.author?.id === client.user.id) return name;
    }
    return msg.author?.username || "unknown";
  }

  authorIsCluster(msg) {
    return [...this.clients.values()].some((client) => client.user && msg.author?.id === client.user.id);
  }

  anyMentioned(msg) {
    return [...this.clients.values()].some((client) => client.user && msg.mentions?.users?.has(client.user.id));
  }

  async log(row) {
    try {
      await this.db.logMessage(row);
    } catch (err) {
      console.error("postgres log failed:", err.message);
    }
  }

  async say(botName, channelId, content) {
    const client = this.clients.get(botName);
    if (!client?.isReady?.()) throw new Error(`${botName} is not connected`);
    return this.queue.enqueue({
      botName,
      priority: 0,
      run: async () => {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) throw new Error("channel is not text");
        const sent = await channel.send(content);
        this.history.add(channelId, botName, content);
        this.decay.noteBot(channelId, botName);
        await this.log({
          channelId,
          guildId: sent.guildId,
          discordMessageId: sent.id,
          authorId: client.user.id,
          authorName: botName,
          botName,
          direction: "outbound",
          content,
          persona: botName,
          chainDepth: this.decay.chain(channelId).length,
          energy: this.decay.snapshot(channelId).energy,
        });
        return { spoke: true, messageId: sent.id };
      },
    });
  }

  bind(bot, client) {
    client.on("messageCreate", (msg) => {
      this.onMessage(bot, msg).catch((err) => {
        console.error(`[${bot.name}] message error:`, err.message);
      });
    });
    client.on("clientReady", () => {
      console.log(`logged in as ${client.user.tag} (${bot.name})`);
    });
    client.on("error", (err) => {
      console.error(`[${bot.name}] discord error:`, err.message);
    });
  }

  async onMessage(bot, msg) {
    if (!msg.author || msg.author.id === bot.client.user?.id) return;
    if (msg.author.id === this.clients.get(bot.name)?.user?.id) return;
    if (bot.channels.length && !bot.channels.includes(msg.channelId)) return;

    if (!this.inboundLogged.has(msg.id)) {
      remember(this.inboundLogged, msg.id);
      await this.log({
        channelId: msg.channelId,
        guildId: msg.guildId,
        discordMessageId: msg.id,
        authorId: msg.author.id,
        authorName: msg.author.username,
        botName: null,
        direction: "inbound",
        content: msg.content,
      });
    }

    const cluster = this.authorIsCluster(msg);
    if (!cluster && !this.historyNoted.has(msg.id)) {
      remember(this.historyNoted, msg.id);
      this.history.add(msg.channelId, msg.author.username, msg.content);
    }
    if (!cluster && !this.humanNoted.has(msg.id)) {
      remember(this.humanNoted, msg.id);
      this.decay.noteHuman(msg.channelId, { mentioned: this.anyMentioned(msg) });
    }

    if (msg.content.startsWith("!mode ")) {
      if (this.commandClaimed.has(msg.id)) return;
      remember(this.commandClaimed, msg.id);
      const next = msg.content.slice(6).trim().toLowerCase();
      if (!this.setMode(next)) {
        await msg.reply(`Valid modes: ${MODES.join(", ")}`);
        return;
      }
      await msg.reply(`Mode changed to: ${this.mode}`);
      return;
    }

    const mentioned = Boolean(msg.mentions?.users?.has(this.clients.get(bot.name)?.user?.id));
    await this.queue.enqueue({
      botName: bot.name,
      priority: mentioned ? 0 : 1,
      run: () => this.consider(bot, msg, { mentioned, cluster }),
    });
  }

  async consider(bot, msg, { mentioned, cluster }) {
    if (this.paused.has(bot.name)) return { spoke: false, reason: "paused" };

    const allow = this.allowBot.get(bot.name) === true;
    const chain = this.decay.chain(msg.channelId);
    const guard = this.loop.evaluate({
      botName: bot.name,
      authorName: this.clusterAuthorName(msg),
      authorIsClusterBot: cluster,
      chain,
      allowBotMessages: allow,
    });
    if (!guard.allow) {
      if (mentioned) {
        await this.log({
          channelId: msg.channelId,
          guildId: msg.guildId,
          discordMessageId: msg.id,
          authorName: msg.author.username,
          botName: bot.name,
          direction: "skip",
          content: msg.content,
          skipReason: guard.reason,
          chainDepth: chain.length,
          energy: this.decay.snapshot(msg.channelId).energy,
        });
      }
      return { spoke: false, reason: guard.reason };
    }

    const decision = this.decay.shouldRespond({
      channelId: msg.channelId,
      mentioned,
      authorIsBot: cluster,
      allowBotMessages: allow,
    });
    if (!decision.ok) return { spoke: false, reason: decision.reason };

    if (!mentioned && !cluster) {
      if (this.ambientClaimed.has(msg.id)) return { spoke: false, reason: "ambient-taken" };
      remember(this.ambientClaimed, msg.id);
    }

    const persona = loadPersonaText(bot.personaFile, bot.name);
    const messages = buildMessages({
      persona,
      transcript: this.history.transcript(msg.channelId),
      mode: this.mode,
      botName: bot.name,
    });
    const text = await this.llm.complete({ messages });
    if (!text) return { spoke: false, reason: "empty" };

    await msg.channel.sendTyping().catch(() => {});
    const sent = await msg.reply(text.slice(0, 1900));
    this.history.add(msg.channelId, bot.name, text);
    const after = this.decay.noteBot(msg.channelId, bot.name);
    await this.log({
      channelId: msg.channelId,
      guildId: sent.guildId,
      discordMessageId: sent.id,
      authorId: this.clients.get(bot.name)?.user?.id,
      authorName: bot.name,
      botName: bot.name,
      direction: "outbound",
      content: text.slice(0, 1900),
      persona: bot.name,
      chainDepth: after.chain.length,
      energy: after.energy,
    });
    return { spoke: true, messageId: sent.id };
  }

  async start() {
    for (const bot of this.bots) {
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });
      bot.client = client;
      this.clients.set(bot.name, client);
      this.bind(bot, client);
      client.login(bot.token).catch((err) => {
        console.error(`[${bot.name}] login failed:`, err.message);
      });
    }
  }

  async stop() {
    await Promise.all([...this.clients.values()].map((client) => client.destroy()));
  }
}

module.exports = { DiscordHub, MODES };
