class ChannelHistory {
  constructor(limit = 8) {
    this.limit = limit;
    this.channels = new Map();
  }

  add(channelId, speaker, content) {
    const rows = this.channels.get(channelId) || [];
    rows.push({ speaker, content: String(content || "").slice(0, 1000) });
    while (rows.length > this.limit) rows.shift();
    this.channels.set(channelId, rows);
  }

  transcript(channelId) {
    return (this.channels.get(channelId) || [])
      .map((row) => `${row.speaker}: ${row.content}`)
      .join("\n");
  }
}

module.exports = { ChannelHistory };
