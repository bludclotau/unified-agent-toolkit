"""Symmetric encryption for credentials.encrypted_key.

Fernet (AES-128-CBC + HMAC-SHA256). The key lives outside the repo and
outside Postgres: CREDENTIALS_KEY, or /etc/gguf-router/credentials.key.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

PREFIX = "enc:v1:"
DEFAULT_KEY_FILE = Path("/etc/gguf-router/credentials.key")

_fernet: Fernet | None = None


def _load_key() -> bytes:
    env = os.environ.get("CREDENTIALS_KEY", "").strip().strip('"').strip("'")
    if env:
        return env.encode("ascii")
    path = Path(os.environ.get("CREDENTIALS_KEY_FILE", str(DEFAULT_KEY_FILE)))
    if path.is_file():
        return path.read_bytes().strip()
    raise RuntimeError("CREDENTIALS_KEY is not configured")


def reset_for_tests() -> None:
    global _fernet
    _fernet = None


def _fernet_box() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_key())
    return _fernet


def is_encrypted(blob: str | None) -> bool:
    return isinstance(blob, str) and blob.startswith(PREFIX)


def encrypt_payload(payload: dict) -> str:
    plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    token = _fernet_box().encrypt(plaintext).decode("ascii")
    return PREFIX + token


def decrypt_blob(blob: str) -> dict:
    if not blob:
        raise ValueError("empty credential blob")
    if is_encrypted(blob):
        token = blob[len(PREFIX):].encode("ascii")
        try:
            raw = _fernet_box().decrypt(token)
        except InvalidToken as exc:
            raise ValueError("credential decrypt failed") from exc
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("credential payload is not an object")
        return data
    try:
        data = json.loads(blob)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, TypeError):
        pass
    return {"password": blob}
