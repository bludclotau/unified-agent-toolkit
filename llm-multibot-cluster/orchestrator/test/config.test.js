const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chatCompletionsUrl, loadBots, parseEnv } = require("../src/config");

test("llm url always ends at chat completions", () => {
  assert.equal(
    chatCompletionsUrl("http://10.1.1.122:8081"),
    "http://10.1.1.122:8081/v1/chat/completions"
  );
  assert.equal(
    chatCompletionsUrl("http://10.1.1.122:8081/v1/"),
    "http://10.1.1.122:8081/v1/chat/completions"
  );
  assert.equal(
    chatCompletionsUrl("http://10.1.1.122:8081/v1/chat/completions"),
    "http://10.1.1.122:8081/v1/chat/completions"
  );
});

test("persona env files load without the sequencer file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-"));
  fs.writeFileSync(path.join(dir, "sequencer.env"), "LLM_PRIMARY_URL=http://10.1.1.122:8081\n");
  fs.writeFileSync(
    path.join(dir, "wendy.env"),
    "DISCORD_TOKEN=secret-token\nBOT_NAME=wendy\nALLOWED_CHANNELS=1, 2\nPERSONA_FILE=/tmp/wendy.txt\nALLOW_BOT_MESSAGES=false\n"
  );
  const bots = loadBots(dir);
  assert.equal(bots.length, 1);
  assert.equal(bots[0].name, "wendy");
  assert.deepEqual(bots[0].channels, ["1", "2"]);
  assert.equal(bots[0].allowBotMessages, false);
  assert.equal(parseEnv("A=1\n# c\n\nB=two\n").B, "two");
});
