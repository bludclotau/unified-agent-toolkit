-- Full Discord transcript written by the orchestrator.
-- The gguf-router conversations table stays a per-user last-line cache.

CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    channel_id TEXT NOT NULL,
    guild_id TEXT,
    discord_message_id TEXT,
    author_id TEXT,
    author_name TEXT,
    bot_name TEXT,
    direction TEXT NOT NULL,
    content TEXT,
    persona TEXT,
    chain_depth INTEGER,
    energy REAL,
    skip_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_channel_created_idx
    ON messages (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_bot_created_idx
    ON messages (bot_name, created_at DESC);
