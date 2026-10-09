-- Sealed relay metadata schema v1 (spec §9.3, adapted).
-- Deviations from the spec sketch:
--  * Fingerprints, key ids and hashes are stored as base64url TEXT (the wire form), which keeps D1 rows
--    readable and avoids BLOB round-trip ambiguity in the D1 client.
--  * An identity *is* the sender account (ADR-0015 "account backed by a passkey and a verified device"):
--    `plan` and `created_at` live on `identities`, and passkeys are registered per identity fingerprint.
--  * Claims, prekey pools, mailbox entries, nonces and WebAuthn challenges live in Durable Object storage,
--    not D1, for single-writer consistency (spec §9.3, last paragraph).

CREATE TABLE identities (
  fp          TEXT PRIMARY KEY,               -- b64url(SHA-256(link 0))
  created_at  INTEGER NOT NULL,               -- unix seconds
  head_seq    INTEGER NOT NULL,
  head_hash   TEXT NOT NULL,                  -- b64url(SHA-256(head link))
  plan        TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'plus', 'teams', 'enterprise'))
);

CREATE TABLE links (
  fp    TEXT NOT NULL,
  seq   INTEGER NOT NULL,
  hash  TEXT NOT NULL,                        -- b64url(SHA-256(body))
  body  TEXT NOT NULL,                        -- b64url(canonical CBOR link)
  PRIMARY KEY (fp, seq)
);

CREATE TABLE devices (
  fp           TEXT NOT NULL,
  dsk_id       TEXT NOT NULL,                 -- b64url(compressed device signing key)
  dak_pub      TEXT NOT NULL,                 -- b64url(compressed device agreement key)
  dsk_pub      TEXT NOT NULL,                 -- b64url(uncompressed device signing key)
  protection   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  added_seq    INTEGER NOT NULL,
  revoked_seq  INTEGER,
  PRIMARY KEY (fp, dsk_id)
);

CREATE TABLE passkeys (
  credential_id  TEXT PRIMARY KEY,            -- b64url credential id
  fp             TEXT NOT NULL,
  public_key     TEXT NOT NULL,               -- b64url COSE public key
  sign_count     INTEGER NOT NULL,
  transports     TEXT,                        -- JSON array or NULL
  created_at     INTEGER NOT NULL
);
CREATE INDEX passkeys_fp ON passkeys(fp);

CREATE TABLE transfers (
  transfer_id   TEXT PRIMARY KEY,
  sender_fp     TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('direct', 'room', 'paired')),
  size_bucket   INTEGER NOT NULL,
  created_hour  INTEGER NOT NULL,             -- unix seconds rounded down to the hour (ADR-0015)
  expires_at    INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('open', 'uploaded', 'cancelled', 'expired'))
);
CREATE INDEX transfers_expiry ON transfers(status, expires_at);
CREATE INDEX transfers_sender ON transfers(sender_fp, created_hour);

CREATE TABLE reports (
  report_id        TEXT PRIMARY KEY,
  transfer_id      TEXT NOT NULL,
  sender_fp        TEXT,                      -- resolved from transfers at report time
  reporter_kind    TEXT NOT NULL CHECK (reporter_kind IN ('claim', 'device')),
  reporter         TEXT NOT NULL,             -- claim id or reporter fingerprint
  reason           TEXT NOT NULL,
  details          TEXT,
  evidence_sha256  TEXT,
  ip_hash          TEXT,                      -- daily-keyed hash; retained because it is tied to a report
  created_hour     INTEGER NOT NULL
);
CREATE INDEX reports_transfer ON reports(transfer_id);
