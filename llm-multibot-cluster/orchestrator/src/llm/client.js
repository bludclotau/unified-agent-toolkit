function extractText(data) {
  if (!data || typeof data !== "object") return "";
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice) {
    if (choice.message && typeof choice.message.content === "string") return choice.message.content;
    if (typeof choice.text === "string") return choice.text;
  }
  if (typeof data.content === "string") return data.content;
  if (typeof data.reply === "string") return data.reply;
  return "";
}

function buildMessages({ persona, transcript, mode, botName }) {
  const lines = [
    String(persona || "").trim(),
    mode && mode !== "chat" ? `Current channel mode: ${mode}.` : "",
    `You are ${botName} speaking in Discord.`,
    "Reply with a single short message in character.",
    "Do not prefix your name. Do not speak as anyone else.",
    "If the thread is winding down, keep the reply brief.",
  ].filter(Boolean);
  return [
    { role: "system", content: lines.join("\n") },
    { role: "user", content: transcript || "(no prior messages)" },
  ];
}

class LlmClient {
  constructor({ url, model, timeoutMs = 90000, maxTokens = 256, fetchImpl = fetch } = {}) {
    this.url = url;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    this.fetchImpl = fetchImpl;
  }

  async complete({ messages, maxTokens } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens || this.maxTokens,
          temperature: 0.8,
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`LLM ${response.status}: ${raw.slice(0, 300)}`);
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("LLM returned non-JSON");
      }
      return extractText(data).trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { LlmClient, extractText, buildMessages };
