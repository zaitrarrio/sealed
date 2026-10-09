# @sealed/relay

The Sealed server-blind relay (spec §9, ADR-0012): Cloudflare Workers + Hono, one Durable Object per transfer
(`TransferDO`) and per identity (`IdentityDO`), R2 for ciphertext, D1 for identities, chains and metadata. The
relay stores only ciphertext, hashes of secrets and public keys; it never holds a content key and imports no
unwrap or decrypt function (a test enforces this).

The wire contract is `packages/core/src/protocol/api.ts`. Every request body is validated against those zod
schemas, and every route comes from `Paths`.

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Hono router, middleware (logging, CORS, rate limits), cron sweeper |
| `src/auth.ts` | Device-signed request verification entry, bearer tokens, bounded body reads |
| `src/transfer-do.ts` | Claim race, approvals, claim expiry, upload bookkeeping, download authorization, sender/receiver sockets |
| `src/identity-do.ts` | Verified sigchain + D1 mirror, nonce cache, prekey pools, mailbox, push tokens, WebAuthn challenges, presence/signaling |
| `src/webauthn.ts` | Passkey registration and action-bound assertions (`@simplewebauthn/server`) |
| `src/push.ts` | Web Push (RFC 8291/8292), FCM HTTP v1, APNs |
| `src/turn.ts` | Cloudflare Realtime TURN, coturn shared-secret credentials, STUN fallback |
| `src/log.ts` | Closed log schema, daily-keyed IP hashing (ADR-0015) |
| `src/limits.ts` | Plan and new-account limits, Rate Limiting bindings |
| `migrations/` | D1 schema |
| `test/` | Workers-runtime tests (real DOs, R2, D1 in Miniflare) |
| `test-selfhost/` | End-to-end test over HTTP against a running relay |

## Setup

```sh
pnpm install                         # from the repository root
pnpm --filter @sealed/relay typecheck
pnpm --filter @sealed/relay test
pnpm --filter @sealed/relay db:migrate:local
pnpm --filter @sealed/relay dev      # wrangler dev on http://localhost:8787 (use --env dev for dev vars)
```

`typecheck` first emits declaration files for `@sealed/core` (`tsconfig.core-types.json`, no type checking of
core itself) so the relay checks against core's public types under Workers globals rather than DOM/Node libs.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/v1/health` | none |
| POST | `/v1/identities` | none (genesis link verified with `verifyChain`) |
| GET | `/v1/identities/{fp}/chain?since=` | none |
| POST | `/v1/identities/{fp}/links` | device signature, signer active after applying the links |
| POST | `/v1/identities/{fp}/prekeys` | device signature; a device uploads only its own prekeys |
| GET | `/v1/identities/{fp}/prekeys/count?device=` | device signature (own identity) |
| POST | `/v1/identities/{fp}/prekeys/claim` | any device signature |
| POST | `/v1/transfers` | device signature |
| PUT | `/v1/transfers/{id}/manifest`, `/segments/{n}`, `/padding/{k}` | `Bearer {upload_token}` |
| POST | `/v1/transfers/{id}/finalize` | `Bearer {upload_token}` |
| GET / DELETE | `/v1/transfers/{id}` | device signature (sender) |
| GET (WS) | `/v1/transfers/{id}/events?token=` | upload token |
| POST | `/v1/transfers/{id}/claims` | claim secret |
| POST | `/v1/transfers/{id}/claims/{cid}/approve` | device signature (sender) + UV evidence |
| POST | `/v1/transfers/{id}/claims/{cid}/deny` | device signature (sender) |
| DELETE | `/v1/transfers/{id}/claims/{cid}` | device signature (sender), revoke |
| GET | `/v1/transfers/{id}/claims/{cid}/wrap` | `Bearer {claim_token}` |
| POST | `/v1/transfers/{id}/claims/{cid}/complete` | `Bearer {claim_token}` |
| GET | `/v1/transfers/{id}/manifest`, `/segments/{n}` | claim token, or device signature holding a mailbox delivery |
| GET | `/v1/claims/{cid}?wait=` (≤ 25 s long-poll) | `Bearer {claim_token}` |
| GET (WS) | `/v1/claims/{cid}/events?token=` | claim token |
| POST | `/v1/mailbox/{fp}` | device signature (sender of the transfer) |
| GET | `/v1/mailbox` | device signature (items for the signing device only) |
| DELETE | `/v1/mailbox/items/{transfer_id}` | device signature |
| GET (WS) | `/v1/presence?sig=` | device signature over `GET` + path without query |
| GET | `/v1/turn` | device signature |
| POST | `/v1/devices/push` | device signature |
| POST | `/v1/webauthn/register/options`, `/register/verify`, `/authenticate/options` | device signature |
| POST | `/v1/reports` | claim token or device signature |

