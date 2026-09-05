"""UMBRA · integration credential vault (server-side, encrypted at rest).

Freesound (and any future third-party integration) credentials live HERE,
inside the local Python backend — never in the browser, never in Git, never
in build artifacts. The browser only ever learns whether an integration is
configured and usable.

Storage design (deliberate):

* Credentials are persisted in a small SQLite database as an *encrypted
  envelope* (AES-256-GCM). Someone who obtains the database file alone does
  not obtain the secrets.
* The encryption key never lives in that database. It comes from the
  server-only environment variable ``UMBRA_CREDENTIAL_ENCRYPTION_KEY``
  (or a secret manager that populates it).
* If no encryption key is configured, the vault refuses to store
  credentials — it never falls back to plaintext storage. As an alternative
  for headless setups, credentials can instead be supplied directly through
  ``UMBRA_FREESOUND_*`` environment variables (also server-only).

Key format accepted for ``UMBRA_CREDENTIAL_ENCRYPTION_KEY``:

* base64 / base64url encoded 32 bytes (recommended — generate with
  ``python -m backend.services.credentials generate-key``)
* 64 hex characters
* any other non-empty string, which is treated as a passphrase and
  stretched with scrypt (a random per-record salt is stored in the envelope)

Generate a key::

    python -m backend.services.credentials generate-key
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

# ----------------------------------------------------------------- constants

ENV_KEY = "UMBRA_CREDENTIAL_ENCRYPTION_KEY"
ENV_DATA_DIR = "UMBRA_DATA_DIR"
DB_FILENAME = "integrations.db"

#: Envelope purpose / additional authenticated data — binds ciphertexts to
#: this exact format so a payload cannot be replayed as something else.
_AAD = b"umbra-integration-credentials-v1"
_ENVELOPE_VERSION = 1
_ALG = "AES-256-GCM"

#: Fields kept in the (encrypted) freesound credential payload.
FREESOUND_PAYLOAD_FIELDS = (
    "apiKey",
    "clientId",
    "clientSecret",
    "redirectUri",
    "accessToken",
    "refreshToken",
    "expiresAt",
    "user",
)

#: Secret-bearing fields — never returned by any status endpoint, never
#: logged, redacted everywhere by name and by value.
SECRET_FIELDS = ("apiKey", "clientSecret", "accessToken", "refreshToken")

#: Fields that may be provided through server-side environment variables as
#: a headless alternative to the encrypted database (read-only bootstrap).
FREESOUND_ENV_FIELDS = {
    "apiKey": "UMBRA_FREESOUND_API_KEY",
    "clientId": "UMBRA_FREESOUND_CLIENT_ID",
    "clientSecret": "UMBRA_FREESOUND_CLIENT_SECRET",
    "redirectUri": "UMBRA_FREESOUND_REDIRECT_URI",
    "accessToken": "UMBRA_FREESOUND_ACCESS_TOKEN",
    "refreshToken": "UMBRA_FREESOUND_REFRESH_TOKEN",
    "expiresAt": "UMBRA_FREESOUND_ACCESS_TOKEN_EXPIRES_AT",
}

#: All env vars this module reads (used by tests to isolate the vault).
ALL_ENV_VARS = (ENV_KEY, ENV_DATA_DIR, *FREESOUND_ENV_FIELDS.values())

REDACTED = "***"


class CredentialsError(Exception):
    """Vault misconfiguration or crypto failure — always actionable, never
    contains secret material."""


# ----------------------------------------------------------------- key setup


def _try_decode(raw: str, decoder) -> Optional[bytes]:
    try:
        return decoder(raw)
    except (binascii.Error, ValueError):
        return None


def _direct_key(raw: str) -> Optional[bytes]:
    """Return 32 key bytes if ``raw`` is an encoded 32-byte key."""
    for decoder in (
        lambda s: base64.b64decode(s, validate=True),
        lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)),
        lambda s: bytes.fromhex(s),
    ):
        data = _try_decode(raw.strip(), decoder)
        if data is not None and len(data) == 32:
            return data
    return None


def _scrypt_key(passphrase: str, salt: bytes) -> bytes:
    kdf = Scrypt(salt=salt, length=32, n=2**14, r=8, p=1)
    return kdf.derive(passphrase.encode("utf-8"))


def _b64e(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _b64d(data: str) -> bytes:
    return base64.b64decode(data)


def encrypt_payload(fields: Dict[str, Any], raw_key: str) -> str:
    """Encrypt a credential payload into the JSON envelope stored in the DB."""
    direct = _direct_key(raw_key)
    if direct is not None:
        key, kdf, salt = direct, "direct", None
    else:
        salt = secrets.token_bytes(16)
        key, kdf = _scrypt_key(raw_key, salt), "scrypt"
    nonce = secrets.token_bytes(12)
    plaintext = json.dumps(fields, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, _AAD)
    envelope: Dict[str, Any] = {"v": _ENVELOPE_VERSION, "alg": _ALG, "kdf": kdf}
    if salt is not None:
        envelope["salt"] = _b64e(salt)
    envelope["nonce"] = _b64e(nonce)
    envelope["ct"] = _b64e(ciphertext)
    return json.dumps(envelope, separators=(",", ":"))


def decrypt_payload(payload: str, raw_key: str) -> Dict[str, Any]:
    """Decrypt a stored envelope back into the credential payload."""
    try:
        envelope = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise CredentialsError("stored credential envelope is corrupt") from exc
    if envelope.get("v") != _ENVELOPE_VERSION or envelope.get("alg") != _ALG:
        raise CredentialsError("stored credential envelope has an unknown format")
    salt = _b64d(envelope["salt"]) if envelope.get("salt") else None
    if envelope.get("kdf") == "scrypt":
        if salt is None:
            raise CredentialsError("stored credential envelope is missing its KDF salt")
        key = _scrypt_key(raw_key, salt)
    else:
        key = _direct_key(raw_key)
        if key is None:
            raise CredentialsError(
                "cannot decrypt stored credentials: UMBRA_CREDENTIAL_ENCRYPTION_KEY "
                "does not look like the encoded key that encrypted them"
            )
    try:
        plaintext = AESGCM(key).decrypt(_b64d(envelope["nonce"]), _b64d(envelope["ct"]), _AAD)
    except InvalidTag as exc:
        raise CredentialsError(
            "cannot decrypt stored credentials: wrong UMBRA_CREDENTIAL_ENCRYPTION_KEY "
            "or tampered database"
        ) from exc
    return json.loads(plaintext.decode("utf-8"))


# ------------------------------------------------------------------ redaction

#: Scrub credential-shaped query/body parameters even when the exact value
#: is not in the known-secrets set (defense in depth for exception traces).
_PATTERN_REDACT = re.compile(
    r"(?i)\b((?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|password)"
    r"\s*[=:]\s*)([^\s&'\"]+)"
)


def redact(text: str, secrets_to_redact: Iterable[str] = ()) -> str:
    """Replace known secret values and credential-shaped parameters."""
    for value in secrets_to_redact:
        if value and len(value) >= 4:
            text = text.replace(value, REDACTED)
    return _PATTERN_REDACT.sub(lambda m: f"{m.group(1)}{REDACTED}", text)


class SecretRedactingFilter(logging.Filter):
    """Logging filter that scrubs every known secret value from records.

    Installed on the root handlers at backend startup. This is defense in
    depth — code paths that could touch secrets redact at construction time
    as well; the filter catches anything that slips through (exception
    traces, library warnings, …).
    """

    def __init__(self, store: "CredentialStore"):
        super().__init__()
        self._store = store

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
            scrubbed = redact(message, self._store.known_secrets())
            if scrubbed != message:
                record.msg = scrubbed
                record.args = None
        except Exception:  # never break logging
            pass
        return True


# --------------------------------------------------------------------- store


class CredentialStore:
    """Minimal, provider-scoped credential storage, encrypted at rest."""

    #: Versioned schema migrations, applied in order via PRAGMA user_version.
    MIGRATIONS: Tuple[str, ...] = (
        # 1 — the integration credentials table. Deliberately narrow: one row
        #     per provider, an encrypted payload, and verification bookkeeping.
        """
        CREATE TABLE IF NOT EXISTS integration_credentials (
            provider            TEXT PRIMARY KEY,
            payload             TEXT NOT NULL,
            created_at          REAL NOT NULL,
            updated_at          REAL NOT NULL,
            last_verified_at    REAL,
            verification_status TEXT,
            verification_error  TEXT
        )
        """,
    )

    def __init__(
        self,
        db_path: Optional[Path] = None,
        encryption_key: Optional[str] = None,
    ):
        raw_key = encryption_key if encryption_key is not None else os.environ.get(ENV_KEY, "")
        self._raw_key = (raw_key or "").strip()
        data_dir = Path(os.environ.get(ENV_DATA_DIR) or (Path.cwd() / ".umbra"))
        self.db_path = Path(db_path) if db_path else data_dir / DB_FILENAME
        self._lock = threading.Lock()
        self._migrate()

    # ------------------------------------------------------------ config --

    @property
    def encryption_key_configured(self) -> bool:
        return bool(self._raw_key)

    def _require_key(self) -> str:
        if not self._raw_key:
            raise CredentialsError(
                "UMBRA_CREDENTIAL_ENCRYPTION_KEY is not set on the backend, so "
                "credentials cannot be stored encrypted. Generate one with "
                "`python -m backend.services.credentials generate-key` and set it "
                "in the server environment (or provide credentials via "
                "UMBRA_FREESOUND_* environment variables instead). Plaintext "
                "storage is not supported."
            )
        return self._raw_key

    # ----------------------------------------------------------- sqlite ----

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _migrate(self) -> None:
        with self._lock, closing(self._connect()) as conn:
            (version,) = conn.execute("PRAGMA user_version").fetchone()
            applied = int(version or 0)
            for index, script in enumerate(self.MIGRATIONS[applied:], start=applied + 1):
                conn.executescript(script)
                conn.execute(f"PRAGMA user_version = {index}")
            conn.commit()

    # -------------------------------------------------------------- CRUD ---

    def save(self, provider: str, patch: Dict[str, Any]) -> Dict[str, Any]:
        """Merge ``patch`` into the provider's encrypted payload.

        Only known payload fields are accepted. Empty string / None values
        clear a field. When every field ends up empty the row is deleted.
        """
        fields = dict(self.get(provider) or {})
        for key, value in patch.items():
            if key not in FREESOUND_PAYLOAD_FIELDS:
                continue
            if key == "expiresAt":
                try:
                    fields["expiresAt"] = int(float(value)) if value not in (None, "") else None
                except (TypeError, ValueError):
                    raise CredentialsError("expiresAt must be an epoch-milliseconds number")
            else:
                if value is None:
                    value = ""
                if not isinstance(value, str):
                    raise CredentialsError(f"credential field '{key}' must be a string")
                fields[key] = value
        fields = {k: v for k, v in fields.items() if v not in (None, "")}
        now = time.time()
        with self._lock, closing(self._connect()) as conn:
            if not fields:
                conn.execute("DELETE FROM integration_credentials WHERE provider = ?", (provider,))
                conn.commit()
                return {}
            payload = encrypt_payload(fields, self._require_key())
            conn.execute(
                """
                INSERT INTO integration_credentials (provider, payload, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(provider) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at,
                    last_verified_at = NULL,
                    verification_status = NULL,
                    verification_error = NULL
                """,
                (provider, payload, now, now),
            )
            conn.commit()
        return fields

    def get(self, provider: str) -> Optional[Dict[str, Any]]:
        """Decrypted payload for a provider, or None when nothing is stored."""
        with self._lock, closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT payload FROM integration_credentials WHERE provider = ?", (provider,)
            ).fetchone()
        if row is None:
            return None
        return decrypt_payload(row[0], self._require_key())

    def delete(self, provider: str) -> bool:
        """Remove the provider's stored credentials entirely."""
        with self._lock, closing(self._connect()) as conn:
            cur = conn.execute("DELETE FROM integration_credentials WHERE provider = ?", (provider,))
            conn.commit()
            return cur.rowcount > 0

    def has_record(self, provider: str) -> bool:
        with self._lock, closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT 1 FROM integration_credentials WHERE provider = ?", (provider,)
            ).fetchone()
        return row is not None

    def record_verification(
        self, provider: str, verified: bool, error: Optional[str] = None
    ) -> None:
        """Persist the outcome of a real connection test (no secrets here)."""
        status = "verified" if verified else "failed"
        clean_error = redact((error or "")[:500]) if error else None
        with self._lock, closing(self._connect()) as conn:
            conn.execute(
                """
                UPDATE integration_credentials
                SET last_verified_at = ?, verification_status = ?, verification_error = ?
                WHERE provider = ?
                """,
                (time.time(), status, clean_error if not verified else None, provider),
            )
            conn.commit()

    # -------------------------------------------------------- merging -----

    def _env_credentials(self) -> Dict[str, Any]:
        creds: Dict[str, Any] = {}
        for field, env in FREESOUND_ENV_FIELDS.items():
            value = os.environ.get(env)
            if not value:
                continue
            if field == "expiresAt":
                try:
                    creds["expiresAt"] = int(float(value))
                except ValueError:
                    continue
            else:
                creds[field] = value
        return creds

    def effective_freesound_credentials(self) -> Dict[str, Any]:
        """Server-side credential view: database payload over env fallback.

        The database (explicitly configured in-app) wins per field; the
        ``UMBRA_FREESOUND_*`` environment variables fill in whatever the
        database does not provide. Both sources stay server-side.
        """
        creds = self._env_credentials()
        try:
            stored = self.get("freesound") or {}
        except CredentialsError:
            # Wrong/missing key: env-only credentials still work honestly.
            stored = {}
        creds.update(stored)
        return creds

    def known_secrets(self) -> List[str]:
        """Current non-empty secret values (DB + env) — for log redaction."""
        try:
            creds = self.effective_freesound_credentials()
        except Exception:
            return []
        return [str(creds[f]) for f in SECRET_FIELDS if creds.get(f)]

    # -------------------------------------------------------- status ------

    def freesound_status(self) -> Dict[str, Any]:
        """Safe, honest status view. Contains no secret material — this exact
        shape is what the browser is allowed to know."""
        creds = self.effective_freesound_credentials()
        has_record = False
        verification_status: Optional[str] = None
        verification_error: Optional[str] = None
        last_verified_at: Optional[int] = None
        with self._lock, closing(self._connect()) as conn:
            row = conn.execute(
                """
                SELECT last_verified_at, verification_status, verification_error
                FROM integration_credentials WHERE provider = 'freesound'
                """
            ).fetchone()
        if row is not None:
            has_record = True
            last_verified_s, verification_status, verification_error = row
            last_verified_at = int(last_verified_s * 1000) if last_verified_s else None
            if verification_status == "verified":
                verification_error = None

        now_ms = int(time.time() * 1000)
        expires_at = creds.get("expiresAt")
        expires_known = isinstance(expires_at, (int, float)) and expires_at > 0
        has_access = bool(creds.get("accessToken"))
        oauth_available = has_access and ((expires_at > now_ms) if expires_known else True)
        token_expired = has_access and expires_known and expires_at <= now_ms
        env_fields = set(self._env_credentials())
        storage = "encrypted-db" if has_record else ("env" if env_fields else "none")

        error: Optional[str] = None
        if not self.encryption_key_configured and not env_fields:
            error = (
                "Backend encryption key (UMBRA_CREDENTIAL_ENCRYPTION_KEY) is not "
                "configured — credentials cannot be stored. Set it in the server "
                "environment or provide UMBRA_FREESOUND_* variables."
            )
        if verification_status == "failed" and verification_error:
            error = verification_error

        return {
            "provider": "freesound",
            "configured": bool(
                creds.get("apiKey")
                or creds.get("clientId")
                or creds.get("clientSecret")
                or creds.get("accessToken")
                or creds.get("refreshToken")
            ),
            "searchAvailable": bool(creds.get("apiKey")),
            "oauthAvailable": oauth_available,
            "oauthConfigured": bool(creds.get("clientId") and creds.get("clientSecret")),
            "tokenExpired": token_expired,
            "refreshable": bool(
                creds.get("refreshToken") and creds.get("clientId") and creds.get("clientSecret")
            ),
            "expiresAt": int(expires_at) if expires_known else None,
            "lastVerifiedAt": last_verified_at,
            "verification": verification_status,
            "user": creds.get("user"),
            "redirectUri": creds.get("redirectUri"),
            "error": error,
            "storage": storage,
            "encryptionKeyConfigured": self.encryption_key_configured,
        }


# ------------------------------------------------------------------ singletons

_store: Optional[CredentialStore] = None
_store_lock = threading.Lock()


def get_credential_store() -> CredentialStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = CredentialStore()
    return _store


def reset_credential_store() -> None:
    """Test seam: drop the cached singleton so env changes take effect."""
    global _store
    with _store_lock:
        _store = None


# ------------------------------------------------------------------------ CLI


def _cli(argv: List[str]) -> int:
    if argv[:1] != ["generate-key"]:
        print("usage: python -m backend.services.credentials generate-key", file=sys.stderr)
        return 2
    key = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
    print("# Add this to your backend environment (never to Git):")
    print(f"export UMBRA_CREDENTIAL_ENCRYPTION_KEY={key}")
    print()
    print("# It encrypts integration credentials (e.g. Freesound) at rest in the")
    print("# local database. Losing it makes stored credentials unrecoverable —")
    print("# store it in your secret manager / shell profile, not in the repo.")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
