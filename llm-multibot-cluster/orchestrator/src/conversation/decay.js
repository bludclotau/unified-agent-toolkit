class DecayTracker {
  constructor({
    factor = 0.55,
    halfLifeMs = 180000,
    minEnergy = 0.18,
    ambientRate = 0.35,
    random = Math.random,
    now = Date.now,
  } = {}) {
    this.factor = factor;
    this.halfLifeMs = halfLifeMs;
    this.minEnergy = minEnergy;
    this.ambientRate = ambientRate;
    this.random = random;
    this.now = now;
    this.channels = new Map();
  }

  state(channelId) {
    let row = this.channels.get(channelId);
    if (!row) {
      row = { energy: 0, updatedAt: this.now(), chain: [] };
      this.channels.set(channelId, row);
    }
    return row;
  }

  tick(channelId) {
    const row = this.state(channelId);
    const now = this.now();
    const elapsed = Math.max(0, now - row.updatedAt);
    if (this.halfLifeMs > 0 && elapsed > 0) {
      row.energy *= Math.pow(0.5, elapsed / this.halfLifeMs);
    }
    row.updatedAt = now;
    return row;
  }

  noteHuman(channelId, { mentioned = false } = {}) {
    const row = this.tick(channelId);
    row.energy = Math.max(row.energy, mentioned ? 1 : 0.72);
    row.chain = [];
    return row.energy;
  }

  noteBot(channelId, botName) {
    const row = this.tick(channelId);
    row.energy *= this.factor;
    row.chain = [...row.chain, botName].slice(-12);
    return { energy: row.energy, chain: row.chain.slice() };
  }

  chain(channelId) {
    return this.tick(channelId).chain.slice();
  }

  snapshot(channelId) {
    const row = this.tick(channelId);
    return { energy: row.energy, chain: row.chain.slice(), updatedAt: row.updatedAt };
  }

  shouldRespond({ channelId, mentioned = false, authorIsBot = false, allowBotMessages = false }) {
    const row = this.tick(channelId);
    if (mentioned && !authorIsBot) {
      return { ok: true, energy: row.energy, reason: "mention" };
    }
    if (authorIsBot) {
      if (!allowBotMessages) {
        return { ok: false, energy: row.energy, reason: "bot-messages-disabled" };
      }
      if (row.energy < this.minEnergy) {
        return { ok: false, energy: row.energy, reason: "decayed" };
      }
      const roll = this.random();
      const ok = roll < row.energy;
      return { ok, energy: row.energy, reason: ok ? "bot-energy" : "bot-roll" };
    }
    if (row.energy < this.minEnergy) {
      return { ok: false, energy: row.energy, reason: "decayed" };
    }
    const roll = this.random();
    const probability = row.energy * this.ambientRate;
    const ok = roll < probability;
    return { ok, energy: row.energy, reason: ok ? "ambient" : "ambient-roll" };
  }
}

module.exports = { DecayTracker };