Errors are `{"error": ErrorCode, "message"?: string}` with the HTTP status codes the spec names
(`409 claim_consumed`, `410 claim_window_closed`, `429 room_full`, `410 revoked`, `409 chain_invalid`, …).

### Notes on behavior

- **Claim race.** The TransferDO checks and consumes the Direct claim in one synchronous step, so exactly one
  claim is ever accepted. `H(cs)` is compared in constant time. Claim tokens are `{transfer_id}.{secret}` (opaque
  to clients) so the Worker can route them to the right object; only their SHA-256 is stored.
- **Approval UV.** `{"kind":"device"}` is accepted only when the approving device's chain entry declares
  `secure-enclave`, `strongbox` or `tee`. `{"kind":"webauthn"}` must be an assertion with the UV flag from a
  passkey registered to the identity, over a challenge issued by `/v1/webauthn/authenticate/options` for exactly
  `approve:{transferId}:{claimId}:{b64url(sha256(wrap))}`. Challenges are single-use and expire after 5 minutes.
- **Sockets.** WebSockets use the Hibernatable WebSocket API. The sender socket replays existing claims on
  connect; the receiver socket sends the current status first. Presence `{"type":"ping"}` is auto-answered
  without waking the object.
- **Expiry.** Unapproved claims expire after 120 s by DO alarm. Transfers expire at their TTL by DO alarm, which
  deletes R2 objects and marks the D1 row. Direct wraps are deleted 1 hour after the receiver confirms. Mailbox
  items expire with the transfer. The cron sweeper (`17 * * * *`) catches anything an alarm missed, including
  R2 objects whose `expires` metadata has passed.

## Secrets and variables

Set secrets with `wrangler secret put NAME` (add `--env dev` for the dev environment).

| Name | Kind | Purpose |
|---|---|---|
| `IP_HASH_SECRET` | secret | Root key for the daily-rotating IP hash (ADR-0015). Required in production. |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | secret | Cloudflare Realtime TURN credential issuance. STUN-only without them. |
| `TURN_URLS`, `TURN_SHARED_SECRET` | var/secret | Self-hosted coturn (`use-auth-secret`), instead of Cloudflare TURN. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | secret | Web Push. Uncompressed P-256 public key and raw 32-byte private key, base64url. |
| `VAPID_SUBJECT` | var | `mailto:` or https contact for VAPID. |
| `FCM_SERVICE_ACCOUNT_JSON` | secret | Firebase service-account JSON (needs `cloudmessaging` permission). |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`, `APNS_BUNDLE_ID` | secret | APNs token auth (`.p8` PKCS#8 PEM). |
| `APNS_ENVIRONMENT` | var | `production` (default) or `sandbox`. |
| `ALLOWED_ORIGINS` | var | Comma-separated web origins for CORS. |
| `PUBLIC_URL` | var | Base URL used to build `events_url`s. Empty means the request origin. |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN` | var | Passkey relying party and accepted origins. |

Generate VAPID keys with any Web Push tool, or with Node:

