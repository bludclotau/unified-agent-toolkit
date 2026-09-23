function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ReplyQueue {
  constructor({ minGapMs = 1800, maxGapMs = 4200, random = Math.random } = {}) {
    this.minGapMs = minGapMs;
    this.maxGapMs = Math.max(minGapMs, maxGapMs);
    this.random = random;
    this.jobs = [];
    this.running = false;
    this.active = null;
    this.lastSpokeAt = 0;
    this.seq = 0;
  }

  enqueue(job) {
    return new Promise((resolve, reject) => {
      const priority = job.priority ?? 1;
      const item = { job, resolve, reject, priority, seq: this.seq++ };
      const index = this.jobs.findIndex((entry) => entry.priority > priority);
      if (index === -1) this.jobs.push(item);
      else this.jobs.splice(index, 0, item);
      this.kick();
    });
  }

  snapshot() {
    return {
      running: this.running,
      active: this.active,
      waiting: this.jobs.map((entry) => entry.job.botName || "unknown"),
    };
  }

  gapMs() {
    if (this.maxGapMs === this.minGapMs) return this.minGapMs;
    return this.minGapMs + this.random() * (this.maxGapMs - this.minGapMs);
  }

  async kick() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        const item = this.jobs.shift();
        this.active = item.job.botName || null;
        if (this.lastSpokeAt) {
          const wait = this.gapMs() - (Date.now() - this.lastSpokeAt);
          if (wait > 0) await sleep(wait);
        }
        try {
          const result = await item.job.run();
          if (result && result.spoke) this.lastSpokeAt = Date.now();
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.running = false;
      if (this.jobs.length > 0) this.kick();
    }
  }
}

module.exports = { ReplyQueue, sleep };
