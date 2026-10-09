# @sealed/web

The Sealed web client (spec §10): Vite 8 + React 19 + react-router 8, TypeScript strict, built on `@sealed/core`.
It does all five modes: Direct, Room, Paired (stored and live WebRTC), Air-gap and Broadcast. Phones that
scan a code with their camera app land here. Receivers do not need an account.

## Run it

```sh
pnpm install                                   # from the repository root
cp apps/web/.env.example apps/web/.env.local   # optional; defaults work for local dev
task -d apps/web dev                           # relay (wrangler dev, :8787) + web (Vite, :5173)
```

To run them without go-task, use `pnpm --filter @sealed/relay exec wrangler d1 migrations apply sealed-meta-dev --local --env dev`,
then `pnpm --filter @sealed/relay exec wrangler dev --env dev`, then `pnpm --filter @sealed/web dev`. The relay's `dev`
environment trusts `http://localhost:5173` for CORS and WebAuthn (RP ID `localhost`). Open the app on
**localhost**, not 127.0.0.1. Otherwise the passkey origin will not match.

| Command | What it does |
|---|---|
| `pnpm --filter @sealed/web typecheck` | strict typecheck of app, unit tests and e2e harness |
| `pnpm --filter @sealed/web test` | Vitest unit tests |
| `pnpm --filter @sealed/web build` | typecheck + production bundle in `dist/` |
| `pnpm --filter @sealed/web e2e` | starts a fresh relay + Vite, runs Playwright (Chromium), stops both |

`e2e/run.mjs` honours `SEALED_E2E_RELAY_URL` / `SEALED_E2E_APP_URL` to reuse servers you already started, and
`SEALED_E2E_VERBOSE=1` to stream their logs.

## Environment (`.env.example`)

| Variable | Purpose |
|---|---|
| `VITE_RELAY_URL` | Default relay. Users can change it under Settings. |
| `VITE_PUBLIC_ORIGIN` | Origin written into displayed codes (default: page origin). Production: `https://sealed.to`. |
| `VITE_ACCEPTED_CODE_ORIGINS` | Other origins whose codes this client will accept. |
| `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY`, `VITE_GOOGLE_APP_ID` | Google Drive Picker (`drive.file`). If any is empty, the Drive button is hidden. |
| `VITE_VAPID_PUBLIC_KEY` | The relay's VAPID public key for Web Push. If empty, the notification settings are hidden. |

## Routes

| Path | Screen |
|---|---|
| `/` | Home: **Share**, **Share offline**, Receive, plus links to Contacts / Inbox / Devices / Settings |
| `/welcome` | Onboarding: create identity · add this browser to my identity · restore with paper key → passkey → paper key |
| `/share` | Direct / Room sender (files, folders, drag-and-drop, Google Drive) |
| `/receive` | Camera scanner + paste; routes any code by kind |
| `/c/:transferId#cs` | Claim landing (also opened directly by phone camera apps) |
| `/pair`, `/p#code` | Pairing ceremony |
| `/contacts`, `/contacts/:fp/send` | Pinned contacts with presence; send to a contact |
| `/inbox` | Mailbox deliveries and live transfers |
| `/devices`, `/devices/add`, `/d#code` | Device list, add device, revoke, paper keys |
| `/offline`, `/offline/send`, `/k#code`, `/offline/receive` | Air-gap sender / receiver |
| `/broadcast`, `/broadcast/receive` | Broadcast sender / receiver |
| `/settings`, `/security` | Name, relay, passkeys, notifications, report; what the relay can see |

The landing paths `/c`, `/p`, `/d` and `/k` match the code URLs in `packages/core/src/protocol/codes.ts`. A
scanned code therefore opens the right screen even when the camera belongs to another app. The secret
fragment is read on the device and then removed from the address bar.

## How it is built

- **Device keys** (`src/lib/webcrypto-keys.ts`): WebCrypto P-256 keys that cannot be exported, stored as
  `CryptoKey` handles in IndexedDB. ECDH `deriveBits(256)` returns the x-coordinate. ECDSA signatures are P1363
  r‖s, normalised to low-S. Key protection is reported as `browser`.
- **Session** (`src/lib/session.ts`): keys, profile, the verified chain (re-verified from link 0 whenever it is
  loaded), `RelayClient`, the presence socket and prekey upkeep. Prekeys are topped up below the low-water mark,
  and the medium-term prekey is rotated through a `rotate_mpk` link under a per-device lock on the chain.
