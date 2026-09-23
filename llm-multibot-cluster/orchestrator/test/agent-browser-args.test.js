const test = require("node:test");
const assert = require("node:assert/strict");
const { agentBrowserCommands, sessionName } = require("../src/integrations");

test("snapshot of a url opens that page before reading the tree", () => {
  assert.deepEqual(agentBrowserCommands("snapshot", { url: "https://example.com" }), [
    ["open", "https://example.com"],
    ["snapshot"],
  ]);
});

test("click and fill stay on the allowlist", () => {
  assert.deepEqual(agentBrowserCommands("click", { ref: "e2" }), [["click", "@e2"]]);
  assert.deepEqual(agentBrowserCommands("fill", { ref: "@e3", text: "hi" }), [["fill", "@e3", "hi"]]);
});

test("shell-shaped actions and urls are rejected", () => {
  assert.throws(() => agentBrowserCommands("eval", { url: "https://example.com" }));
  assert.throws(() => agentBrowserCommands("open", { url: "file:///etc/passwd" }));
  assert.throws(() => agentBrowserCommands("click", { ref: "button;rm" }));
  assert.equal(sessionName("Wendy"), "gguf-wendy");
});
