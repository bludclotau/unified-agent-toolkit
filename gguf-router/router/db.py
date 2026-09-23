import json
import os
import threading
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

import psycopg2
import psycopg2.extras

import cred_crypto

_write_lock = threading.Lock()


def async_write(func, *args):
    threading.Thread(target=func, args=args, daemon=True).start()


def log_tool(user_id, tool_name, output):
    async_write(save_raw_output, f"tool:{user_id}:{tool_name}", str(output))

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    user_id TEXT,
    bot_name TEXT,
    persona TEXT,
    task TEXT,
    last_message TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cache (
    id SERIAL PRIMARY KEY,
    key TEXT UNIQUE,
    value TEXT,
    expires_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tools (
    id SERIAL PRIMARY KEY,
    bot_name TEXT,
    tool_name TEXT,
    tool_state JSONB,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    persona JSONB,
    capabilities JSONB
);

CREATE TABLE IF NOT EXISTS credentials (
    id SERIAL PRIMARY KEY,
    agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
    site TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    UNIQUE (agent_id, site)
);
"""


def _load_dotenv() -> None:
    for candidate in (
        Path(__file__).resolve().parent.parent / ".env",
        Path(__file__).resolve().parent / ".env",
    ):
        if not candidate.is_file():
            continue
        for raw_line in candidate.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _connect():
    dsn = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_DSN")
    if dsn:
        return psycopg2.connect(dsn)
    try:
        return psycopg2.connect(
            dbname="postgres",
            user="postgres",
            host="localhost",
        )
    except psycopg2.OperationalError:
        return psycopg2.connect(
            dbname=os.environ.get("PGDATABASE", "postgres"),
            user=os.environ.get("PGUSER", "postgres"),
            host=os.environ.get("PGHOST", "localhost"),
            password=os.environ.get("PGPASSWORD"),
        )


conn = _connect()


def _cursor(dict_cursor=False):
    global conn
    if conn is None or conn.closed:
        conn = _connect()
    factory = psycopg2.extras.DictCursor if dict_cursor else None
    return conn.cursor(cursor_factory=factory) if factory else conn.cursor()


def _run_write(sql, params):
    with _write_lock:
        cur = _cursor()
        cur.execute(sql, params)
        conn.commit()
        cur.close()


def _host(site_or_url: str) -> str:
    raw = (site_or_url or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        return raw.lower().split("/")[0]
    return (urlparse(raw).hostname or "").lower()


def ensure_agent(name):
    if not name:
        name = "unknown"
    name = str(name).lower()
    persona = json.dumps({"label": name})
    caps = json.dumps(["browser", "web_fetch"])
    with _write_lock:
        cur = _cursor()
        cur.execute(
            """
            INSERT INTO agents (name, persona, capabilities)
            VALUES (%s, %s::jsonb, %s::jsonb)
            ON CONFLICT (name) DO UPDATE
            SET capabilities = EXCLUDED.capabilities
            RETURNING id
            """,
            (name, persona, caps),
        )
        row = cur.fetchone()
        conn.commit()
        cur.close()
    return int(row[0]) if row else None


def upsert_credential(agent_name, site, payload):
    """Encrypt username/password into credentials.encrypted_key."""
    agent_id = ensure_agent(agent_name)
    blob = cred_crypto.encrypt_payload(payload if isinstance(payload, dict) else {"value": str(payload)})
    host = _host(site) or site
    _run_write(
        """
        INSERT INTO credentials (agent_id, site, encrypted_key)
        VALUES (%s, %s, %s)
        ON CONFLICT (agent_id, site) DO UPDATE
        SET encrypted_key = EXCLUDED.encrypted_key
        """,
        (agent_id, host, blob),
    )


def migrate_credentials():
    """Rewrite legacy plaintext JSON rows as enc:v1 Fernet tokens."""
    with _write_lock:
        cur = _cursor(dict_cursor=True)
        cur.execute("SELECT id, encrypted_key FROM credentials")
        rows = list(cur.fetchall() or [])
        cur.close()
    for row in rows:
        blob = row["encrypted_key"]
        if cred_crypto.is_encrypted(blob):
            continue
        try:
            payload = cred_crypto.decrypt_blob(blob)
            sealed = cred_crypto.encrypt_payload(payload)
        except Exception:
            continue
        _run_write(
            "UPDATE credentials SET encrypted_key = %s WHERE id = %s",
            (sealed, row["id"]),
        )


def get_credential(agent_name, site_or_url):
    agent_id = ensure_agent(agent_name)
    host = _host(site_or_url)
    with _write_lock:
        cur = _cursor(dict_cursor=True)
        cur.execute(
            "SELECT id, site, encrypted_key FROM credentials WHERE agent_id = %s",
            (agent_id,),
        )
        rows = cur.fetchall()
        cur.close()
    for row in rows:
        site = (row["site"] or "").lower()
        if not site:
            continue
        if host == site or host.endswith("." + site):
            try:
                data = cred_crypto.decrypt_blob(row["encrypted_key"])
            except Exception:
                return None
            if not cred_crypto.is_encrypted(row["encrypted_key"]):
                try:
                    _run_write(
                        "UPDATE credentials SET encrypted_key = %s WHERE id = %s",
                        (cred_crypto.encrypt_payload(data), row["id"]),
                    )
                except Exception:
                    pass
            if isinstance(data, dict):
                data.setdefault("site", site)
                return data
    return None


def init_schema() -> bool:
    with _write_lock:
        cur = _cursor()
        cur.execute(SCHEMA_SQL)
        conn.commit()
        cur.close()
    try:
        migrate_credentials()
    except Exception:
        pass
    return True


def save_raw_output(key, value):
    _run_write(
        """
        INSERT INTO cache (key, value, expires_at)
        VALUES (%s, %s, %s)
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at;
        """,
        (key, value, datetime.now() + timedelta(minutes=10)),
    )


def get_cached(key):
    with _write_lock:
        cur = _cursor(dict_cursor=True)
        cur.execute("SELECT value, expires_at FROM cache WHERE key = %s", (key,))
        row = cur.fetchone()
        cur.close()
    if not row:
        return None
    expires_at = row["expires_at"]
    if expires_at is not None:
        now = datetime.now(expires_at.tzinfo) if getattr(expires_at, "tzinfo", None) else datetime.now()
        if expires_at < now:
            return None
    return row["value"]


def set_cooldown(user_id, seconds):
    _run_write(
        """
        INSERT INTO cache (key, value, expires_at)
        VALUES (%s, %s, %s)
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at;
        """,
        (f"cooldown:{user_id}", "1", datetime.now() + timedelta(seconds=seconds)),
    )


def check_cooldown(user_id):
    return get_cached(f"cooldown:{user_id}") is not None


def update_conversation(user_id, bot_name, persona, task, last_message):
    _run_write(
        """
        INSERT INTO conversations (user_id, bot_name, persona, task, last_message)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (user_id, bot_name, persona, task, last_message),
    )


def get_persona_memory(user_id, persona):
    with _write_lock:
        cur = _cursor(dict_cursor=True)
        cur.execute(
            """
            SELECT last_message FROM conversations
            WHERE user_id = %s AND persona = %s
            ORDER BY updated_at DESC LIMIT 1
            """,
            (user_id, persona),
        )
        row = cur.fetchone()
        cur.close()
    return row["last_message"] if row else None


def get_last_message(user_id=None, bot_name=None):
    clauses = []
    params = []
    if user_id:
        clauses.append("user_id = %s")
        params.append(user_id)
    if bot_name:
        clauses.append("bot_name = %s")
        params.append(bot_name)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with _write_lock:
        cur = _cursor(dict_cursor=True)
        cur.execute(
            f"""
            SELECT user_id, bot_name, persona, task, last_message, updated_at
            FROM conversations
            {where}
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            """,
            params,
        )
        row = cur.fetchone()
        cur.close()
    return dict(row) if row else None