```sh
node -e 'const c=require("crypto");const k=c.generateKeyPairSync("ec",{namedCurve:"P-256"});const j=k.privateKey.export({format:"jwk"});const pub=Buffer.concat([Buffer.from([4]),Buffer.from(j.x,"base64url"),Buffer.from(j.y,"base64url")]);console.log("VAPID_PUBLIC_KEY="+pub.toString("base64url"));console.log("VAPID_PRIVATE_KEY="+j.d)'
```

## Deployment

```sh
wrangler d1 create sealed-meta                # put the database_id into wrangler.jsonc
wrangler r2 bucket create sealed-transfers
# Backstop lifecycle rule (spec §9.4): DO alarms and the hourly sweeper delete at TTL; this catches anything else.
wrangler r2 bucket lifecycle add sealed-transfers expire-8d "t/" --expire-days 8 --abort-multipart-days 1 -y
pnpm --filter @sealed/relay db:migrate:remote
wrangler secret put IP_HASH_SECRET            # and the optional secrets above
pnpm --filter @sealed/relay deploy
```

`pnpm --filter @sealed/relay build` bundles to `dist/` without deploying (`wrangler deploy --dry-run`). The
Rate Limiting namespaces in `wrangler.jsonc` (`1001`–`1003`) must be unique within the account.

`compatibility_date` is `2026-08-15`, the newest date the pinned test runtime supports
(`@cloudflare/vitest-pool-workers` 0.23.0 ships workerd 2026-08-22), so tests run with production semantics.
`nodejs_compat` is not needed.

## Self-hosting

`deploy/selfhost/` runs the same `dist/index.js` on workerd through Miniflare, with Durable Objects, R2 and D1
persisted in a Docker volume. The optional `turn` profile adds coturn.

```sh
cp deploy/selfhost/.env.example deploy/selfhost/.env
docker compose -f deploy/selfhost/docker-compose.yml up -d --build
curl http://localhost:8787/v1/health
RELAY_URL=http://localhost:8787 pnpm --filter @sealed/relay test:selfhost
docker compose -f deploy/selfhost/docker-compose.yml down
```

Behind a TLS-intercepting proxy, point `SEALED_BUILD_CA_FILE` at its CA bundle for the build. It is mounted as a
BuildKit secret and is not stored in the image. Rate limiting is a no-op without the Cloudflare binding, so put
your own edge limits in front of a self-hosted relay.

## Tests

`pnpm --filter @sealed/relay test` runs in the Workers runtime with real Durable Objects, R2 and D1:

- Direct: the full flow through `RelayClient` (`startShare` → `claimTransfer` → SAS equality → device-UV approve →
  `waitForApproval` → `downloadTransfer`, exact bytes); replayed claims (409); 50 concurrent claims with exactly one
  accepted; deny; sender-only actions; claim expiry by alarm; transfer expiry by alarm and by the sweeper; cancel.
- Room: cap (429), window (410), revoke (410 for wrap and ciphertext), 7-day TTL cap.
- Uploads: token checks, size limits, short last segment, finalize validation, part leases.
- Identities: genesis verification, `?since`, forks and skipped seqs (409), stranger and revoked signers,
  paper-key recovery where the new device signs.
- Request signatures: replay, stale timestamp, body tampering, query binding.
- Paired: one-time prekey hand-out, `sendToContact` → mailbox → `receivePaired` with exact bytes, self-copy to the
  sender's second device, device-key fallback, delivery validation.
- Presence: signaling between identities and to one device, presence counts, ping/pong, socket auth and replay.
- WebAuthn: registration and an action-bound approval from a software ES256 authenticator; wrong action,
  missing UV, foreign passkey, challenge replay and wrong origin are rejected.
- Push: the RFC 8291 Appendix A vector, plus Web Push, FCM and APNs request shapes and signature checks.
- TURN, CORS, rate-limit mapping, error bodies, the log schema (no raw IPs), and the relay-blind import check.
