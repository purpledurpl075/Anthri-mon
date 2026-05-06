"""AES-256-GCM encryption matching the Go collector's wire format.

Wire format: base64url( nonce_12_bytes || ciphertext_and_tag )
Key source:  ANTHRIMON_ENCRYPTION_KEY env var (64 lowercase hex chars = 32 bytes)
"""
from __future__ import annotations

import base64
import binascii
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _load_key() -> bytes:
    hex_key = os.environ.get("ANTHRIMON_ENCRYPTION_KEY", "").strip()
    if not hex_key:
        raise RuntimeError(
            "ANTHRIMON_ENCRYPTION_KEY is not set — cannot encrypt/decrypt secrets"
        )
    try:
        raw = binascii.unhexlify(hex_key)
    except binascii.Error as exc:
        raise ValueError("ANTHRIMON_ENCRYPTION_KEY must be 64 lowercase hex chars") from exc
    if len(raw) != 32:
        raise ValueError("ANTHRIMON_ENCRYPTION_KEY must be 64 hex chars (32 bytes)")
    return raw


def is_configured() -> bool:
    return bool(os.environ.get("ANTHRIMON_ENCRYPTION_KEY", "").strip())


def encrypt(plaintext: str) -> str:
    """Return base64url(nonce_12 || ciphertext+tag)."""
    key = _load_key()
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plaintext.encode(), None)
    return base64.urlsafe_b64encode(nonce + ct).decode()


def decrypt(blob: str) -> str:
    """Decrypt a blob produced by encrypt(). Raises on bad key or tampered data."""
    key = _load_key()
    data = base64.urlsafe_b64decode(blob)
    if len(data) < 12:
        raise ValueError("Ciphertext too short")
    plaintext = AESGCM(key).decrypt(data[:12], data[12:], None)
    return plaintext.decode()
