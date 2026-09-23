const test = require("node:test");
const assert = require("node:assert/strict");
const { DecayTracker } = require("../src/conversation/decay");

test("human mention fills energy and clears a bot chain", () => {
  let now = 1_000;
  const decay = new DecayTracker({ now: () => now });
  decay.noteBot("c1", "wendy");
  decay.noteHuman("c1", { mentioned: true });
  const snap = decay.snapshot("c1");
  assert.equal(snap.energy, 1);
  assert.deepEqual(snap.chain, []);
});

test("idle time halves energy across the configured half-life", () => {
  let now = 0;
  const decay = new DecayTracker({ halfLifeMs: 1000, now: () => now });
  decay.noteHuman("c1", { mentioned: true });
  now = 1000;
  const snap = decay.snapshot("c1");
  assert.ok(Math.abs(snap.energy - 0.5) < 1e-9);
});

test("bot replies multiply energy and a low roll stays quiet", () => {
  const decay = new DecayTracker({ factor: 0.5, minEnergy: 0.2, random: () => 0.9 });
  decay.noteHuman("c1", { mentioned: false });
  const after = decay.noteBot("c1", "gumbo");
  assert.equal(after.energy, 0.72 * 0.5);
  const decision = decay.shouldRespond({
    channelId: "c1",
    authorIsBot: true,
    allowBotMessages: true,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "bot-roll");
});

test("a direct human mention always answers", () => {
  const decay = new DecayTracker({ random: () => 0.99, minEnergy: 0.9 });
  decay.noteHuman("c1", { mentioned: true });
  const decision = decay.shouldRespond({ channelId: "c1", mentioned: true, authorIsBot: false });
  assert.equal(decision.reason, "mention");
  assert.equal(decision.ok, true);
});
