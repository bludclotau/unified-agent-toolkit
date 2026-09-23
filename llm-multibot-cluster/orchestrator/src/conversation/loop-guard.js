class LoopGuard {
  constructor({ maxChain = 3 } = {}) {
    this.maxChain = maxChain;
  }

  evaluate({ botName, authorName, authorIsClusterBot, chain = [], allowBotMessages = false }) {
    const me = String(botName || "").toLowerCase();
    const author = String(authorName || "").toLowerCase();
    if (me && author && me === author) {
      return { allow: false, reason: "self" };
    }
    if (!authorIsClusterBot) return { allow: true, reason: "human" };
    if (!allowBotMessages) return { allow: false, reason: "bot-messages-disabled" };

    const names = chain.map((name) => String(name).toLowerCase());
    if (names.includes(me)) return { allow: false, reason: "already-in-chain" };
    if (names.length >= this.maxChain) return { allow: false, reason: "max-chain" };
    if (names.length >= 2 && names[names.length - 2] === me) {
      return { allow: false, reason: "cycle" };
    }
    return { allow: true, reason: "bot-chain" };
  }
}

module.exports = { LoopGuard };
