import CryptoKit
import DeviceCheck
import ExpoModulesCore
import LocalAuthentication

/// Options for key generation, mirrored by `GenerateOptions` in index.ts.
struct GenerateOptions: Record {
  /// "biometry-current-set" (Face ID / Touch ID, invalidated on enrollment change) or "user-presence".
  @Field var policy: String = KeyPolicy.biometryCurrentSet.rawValue
  /// Seconds one authentication unlocks the signing key for (relay requests, links, manifests).
  @Field var signingWindowSeconds: Int = 300
  /// Seconds one authentication unlocks the agreement key for (one unwrap is at most two ECDH operations).
  @Field var agreementWindowSeconds: Int = 15
}

/// How an operation may involve the user (same contract as the Android module):
///   silent  never prompt; reject with ERR_AUTH_REQUIRED when no authenticated session is open
///   window  reuse an authenticated session if one is open, otherwise prompt once
///   fresh   always prompt (approvals and identity changes)
private enum AuthMode: String {
  case silent, window, fresh
}

private enum Purpose: String {
  case sign, agree
}

/// Per-key-purpose authentication windows and the biometric domain state captured at generation.
private struct WindowConfig: Codable {
  let signingWindow: Int
  let agreementWindow: Int
  let domainState: String?
}

/// Sealed device keys (spec §5.2, ADR-0005) in the Secure Enclave, gated by Face ID / Touch ID or the passcode.
///
/// One `LAContext` per alias and purpose is authenticated with `evaluatePolicy` and then handed to CryptoKit
/// for each Secure Enclave operation, so a single prompt covers every operation inside the purpose's window
/// (a whole HPKE unwrap, or a burst of signed relay requests). Contexts are invalidated when their window ends.
public final class SealedKeystoreModule: Module {
  private let store = DeviceKeyStore()
  private let queue = DispatchQueue(label: "to.sealed.keystore", qos: .userInitiated)
  private let sessionLock = NSLock()
  private var sessions: [String: (context: LAContext, expires: Date)] = [:]

  private static let windowsKeyPrefix = "to.sealed.keystore.windows."
  private static let appAttestKeyId = "to.sealed.keystore.appattest.keyid"

