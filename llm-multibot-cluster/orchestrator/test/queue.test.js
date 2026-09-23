const test = require("node:test");
const assert = require("node:assert/strict");
const { ReplyQueue } = require("../src/queue/reply-queue");

test("only one bot runs at a time", async () => {
  const queue = new ReplyQueue({ minGapMs: 0, maxGapMs: 0, random: () => 0 });
  let active = 0;
  let max = 0;
  const jobs = [0, 1, 2].map(() => queue.enqueue({
    botName: "wendy",
    priority: 1,
    run: async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return { spoke: false };
    },
  }));
  await Promise.all(jobs);
  assert.equal(max, 1);
});

test("a spoken reply holds the next bot for the gap", async () => {
  const queue = new ReplyQueue({ minGapMs: 80, maxGapMs: 80, random: () => 0 });
  const starts = [];
  await Promise.all([0, 1].map((n) => queue.enqueue({
    botName: `bot${n}`,
    priority: 1,
    run: async () => {
      starts.push(Date.now());
      return { spoke: true };
    },
  })));
  assert.ok(starts[1] - starts[0] >= 70);
});

test("a running reply is not preempted and a mention goes next", async () => {
  const queue = new ReplyQueue({ minGapMs: 0, maxGapMs: 0, random: () => 0 });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const order = [];
  const blocker = queue.enqueue({
    botName: "blocker",
    priority: 1,
    run: async () => {
      order.push("blocker");
      await gate;
      return { spoke: false };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const ambient = queue.enqueue({
    botName: "ambient",
    priority: 1,
    run: async () => {
      order.push("ambient");
      return { spoke: false };
    },
  });
  const mentioned = queue.enqueue({
    botName: "mentioned",
    priority: 0,
    run: async () => {
      order.push("mentioned");
      return { spoke: false };
    },
  });
  release();
  await Promise.all([blocker, ambient, mentioned]);
  assert.deepEqual(order, ["blocker", "mentioned", "ambient"]);
});