- **Direct / Room** (`src/routes/Share.tsx`, `Claim.tsx`): `startShare` puts the code on screen right away while
  the upload continues. The sender's events WebSocket lists each claim with its label, key-protection badge and
  `sasFor`. Approving calls `webauthnAuthOptions(approvalAction(...))`, which triggers a passkey assertion sent
  as `{kind:"webauthn"}` UV. The receiver runs `claimTransfer` → `waitForApproval` → `downloadTransfer`, writing into
  OPFS (or memory when OPFS is unavailable). Files can be saved one at a time or all together as a zip (fflate).
- **Room approval on the web.** The relay ties every assertion to a single claim and its wrap hash, so a web
  sender needs one passkey prompt per device. *Approve each* puts a button on each row. *Approve in batches*
  walks through the waiting devices, one prompt each. *Auto-approve* queues devices as they arrive and approves
  them in order while the page stays open, still one prompt each; the queue is visible and can be paused. New
  accounts are limited to 50 devices per room. When the relay names that limit, the client retries at 50 and
  says so on screen.
- **Paired** (`src/lib/paired.ts`, `live.ts`, `inbox.ts`): `refreshContactChain` runs before every send, then
  `extendChain` checks the result against all links previously cached for that contact. A fork stores a hard
  block on the contact. If the contact has a device online, `sendLive` signs the offer and answer (with the
  DTLS fingerprint) over the presence socket and streams the Envelope on a data channel. The receiver
  acknowledges each segment once verified. After 15 s with no progress, or on any failure, the client switches
  to `sendToContact` (mailbox) without user action. The inbox loads `client.mailbox()`, refreshes on the
  presence `mailbox` frame, and opens items with `receivePaired` using an IndexedDB `PrekeyStore`. Prekey
  secrets there are HPKE-wrapped (`local`) to the device agreement key.
- **Air-gap / Broadcast** (`src/routes/Offline.tsx`, `components/FacetStream.tsx`, `OpticalCapture.tsx`,
  `workers/facet-decode.worker.ts`): the sender paces frames with `requestAnimationFrame`, counting refreshes
  rather than time, and the hold scales with the measured refresh rate (doubled at 120 Hz). A screen Wake Lock
  keeps the display on. If the user asks for reduced motion, the stream waits behind a confirmation that warns
  about flashing content. The receiver feeds `MediaStreamTrackProcessor` frames (or rVFC + `ImageBitmap`
  frames) to a worker, which runs `FacetReceiver` on an OffscreenCanvas. The device's `CryptoKey`s are
  structured-cloned into the worker. Camera settings are locked after calibration where the platform allows.
  The reverse key code reports T1 only if the camera delivers at least 24 fps at 720p or better, and T0
  otherwise.
- **Google Drive** (`src/lib/gdrive.ts`): Google Identity Services token client plus the Picker
  (`drive.file`). Files are fetched with `files/{id}?alt=media`, and native Google documents are exported to
  PDF. Picked folders are expanded recursively.

## Storage notes (web-specific)

- Contacts are kept in IndexedDB **unencrypted**. They contain only public material and a display name.
  Native clients keep contacts in the encrypted sync blob, which the web client does not implement.
- Received files are stored as plaintext in OPFS until saved, and are deleted when the user leaves the screen
  (anything left over is swept at startup). Native clients encrypt received files at rest per file.
- Clearing site data deletes the device keys. The user needs a paper key or another device to recover.

## Tests

- `test/webcrypto-keys.test.ts`: the DH result matches core's `SoftwareAgreementKey` in both directions;
  compressed peers are handled and invalid points rejected; HPKE Base and Auth work with these keys as recipient
  and sender; signatures are 64 bytes, low-S, and pass `verifyObject`; high-S WebCrypto output is normalised.
- `test/stores.test.ts` (fake-indexeddb): key persistence, profile and chain re-verification, the wrapped
  prekey store (another device's key cannot unwrap it; MPK retention), and contacts.
- `test/routing.test.ts`: code kinds map to landing paths; origin allow-list; friendly error messages.
- `test/frame-scheduler.test.ts`: 60 Hz and 120 Hz holds, jitter and stall tolerance, sizing.
- `test/files.test.ts`: path sanitising, de-duplication, chunked blobs, a round-trip through the Envelope, and
  capability tiers.
- `e2e/sealed.e2e.ts`: two contexts, each with a CDP virtual authenticator, against wrangler dev. Covers
  onboarding; Direct with matching check codes, passkey approval and exact bytes; replayed and denied claims;
  pairing; Paired via mailbox; Paired live over WebRTC; forced live → stored fallback; and Room with batch
  approval and revoke.
- `e2e/optical.e2e.ts`: Chromium's fake camera plays a raw Y4M of Facet frames produced by `FacetSender`.
  Covers Air-gap receive (check code, unwrap with the browser key, exact bytes), unsigned Broadcast receive,
  Air-gap send (frames decoded from the app's canvas), the reduced-motion gate, and adding a device through the
  in-app QR scanner.
