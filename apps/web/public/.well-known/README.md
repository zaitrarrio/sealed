# App association files

Served at `https://<web origin>/.well-known/` so a phone camera that scans a Sealed code opens the native app
(iOS universal links, Android verified app links) instead of the web client.

The iOS app ID is `P55B7RX799.to.sealed.app` (Saije Ventures team + `SEALED_IOS_BUNDLE_ID`). Before deploying,
replace the Android fingerprint with the release signing certificate's SHA-256 (Play Console → App integrity,
or `keytool -list -v`). The package must match `SEALED_ANDROID_PACKAGE` used to build `apps/mobile`.

`apple-app-site-association` must be served as `application/json` without a redirect.
