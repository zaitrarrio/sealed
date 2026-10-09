package to.sealed.keystore

import android.content.Context
import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import expo.modules.kotlin.exception.CodedException
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.KeyAgreement

/**
 * Who may unlock the keys. Fixed when the keys are generated (the Keystore cannot change it afterwards).
 *  - BIOMETRY_CURRENT_SET: strong biometrics only; enrolling a new fingerprint or face invalidates the keys.
 *  - USER_PRESENCE: strong biometrics or the device PIN/pattern/password (the user-relaxed setting, ADR-0005).
 */
enum class KeyPolicy(val wire: String) {
  BIOMETRY_CURRENT_SET("biometry-current-set"),
  USER_PRESENCE("user-presence");

  val authenticators: Int
    get() = when (this) {
      BIOMETRY_CURRENT_SET -> KeyProperties.AUTH_BIOMETRIC_STRONG
      USER_PRESENCE -> KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
    }

  companion object {
    fun fromWire(s: String): KeyPolicy =
      entries.firstOrNull { it.wire == s } ?: throw CodedException("ERR_BAD_INPUT", "Unknown key policy: $s", null)

    fun fromAuthenticators(types: Int): KeyPolicy =
      if (types and KeyProperties.AUTH_DEVICE_CREDENTIAL != 0) USER_PRESENCE else BIOMETRY_CURRENT_SET
  }
}

/** Wire values of core's KeyProtection for keys in the Android Keystore. */
enum class Protection(val wire: String, val rank: Int) {
  STRONGBOX("strongbox", 3),
  TEE("tee", 2),

  /** Keystore keys without secure hardware (emulators): still non-exportable to the app, but not hardware-bound. */
  SOFTWARE("software", 1),
}

data class PublicKeys(
  val agreementPublicKey: ByteArray,
  val signingPublicKey: ByteArray,
  val agreementProtection: Protection,
  val signingProtection: Protection,
  val policy: KeyPolicy,
) {
  /** The weaker of the two keys' protections; this is what peers are told. */
  val protection: Protection
    get() = if (agreementProtection.rank <= signingProtection.rank) agreementProtection else signingProtection

  fun toMap(): Map<String, Any> = mapOf(
    "agreementPublicKey" to Bytes.toBase64(agreementPublicKey),
    "signingPublicKey" to Bytes.toBase64(signingPublicKey),
    "protection" to protection.wire,
    "agreementProtection" to agreementProtection.wire,
    "signingProtection" to signingProtection.wire,
    "policy" to policy.wire,
  )
}

/**
 * Two P-256 keys per alias in the AndroidKeyStore provider:
 *   `<alias>.agree` — PURPOSE_AGREE_KEY (ECDH, API 31+), the device agreement key (DAK);
 *   `<alias>.sign`  — PURPOSE_SIGN with SHA-256, the device signing key (DSK).
 *
 * Both require user authentication with a validity window rather than per-operation CryptoObject auth:
 *   - the DSK signs every relay request (spec §9.2), so per-operation auth would prompt for each API call;
 *     its window (default 300 s) is opened by one BiometricPrompt and approvals force a fresh prompt;
 *   - one HPKE unwrap performs up to two ECDH operations with the DAK, and BiometricPrompt only accepts a
 *     KeyAgreement CryptoObject from API 35, so the DAK uses a short window (default 15 s) opened by a prompt
 *     immediately before the unwrap.
 */
class DeviceKeyStore(private val context: Context) {
  private val keyStore: KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  fun hasHardwareKeystore(): Boolean =
    context.packageManager.hasSystemFeature(PackageManager.FEATURE_HARDWARE_KEYSTORE)

  fun hasStrongBox(): Boolean =
    context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

