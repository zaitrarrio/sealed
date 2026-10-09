import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// Who may unlock the keys (ADR-0005). Fixed at generation time.
enum KeyPolicy: String {
  /// Face ID / Touch ID with the currently enrolled set; enrolling a new face or finger invalidates the keys.
  case biometryCurrentSet = "biometry-current-set"
  /// Biometrics or the device passcode (the user-relaxed setting).
  case userPresence = "user-presence"

  var accessControlFlags: SecAccessControlCreateFlags {
    switch self {
    case .biometryCurrentSet: return [.privateKeyUsage, .biometryCurrentSet]
    case .userPresence: return [.privateKeyUsage, .userPresence]
    }
  }

  var laPolicy: LAPolicy {
    switch self {
    case .biometryCurrentSet: return .deviceOwnerAuthenticationWithBiometrics
    case .userPresence: return .deviceOwnerAuthentication
    }
  }
}

/// Where the private keys live; wire values of core's `KeyProtection`.
enum Protection: String {
  case secureEnclave = "secure-enclave"
  /// Simulator, or a device without a Secure Enclave: software keys in the Keychain.
  case software = "software"
}

struct DeviceKeyRecord {
  let agreementPublicKey: Data  // 65-byte uncompressed SEC1 (x9.63)
  let signingPublicKey: Data
  let protection: Protection
  let policy: KeyPolicy

  func toDictionary() -> [String: Any] {
    return [
      "agreementPublicKey": agreementPublicKey.base64EncodedString(),
      "signingPublicKey": signingPublicKey.base64EncodedString(),
      "protection": protection.rawValue,
      "agreementProtection": protection.rawValue,
      "signingProtection": protection.rawValue,
      "policy": policy.rawValue,
    ]
  }
}

/// Errors surfaced to JS with stable codes (mirrors the Android module).
struct KeystoreError: Error {
  let code: String
  let message: String

  static func notFound(_ alias: String) -> KeystoreError { KeystoreError(code: "ERR_KEY_NOT_FOUND", message: "No device keys for \(alias)") }
  static func badInput(_ m: String) -> KeystoreError { KeystoreError(code: "ERR_BAD_INPUT", message: m) }
  static func keychain(_ status: OSStatus, _ what: String) -> KeystoreError {
    let text = (SecCopyErrorMessageString(status, nil) as String?) ?? "OSStatus \(status)"
    return KeystoreError(code: "ERR_KEYSTORE", message: "\(what): \(text)")
  }
}

/// Persisted metadata stored beside each key pair (policy and protection never change after generation).
private struct StoredMeta: Codable {
  let policy: String
  let protection: String
}

/// Secure Enclave P-256 keys (CryptoKit) whose opaque `dataRepresentation` blobs are kept in the Keychain as
/// generic passwords with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`. The blobs are only usable by this
/// device's Secure Enclave, and every private-key operation requires the SecAccessControl policy to be satisfied
/// through the `LAContext` passed in. On the simulator (no Secure Enclave) software keys are stored the same way
/// and reported as protection "software", so peers see them as unprotected.
final class DeviceKeyStore {
  private static let service = "to.sealed.keystore"
  private let lock = NSLock()

  // MARK: - Keychain items

  private func account(_ alias: String, _ part: String) -> String { "\(alias).\(part)" }

  private func validate(_ alias: String) throws {
    let ok = alias.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil
    if !ok { throw KeystoreError.badInput("Invalid key alias") }
  }

