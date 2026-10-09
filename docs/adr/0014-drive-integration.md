# ADR-0014: Cloud-drive sources with least-privilege scopes and client-side encryption

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §6.7, test suite `sources/`

## Context

A core use case is "share anything from my Google Drive by showing my screen." Broad Drive scopes (`drive`, `drive.readonly`) are classified by Google as restricted and require an annual third-party security assessment, and they let the app read everything in a user's Drive. Sealed's privacy promise means the relay must never see plaintext, so the file cannot be fetched server-side.

## Decision

- Use the **Google Picker API** with the **`drive.file`** scope. The user explicitly selects files or folders in Google's own picker UI; Sealed gains access only to what was picked. Folder selection grants access to the folder's contents for that session's export.
- The **sender's client** downloads the selected files directly from Google (including export of Google Docs/Sheets/Slides to the user's choice of PDF or Office format), builds the Envelope, encrypts it and uploads ciphertext to the relay. OAuth tokens stay on the client; the relay never holds Google credentials.
- The source connector is an interface (`Source { list, read_stream, export }`) so OneDrive (Microsoft Graph with File Picker), Dropbox (Chooser) and iCloud (system document picker) follow the same pattern.
- Large selections stream: the client pipes download → zstd → encrypt → multipart upload with bounded memory (≈ 16 MiB working set).

## Alternatives considered

- **Server-side fetch with `drive.readonly`.** Faster for the sender on mobile data, but breaks server-blindness and requires restricted-scope assessment. Rejected.
- **Share-link handoff (sending a Drive link).** No encryption, forwardable, and recipients need Google access. Rejected; this is the status quo Sealed replaces.

## Consequences

- Sender bandwidth carries the file twice (down from Drive, up to relay). Acceptable on Wi-Fi; on mobile data the UI warns above 100 MB and offers "send when on Wi-Fi."
- Picker-based UX means no background sync of Drive; Sealed is a sharing tool, not a sync client.

## Verification

- `sources/scope`: OAuth configuration test asserts only `drive.file` (plus `openid`/`email` if needed) is requested.
- `sources/stream`: a 5 GB synthetic Drive file is shared with resident memory below 64 MB.
- `sources/export`: Google-native documents export to the selected format with correct media type in the manifest.