  @Synchronized
  fun generate(alias: String, policy: KeyPolicy, signingWindow: Int, agreementWindow: Int, challenge: ByteArray?): PublicKeys {
    validateAlias(alias)
    if (signingWindow < 1 || agreementWindow < 1) {
      throw CodedException("ERR_BAD_INPUT", "Authentication windows must be at least one second", null)
    }
    if (keyStore.containsAlias(agreeAlias(alias)) || keyStore.containsAlias(signAlias(alias))) {
      throw CodedException("ERR_KEY_EXISTS", "Device keys already exist for $alias", null)
    }
    val strongBox = hasStrongBox()
    try {
      generateOne(agreeAlias(alias), KeyProperties.PURPOSE_AGREE_KEY, policy, agreementWindow, challenge, strongBox)
      generateOne(signAlias(alias), KeyProperties.PURPOSE_SIGN, policy, signingWindow, challenge, strongBox)
      return publicKeys(alias) ?: throw CodedException("ERR_KEYSTORE", "Generated keys could not be read back", null)
    } catch (e: Throwable) {
      delete(alias)
      throw e
    }
  }

  private fun generateOne(name: String, purpose: Int, policy: KeyPolicy, window: Int, challenge: ByteArray?, strongBox: Boolean) {
    if (strongBox) {
      try {
        generateWith(name, purpose, policy, window, challenge, true)
        return
      } catch (e: StrongBoxUnavailableException) {
        if (keyStore.containsAlias(name)) keyStore.deleteEntry(name)
      } catch (e: ProviderException) {
        // Some StrongBox implementations lack ECDH or attestation for a purpose; fall back to the TEE.
        if (keyStore.containsAlias(name)) keyStore.deleteEntry(name)
      }
    }
    generateWith(name, purpose, policy, window, challenge, false)
  }

  private fun generateWith(name: String, purpose: Int, policy: KeyPolicy, window: Int, challenge: ByteArray?, strongBox: Boolean) {
    val builder = KeyGenParameterSpec.Builder(name, purpose)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setUserAuthenticationRequired(true)
      .setUserAuthenticationParameters(window, policy.authenticators)
      .setInvalidatedByBiometricEnrollment(policy == KeyPolicy.BIOMETRY_CURRENT_SET)
      .setIsStrongBoxBacked(strongBox)
    if (purpose == KeyProperties.PURPOSE_SIGN) builder.setDigests(KeyProperties.DIGEST_SHA256)
    if (challenge != null && challenge.isNotEmpty()) builder.setAttestationChallenge(challenge)
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
    generator.initialize(builder.build())
    generator.generateKeyPair()
  }

  @Synchronized
  fun publicKeys(alias: String): PublicKeys? {
    validateAlias(alias)
    val agree = keyStore.getCertificate(agreeAlias(alias))?.publicKey as? ECPublicKey ?: return null
    val sign = keyStore.getCertificate(signAlias(alias))?.publicKey as? ECPublicKey ?: return null
    val agreeInfo = keyInfo(agreeAlias(alias))
    val signInfo = keyInfo(signAlias(alias))
    return PublicKeys(
      agreementPublicKey = uncompressed(agree),
      signingPublicKey = uncompressed(sign),
      agreementProtection = protectionOf(agreeInfo),
      signingProtection = protectionOf(signInfo),
      policy = KeyPolicy.fromAuthenticators(agreeInfo.userAuthenticationType),
    )
  }

  fun policyOf(alias: String): KeyPolicy {
    validateAlias(alias)
    if (!keyStore.containsAlias(agreeAlias(alias))) throw notFound(alias)
    return KeyPolicy.fromAuthenticators(keyInfo(agreeAlias(alias)).userAuthenticationType)
  }

  /** ECDH with the agreement key; returns the 32-byte x-coordinate of the shared point. */
  fun ecdh(alias: String, peerUncompressed: ByteArray): ByteArray {
    validateAlias(alias)
    val own = keyStore.getCertificate(agreeAlias(alias))?.publicKey as? ECPublicKey ?: throw notFound(alias)
    val peer = decodePublicKey(peerUncompressed, own)
    val ka = KeyAgreement.getInstance("ECDH", PROVIDER)
    ka.init(privateKey(agreeAlias(alias)))
    ka.doPhase(peer, true)
    val secret = ka.generateSecret()
    if (secret.size != 32) throw CodedException("ERR_KEYSTORE", "Unexpected ECDH output length ${secret.size}", null)
    return secret
  }