  public func definition() -> ModuleDefinition {
    Name("SealedKeystore")

    Function("getCapabilities") { () -> [String: Any] in
      let ctx = LAContext()
      var biometrics = "unavailable"
      var error: NSError?
      if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
        biometrics = "available"
      } else if let code = error?.code, code == LAError.biometryNotEnrolled.rawValue {
        biometrics = "not-enrolled"
      }
      return [
        "platform": "ios",
        "secureHardware": SecureEnclave.isAvailable,
        "strongBox": false,
        "biometrics": biometrics,
        "deviceCredential": LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil),
      ]
    }

    AsyncFunction("generateDeviceKeys") { (alias: String, options: GenerateOptions, promise: Promise) in
      self.queue.async {
        do {
          guard let policy = KeyPolicy(rawValue: options.policy) else { throw KeystoreError.badInput("Unknown key policy \(options.policy)") }
          if options.signingWindowSeconds < 1 || options.agreementWindowSeconds < 1 {
            throw KeystoreError.badInput("Authentication windows must be at least one second")
          }
          let record = try self.store.generate(alias: alias, policy: policy)
          self.saveWindows(alias, WindowConfig(signingWindow: options.signingWindowSeconds, agreementWindow: options.agreementWindowSeconds, domainState: Self.currentDomainState()))
          promise.resolve(record.toDictionary())
        } catch {
          self.reject(promise, error)
        }
      }
    }

    AsyncFunction("getDeviceKeys") { (alias: String, promise: Promise) in
      self.queue.async {
        do {
          promise.resolve(try self.store.record(alias: alias)?.toDictionary())
        } catch {
          self.reject(promise, error)
        }
      }
    }

    AsyncFunction("deleteDeviceKeys") { (alias: String, promise: Promise) in
      self.queue.async {
        do {
          try self.store.delete(alias: alias)
          self.endSessions(alias)
          UserDefaults.standard.removeObject(forKey: Self.windowsKeyPrefix + alias)
          promise.resolve(nil)
        } catch {
          self.reject(promise, error)
        }
      }
    }

    AsyncFunction("authenticate") { (alias: String, reason: String, promise: Promise) in
      self.authorize(alias: alias, purpose: .sign, reason: reason, mode: .fresh, promise: promise) { _ in nil }
    }

    AsyncFunction("ecdh") { (alias: String, peerPublicKey: String, reason: String, mode: String, promise: Promise) in
      guard let peer = Data(base64Encoded: peerPublicKey) else {
        promise.reject("ERR_BAD_INPUT", "Peer key is not valid base64")
        return
      }
      guard let authMode = AuthMode(rawValue: mode) else {
        promise.reject("ERR_BAD_INPUT", "Unknown auth mode \(mode)")
        return
      }
      self.authorize(alias: alias, purpose: .agree, reason: reason, mode: authMode, promise: promise) { ctx in
        try self.store.ecdh(alias: alias, peerX963: peer, context: ctx).base64EncodedString()
      }
    }

    AsyncFunction("sign") { (alias: String, message: String, reason: String, mode: String, promise: Promise) in
      guard let data = Data(base64Encoded: message) else {
        promise.reject("ERR_BAD_INPUT", "Message is not valid base64")
        return
      }
      guard let authMode = AuthMode(rawValue: mode) else {
        promise.reject("ERR_BAD_INPUT", "Unknown auth mode \(mode)")
        return
      }
      self.authorize(alias: alias, purpose: .sign, reason: reason, mode: authMode, promise: promise) { ctx in
        try self.store.sign(alias: alias, message: data, context: ctx).base64EncodedString()
      }
    }

    Function("lock") { (alias: String) -> Bool in
      self.endSessions(alias)
      return true
    }

    // Android Key Attestation has no iOS equivalent for Secure Enclave keys; App Attest covers the app instead.
    AsyncFunction("getKeyAttestation") { (_: String) -> [String: [String]]? in
      return nil
    }

    AsyncFunction("getAppAttestation") { (challenge: String, promise: Promise) in
      self.appAttest(challenge: challenge, promise: promise)
    }
  }

  // MARK: - Sessions

  private func sessionKey(_ alias: String, _ purpose: Purpose) -> String { "\(alias).\(purpose.rawValue)" }

  private func openSession(_ alias: String, _ purpose: Purpose) -> LAContext? {
    sessionLock.lock()
    defer { sessionLock.unlock() }
    let key = sessionKey(alias, purpose)
    guard let s = sessions[key] else { return nil }
    if s.expires > Date() { return s.context }
    s.context.invalidate()
    sessions.removeValue(forKey: key)
    return nil
  }

  private func storeSession(_ alias: String, _ purpose: Purpose, _ context: LAContext, seconds: Int) {
    sessionLock.lock()
    defer { sessionLock.unlock() }
    let key = sessionKey(alias, purpose)
    sessions[key]?.context.invalidate()
    sessions[key] = (context, Date().addingTimeInterval(TimeInterval(seconds)))
  }

  private func endSessions(_ alias: String) {
    sessionLock.lock()
    defer { sessionLock.unlock() }
    for purpose in [Purpose.sign, Purpose.agree] {
      let key = sessionKey(alias, purpose)
      sessions[key]?.context.invalidate()
      sessions.removeValue(forKey: key)
    }
  }

  private func saveWindows(_ alias: String, _ config: WindowConfig) {
    if let data = try? JSONEncoder().encode(config) {
      UserDefaults.standard.set(data, forKey: Self.windowsKeyPrefix + alias)
    }
  }

  private func windows(_ alias: String) -> WindowConfig {
    if let data = UserDefaults.standard.data(forKey: Self.windowsKeyPrefix + alias),
       let config = try? JSONDecoder().decode(WindowConfig.self, from: data) {
      return config
    }
    return WindowConfig(signingWindow: 300, agreementWindow: 15, domainState: nil)
  }

  private static func currentDomainState() -> String? {
    let ctx = LAContext()
    guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return nil }
    return ctx.evaluatedPolicyDomainState?.base64EncodedString()
  }

  // MARK: - Authorization

  /// Resolves `promise` with `operation(context)` after satisfying `mode`. Software keys (simulator) need no
  /// authentication and run with a plain context.
  private func authorize(alias: String, purpose: Purpose, reason: String, mode: AuthMode, promise: Promise, operation: @escaping (LAContext) throws -> Any?) {
    queue.async {
      let record: DeviceKeyRecord
      let policy: KeyPolicy
      do {
        guard let r = try self.store.record(alias: alias) else { throw KeystoreError.notFound(alias) }
        record = r
        policy = try self.store.policy(alias: alias)
      } catch {
        self.reject(promise, error)
        return
      }
      if record.protection == .software {
        do {
          promise.resolve(try operation(LAContext()))
        } catch {
          self.reject(promise, error)
        }
        return
      }
      if mode != .fresh, let ctx = self.openSession(alias, purpose) {
        do {
          promise.resolve(try operation(ctx))
          return
        } catch {
          // The session was invalidated by the system (for example the device locked); fall through.
          self.endSessions(alias)
          if mode == .silent {
            promise.reject("ERR_AUTH_REQUIRED", "This operation needs the device owner to unlock the key")
            return
          }
        }
      } else if mode == .silent {
        promise.reject("ERR_AUTH_REQUIRED", "This operation needs the device owner to unlock the key")
        return
      }
      let ctx = LAContext()
      ctx.localizedCancelTitle = "Cancel"
      if policy == .biometryCurrentSet { ctx.localizedFallbackTitle = "" }
      ctx.evaluatePolicy(policy.laPolicy, localizedReason: reason) { ok, error in
        self.queue.async {
          if !ok {
            self.reject(promise, Self.mapLAError(error))
            return
          }
          if policy == .biometryCurrentSet,
             let saved = self.windows(alias).domainState,
             let now = ctx.evaluatedPolicyDomainState?.base64EncodedString(),
             saved != now {
            ctx.invalidate()
            promise.reject("ERR_KEY_INVALIDATED", "Face ID or Touch ID enrollment changed, so this device's keys can no longer be used. Re-add this device to your identity.")
            return
          }
          let w = self.windows(alias)
          self.storeSession(alias, purpose, ctx, seconds: purpose == .sign ? w.signingWindow : w.agreementWindow)
          do {
            promise.resolve(try operation(ctx))
          } catch {
            self.reject(promise, error)
          }
        }
      }
    }
  }

  private static func mapLAError(_ error: Error?) -> KeystoreError {
    guard let la = error as? LAError else {
      return KeystoreError(code: "ERR_AUTH_FAILED", message: error?.localizedDescription ?? "Authentication failed")
    }
    switch la.code {
    case .userCancel, .appCancel, .systemCancel, .userFallback:
      return KeystoreError(code: "ERR_AUTH_CANCELLED", message: "Authentication was cancelled")
    case .biometryLockout:
      return KeystoreError(code: "ERR_AUTH_FAILED", message: "Biometrics are locked after too many attempts. Unlock the device with its passcode and try again.")
    case .biometryNotEnrolled:
      return KeystoreError(code: "ERR_AUTH_FAILED", message: "No Face ID or Touch ID is enrolled on this device.")
    case .passcodeNotSet:
      return KeystoreError(code: "ERR_AUTH_FAILED", message: "This device has no passcode. Sealed keys require one.")
    default:
      return KeystoreError(code: "ERR_AUTH_FAILED", message: la.localizedDescription)
    }
  }

  private func reject(_ promise: Promise, _ error: Error) {
    if let k = error as? KeystoreError {
      promise.reject(k.code, k.message)
    } else {
      promise.reject("ERR_KEYSTORE", error.localizedDescription)
    }
  }

  // MARK: - App Attest

  /// App Attest attestation of this app instance over SHA-256(challenge). Resolves null when unsupported
  /// (simulator, older devices). The App Attest key id is created once and reused.
  private func appAttest(challenge: String, promise: Promise) {
    let service = DCAppAttestService.shared
    guard service.isSupported else {
      promise.resolve(nil)
      return
    }
    guard let challengeData = Data(base64Encoded: challenge), !challengeData.isEmpty else {
      promise.reject("ERR_BAD_INPUT", "Challenge is not valid base64")
      return
    }
    let clientDataHash = Data(SHA256.hash(data: challengeData))
    let attest: (String) -> Void = { keyId in
      service.attestKey(keyId, clientDataHash: clientDataHash) { attestation, error in
        if let attestation {
          promise.resolve(["keyId": keyId, "attestation": attestation.base64EncodedString()])
        } else {
          // A stale key id (for example after a restore) cannot attest again; forget it so the next call regenerates.
          UserDefaults.standard.removeObject(forKey: Self.appAttestKeyId)
          promise.reject("ERR_ATTESTATION", error?.localizedDescription ?? "App Attest failed")
        }
      }
    }
    if let keyId = UserDefaults.standard.string(forKey: Self.appAttestKeyId) {
      attest(keyId)
      return
    }
    service.generateKey { keyId, error in
      guard let keyId else {
        promise.reject("ERR_ATTESTATION", error?.localizedDescription ?? "App Attest key generation failed")
        return
      }
      UserDefaults.standard.set(keyId, forKey: Self.appAttestKeyId)
      attest(keyId)
    }
  }
}
