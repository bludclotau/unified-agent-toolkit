const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SCHEMA = fs.readFileSync(path.join(__dirname, "../../sql/messages.sql"), "utf8");

class MessageLog {
  constructor(databaseUrl) {
    this.databaseUrl = databaseUrl;
    this.pool = null;
  }

  async init() {
    if (!this.databaseUrl) {
      console.warn("DATABASE_URL is unset; message log is disabled");
      return;
    }
    this.pool = new Pool({ connectionString: this.databaseUrl });
    await this.pool.query(SCHEMA);
  }

  async logMessage(row) {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO messages (
         channel_id, guild_id, discord_message_id, author_id, author_name,
         bot_name, direction, content, persona, chain_depth, energy, skip_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        row.channelId || "",
        row.guildId || null,
        row.discordMessageId || null,
        row.authorId || null,
        row.authorName || null,
        row.botName || null,
        row.direction,
        row.content || null,
        row.persona || null,
        row.chainDepth ?? null,
        row.energy ?? null,
        row.skipReason || null,
      ]
    );
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

module.exports = { MessageLog };