  private func baseQuery(_ account: String) -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: DeviceKeyStore.service,
      kSecAttrAccount as String: account,
    ]
  }

  private func write(_ account: String, _ data: Data) throws {
    SecItemDelete(baseQuery(account) as CFDictionary)
    var q = baseQuery(account)
    q[kSecValueData as String] = data
    q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
    let status = SecItemAdd(q as CFDictionary, nil)
    if status != errSecSuccess { throw KeystoreError.keychain(status, "Storing \(account)") }
  }

  private func read(_ account: String) throws -> Data? {
    var q = baseQuery(account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return nil }
    if status != errSecSuccess { throw KeystoreError.keychain(status, "Reading \(account)") }
    return out as? Data
  }

  private func remove(_ account: String) {
    SecItemDelete(baseQuery(account) as CFDictionary)
  }

  // MARK: - Generation

  var secureEnclaveAvailable: Bool { SecureEnclave.isAvailable }

  func generate(alias: String, policy: KeyPolicy) throws -> DeviceKeyRecord {
    try validate(alias)
    lock.lock()
    defer { lock.unlock() }
    if try read(account(alias, "meta")) != nil {
      throw KeystoreError(code: "ERR_KEY_EXISTS", message: "Device keys already exist for \(alias)")
    }
    do {
      let record: DeviceKeyRecord
      if SecureEnclave.isAvailable {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, policy.accessControlFlags, &error) else {
          let message = error?.takeRetainedValue().localizedDescription ?? "unknown error"
          throw KeystoreError(code: "ERR_KEYSTORE", message: "Creating the access control failed: \(message). A device passcode is required.")
        }
        let agreement = try SecureEnclave.P256.KeyAgreement.PrivateKey(compactRepresentable: false, accessControl: access)
        let signing = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: access)
        try write(account(alias, "agree"), agreement.dataRepresentation)
        try write(account(alias, "sign"), signing.dataRepresentation)
        record = DeviceKeyRecord(
          agreementPublicKey: agreement.publicKey.x963Representation,
          signingPublicKey: signing.publicKey.x963Representation,
          protection: .secureEnclave,
          policy: policy
        )
      } else {
        let agreement = P256.KeyAgreement.PrivateKey(compactRepresentable: false)
        let signing = P256.Signing.PrivateKey(compactRepresentable: false)
        try write(account(alias, "agree"), agreement.rawRepresentation)
        try write(account(alias, "sign"), signing.rawRepresentation)
        record = DeviceKeyRecord(
          agreementPublicKey: agreement.publicKey.x963Representation,
          signingPublicKey: signing.publicKey.x963Representation,
          protection: .software,
          policy: policy
        )
      }
      let meta = StoredMeta(policy: policy.rawValue, protection: record.protection.rawValue)
      try write(account(alias, "meta"), try JSONEncoder().encode(meta))
      return record
    } catch {
      removeAll(alias)
      throw error
    }
  }

  private func removeAll(_ alias: String) {
    for part in ["agree", "sign", "meta"] { remove(account(alias, part)) }
  }

  func delete(alias: String) throws {
    try validate(alias)
    lock.lock()
    defer { lock.unlock() }
    removeAll(alias)
  }

  // MARK: - Loading

  private func meta(_ alias: String) throws -> StoredMeta {
    guard let data = try read(account(alias, "meta")) else { throw KeystoreError.notFound(alias) }
    return try JSONDecoder().decode(StoredMeta.self, from: data)
  }

  func policy(alias: String) throws -> KeyPolicy {
    try validate(alias)
    guard let p = KeyPolicy(rawValue: try meta(alias).policy) else { throw KeystoreError.badInput("Unknown stored policy") }
    return p
  }

  /// Public keys and protection. Loading a Secure Enclave key from its blob does not require authentication;
  /// only private-key operations do.
  func record(alias: String) throws -> DeviceKeyRecord? {
    try validate(alias)
    guard let metaData = try read(account(alias, "meta")) else { return nil }
    let m = try JSONDecoder().decode(StoredMeta.self, from: metaData)
    guard let policy = KeyPolicy(rawValue: m.policy), let protection = Protection(rawValue: m.protection) else {
      throw KeystoreError.badInput("Unknown stored key metadata")
    }
    guard let agreeData = try read(account(alias, "agree")), let signData = try read(account(alias, "sign")) else {
      throw KeystoreError.notFound(alias)
    }
    switch protection {
    case .secureEnclave:
      let agreement = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: agreeData)
      let signing = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: signData)
      return DeviceKeyRecord(agreementPublicKey: agreement.publicKey.x963Representation, signingPublicKey: signing.publicKey.x963Representation, protection: protection, policy: policy)
    case .software:
      let agreement = try P256.KeyAgreement.PrivateKey(rawRepresentation: agreeData)
      let signing = try P256.Signing.PrivateKey(rawRepresentation: signData)
      return DeviceKeyRecord(agreementPublicKey: agreement.publicKey.x963Representation, signingPublicKey: signing.publicKey.x963Representation, protection: protection, policy: policy)
    }
  }

  // MARK: - Operations

  /// ECDH with the device agreement key. Returns the 32-byte shared secret (the x-coordinate), which is exactly
  /// what DHKEM(P-256) needs as `dh`. `context` must already be authenticated for Secure Enclave keys.
  func ecdh(alias: String, peerX963: Data, context: LAContext) throws -> Data {
    try validate(alias)
    let m = try meta(alias)
    guard let blob = try read(account(alias, "agree")) else { throw KeystoreError.notFound(alias) }
    let peer: P256.KeyAgreement.PublicKey
    do {
      peer = try P256.KeyAgreement.PublicKey(x963Representation: peerX963)
    } catch {
      throw KeystoreError.badInput("Peer key is not a valid uncompressed P-256 point")
    }
    let shared: SharedSecret
    if m.protection == Protection.secureEnclave.rawValue {
      let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: context)
      shared = try key.sharedSecretFromKeyAgreement(with: peer)
    } else {
      let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: blob)
      shared = try key.sharedSecretFromKeyAgreement(with: peer)
    }
    let out = shared.withUnsafeBytes { Data($0) }
    if out.count != 32 { throw KeystoreError(code: "ERR_KEYSTORE", message: "Unexpected ECDH output length \(out.count)") }
    return out
  }

  /// ECDSA-SHA256 over `message` with the device signing key. Returns the 64-byte r ∥ s `rawRepresentation`
  /// (core normalizes to low-S).
  func sign(alias: String, message: Data, context: LAContext) throws -> Data {
    try validate(alias)
    let m = try meta(alias)
    guard let blob = try read(account(alias, "sign")) else { throw KeystoreError.notFound(alias) }
    if m.protection == Protection.secureEnclave.rawValue {
      let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
      return try key.signature(for: message).rawRepresentation
    }
    let key = try P256.Signing.PrivateKey(rawRepresentation: blob)
    return try key.signature(for: message).rawRepresentation
  }
}
