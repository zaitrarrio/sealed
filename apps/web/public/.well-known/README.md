# App association files

Served at `https://<web origin>/.well-known/` so a phone camera that scans a Sealed code opens the native app
(iOS universal links, Android verified app links) instead of the web client.

Before deploying, replace `TEAMID` with your Apple Developer Team ID and the Android fingerprint with your
release signing certificate's SHA-256 (Play Console → App integrity, or `keytool -list -v`). The bundle id
and package must match `SEALED_IOS_BUNDLE_ID` / `SEALED_ANDROID_PACKAGE` used to build `apps/mobile`.

`apple-app-site-association` must be served as `application/json` without a redirect.
