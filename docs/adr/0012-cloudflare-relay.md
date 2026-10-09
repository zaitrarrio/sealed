# ADR-0012: A server-blind relay on Cloudflare

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §9, test suite `relay/`

## Context

The relay stores ciphertext, coordinates claims and approvals in real time, serves sigchains and prekeys, and signals WebRTC sessions. It must be global (transfers happen wherever people meet), cheap at idle, strongly consistent per transfer (one claim wins), and unable to read content.

## Decision

| Concern | Service |
|---|---|
| API edge | Cloudflare Workers (TypeScript, Hono) |
| Per-transfer coordination (claim race, approval, WebSocket push to sender) | Durable Objects, one per `transfer_id` |
| Per-user presence and mailbox index | Durable Objects, one per identity fingerprint |
| Ciphertext and wraps | R2, object keys `t/{transfer_id}/{segment}`; lifecycle rules delete at TTL; uploads via presigned multipart |
| Sigchains, prekey pools, account metadata | D1 (SQLite) with per-identity rows; prekey hand-out runs inside the identity Durable Object to guarantee single use |
| WebRTC relay when peer-to-peer fails | Cloudflare Realtime TURN |
| Expiry sweeps, abuse signals | Queues + Cron Triggers |
| Rate limiting | Workers Rate Limiting binding, keyed by device key hash and IP prefix |

Durable Objects give single-threaded, strongly consistent state per transfer, which makes the "exactly one Direct claim" guarantee straightforward. R2 has no egress fees, which matters for a product whose core action is downloads.

**Self-hosted relay** for government and enterprise: the relay is packaged so the same Worker code runs on `workerd` with MinIO (S3-compatible) and SQLite/Postgres, deployable in an isolated network via Docker Compose. Durable Objects map to `workerd`'s local implementation.

## Alternatives considered

- **AWS (Lambda + DynamoDB + S3).** Mature GovCloud story; egress costs and per-transfer consistency need more machinery. Kept as a possible GovCloud deployment target for the self-hosted package.
- **Single-region VM + Postgres.** Simple, but poor latency at the moment of a scan, which is when users feel speed. Rejected.

## Consequences

- No server-side decryption code exists anywhere in the relay repository; a lint rule forbids importing crypto unwrap functions there.
- Vendor concentration on Cloudflare is mitigated by the `workerd` self-hosted path.

## Verification

- `relay/claim.do`: Durable Object race tests (see ADR-0004).
- `relay/ttl`: R2 lifecycle and sweeper delete objects within 1 hour after expiry in staging.
- `relay/selfhost`: the full end-to-end suite passes against the Docker Compose stack in CI.
- `relay/blind`: static check that the relay package does not depend on `sealed-core` decryption exports.
