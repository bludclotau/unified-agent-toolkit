const test = require("node:test");
const assert = require("node:assert/strict");
const { LoopGuard } = require("../src/conversation/loop-guard");

test("bots do not answer themselves or each other while bot messages are off", () => {
  const guard = new LoopGuard({ maxChain: 3 });
  assert.equal(guard.evaluate({
    botName: "wendy",
    authorName: "wendy",
    authorIsClusterBot: true,
    chain: [],
    allowBotMessages: true,
  }).reason, "self");
  assert.equal(guard.evaluate({
    botName: "tabatha",
    authorName: "wendy",
    authorIsClusterBot: true,
    chain: ["wendy"],
    allowBotMessages: false,
  }).reason, "bot-messages-disabled");
});

test("a bot already in the chain cannot continue it", () => {
  const guard = new LoopGuard({ maxChain: 4 });
  const decision = guard.evaluate({
    botName: "wendy",
    authorName: "gumbo",
    authorIsClusterBot: true,
    chain: ["wendy", "tabatha", "gumbo"],
    allowBotMessages: true,
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "already-in-chain");
});

test("the chain stops at the configured hop limit", () => {
  const guard = new LoopGuard({ maxChain: 2 });
  const decision = guard.evaluate({
    botName: "gumbo",
    authorName: "tabatha",
    authorIsClusterBot: true,
    chain: ["wendy", "tabatha"],
    allowBotMessages: true,
  });
  assert.equal(decision.reason, "max-chain");
});

test("human authors are allowed through", () => {
  const guard = new LoopGuard();
  assert.equal(guard.evaluate({
    botName: "wendy",
    authorName: "sam",
    authorIsClusterBot: false,
    chain: ["wendy", "tabatha", "gumbo"],
  }).allow, true);
});