  /** ECDSA-SHA256 over [message]; returns the ASN.1 DER signature the Keystore produces. */
  fun sign(alias: String, message: ByteArray): ByteArray {
    validateAlias(alias)
    val s = Signature.getInstance("SHA256withECDSA")
    s.initSign(privateKey(signAlias(alias)))
    s.update(message)
    return s.sign()
  }

  @Synchronized
  fun delete(alias: String) {
    validateAlias(alias)
    for (name in listOf(agreeAlias(alias), signAlias(alias))) {
      if (keyStore.containsAlias(name)) keyStore.deleteEntry(name)
    }
  }

  /** Android Key Attestation certificate chains (leaf first, DER, base64) for both keys. */
  fun attestation(alias: String): Map<String, List<String>>? {
    validateAlias(alias)
    val agree = keyStore.getCertificateChain(agreeAlias(alias)) ?: return null
    val sign = keyStore.getCertificateChain(signAlias(alias)) ?: return null
    return mapOf(
      "agreement" to agree.map { Bytes.toBase64(it.encoded) },
      "signing" to sign.map { Bytes.toBase64(it.encoded) },
    )
  }

  private fun privateKey(name: String): PrivateKey =
    keyStore.getKey(name, null) as? PrivateKey ?: throw CodedException("ERR_KEY_NOT_FOUND", "Key $name not found", null)

  private fun keyInfo(name: String): KeyInfo {
    val key = privateKey(name)
    return KeyFactory.getInstance(key.algorithm, PROVIDER).getKeySpec(key, KeyInfo::class.java)
  }

  private fun protectionOf(info: KeyInfo): Protection = when (info.securityLevel) {
    KeyProperties.SECURITY_LEVEL_STRONGBOX -> Protection.STRONGBOX
    KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> Protection.TEE
    // Secure hardware of an unreported kind is still secure hardware.
    KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> Protection.TEE
    else -> Protection.SOFTWARE
  }

  private fun notFound(alias: String) = CodedException("ERR_KEY_NOT_FOUND", "No device keys for $alias", null)

  companion object {
    private const val PROVIDER = "AndroidKeyStore"
    private val ALIAS = Regex("^[A-Za-z0-9._-]{1,64}$")

    fun agreeAlias(alias: String) = "$alias.agree"
    fun signAlias(alias: String) = "$alias.sign"

    fun validateAlias(alias: String) {
      if (!ALIAS.matches(alias)) throw CodedException("ERR_BAD_INPUT", "Invalid key alias", null)
    }

    /** SEC1 uncompressed point: 0x04 ∥ X(32) ∥ Y(32). */
    fun uncompressed(key: ECPublicKey): ByteArray {
      val out = ByteArray(65)
      out[0] = 0x04
      Bytes.unsignedFixed(key.w.affineX, 32).copyInto(out, 1)
      Bytes.unsignedFixed(key.w.affineY, 32).copyInto(out, 33)
      return out
    }

    /** Parses an uncompressed SEC1 P-256 point using the curve parameters of [reference]. */
    fun decodePublicKey(bytes: ByteArray, reference: ECPublicKey): ECPublicKey {
      if (bytes.size != 65 || bytes[0] != 0x04.toByte()) {
        throw CodedException("ERR_BAD_INPUT", "Peer key must be an uncompressed 65-byte P-256 point", null)
      }
      val x = BigInteger(1, bytes.copyOfRange(1, 33))
      val y = BigInteger(1, bytes.copyOfRange(33, 65))
      val spec = ECPublicKeySpec(ECPoint(x, y), reference.params)
      return try {
        KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_EC).generatePublic(spec) as ECPublicKey
      } catch (e: Exception) {
        throw CodedException("ERR_BAD_INPUT", "Peer key is not a valid P-256 point", e)
      }
    }
  }
}
