package to.sealed.keystore

import android.content.Context
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.SecureRandom

/** Options for key generation, mirrored by `GenerateOptions` in index.ts. */
class GenerateOptions : Record {
  /** "biometry-current-set" (strong biometrics only, invalidated on enrollment change) or "user-presence". */
  @Field var policy: String = KeyPolicy.BIOMETRY_CURRENT_SET.wire

  /** Seconds one authentication unlocks the signing key for (relay requests, links, manifests). */
  @Field var signingWindowSeconds: Int = 300

  /** Seconds one authentication unlocks the agreement key for (one unwrap is at most two ECDH operations). */
  @Field var agreementWindowSeconds: Int = 15
}

/**
 * How an operation may involve the user:
 *   "silent"  never prompt; fail with ERR_AUTH_REQUIRED if the key's window is closed (background work);
 *   "window"  prompt only if the key's window is closed;
 *   "fresh"   always prompt first (approvals and identity changes: the signature itself is the user-verification
 *             evidence the relay accepts as `{kind: "device"}`).
 */
enum class AuthMode {
  SILENT, WINDOW, FRESH;

  companion object {
    fun fromWire(s: String): AuthMode = when (s) {
      "silent" -> SILENT
      "window" -> WINDOW
      "fresh" -> FRESH
      else -> throw CodedException("ERR_BAD_INPUT", "Unknown auth mode: $s", null)
    }
  }
}

/**
 * Sealed device keys (spec §5.2, ADR-0005) in the Android Keystore: StrongBox when the device has it, otherwise
 * the TEE. Both keys require user authentication through BiometricPrompt.
 */
class SealedKeystoreModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "React context is not available", null)

  private val store by lazy { DeviceKeyStore(context) }

  override fun definition() = ModuleDefinition {
    Name("SealedKeystore")

    Function("getCapabilities") {
      mapOf(
        "platform" to "android",
        "secureHardware" to store.hasHardwareKeystore(),
        "strongBox" to store.hasStrongBox(),
        "biometrics" to BiometricGate.biometricStatus(context),
        "deviceCredential" to BiometricGate.deviceCredentialSet(context),
      )
    }

    AsyncFunction("generateDeviceKeys") Coroutine { alias: String, options: GenerateOptions ->
      val challenge = ByteArray(32).also { SecureRandom().nextBytes(it) }
      withContext(Dispatchers.IO) {
        store.generate(
          alias = alias,
          policy = KeyPolicy.fromWire(options.policy),
          signingWindow = options.signingWindowSeconds,
          agreementWindow = options.agreementWindowSeconds,
          challenge = challenge,
        ).toMap()
      }
    }

    AsyncFunction("getDeviceKeys") Coroutine { alias: String ->
      withContext(Dispatchers.IO) { store.publicKeys(alias)?.toMap() }
    }

    AsyncFunction("deleteDeviceKeys") Coroutine { alias: String ->
      withContext(Dispatchers.IO) { store.delete(alias) }
    }

    AsyncFunction("authenticate") Coroutine { alias: String, reason: String ->
      val policy = withContext(Dispatchers.IO) { store.policyOf(alias) }
      BiometricGate.prompt(requireActivity(), reason, policy)
    }

    AsyncFunction("ecdh") Coroutine { alias: String, peerPublicKey: String, reason: String, mode: String ->
      val peer = Bytes.fromBase64(peerPublicKey)
      val secret = withAuth(alias, reason, AuthMode.fromWire(mode)) { store.ecdh(alias, peer) }
      Bytes.toBase64(secret)
    }

    AsyncFunction("sign") Coroutine { alias: String, message: String, reason: String, mode: String ->
      val data = Bytes.fromBase64(message)
      val der = withAuth(alias, reason, AuthMode.fromWire(mode)) { store.sign(alias, data) }
      Bytes.toBase64(Der.ecdsaToRaw(der))
    }

    // Keystore validity windows cannot be closed early; the JS layer tracks its own lock state.
    Function("lock") { _: String -> false }

    AsyncFunction("getKeyAttestation") Coroutine { alias: String ->
      withContext(Dispatchers.IO) { store.attestation(alias) }
    }

    // App Attest is iOS-only; Android attestation comes from the key certificate chains above.
    AsyncFunction("getAppAttestation") { _: String -> null }
  }

  private fun requireActivity(): FragmentActivity =
    appContext.currentActivity as? FragmentActivity
      ?: throw CodedException("ERR_NO_ACTIVITY", "Biometric prompt needs a foreground activity", null)

  /**
   * Runs a key operation under [mode]. When the Keystore reports that the auth-bound key needs a fresh
   * authentication, shows BiometricPrompt once (which unlocks the key for its validity window) and retries.
   */
  private suspend fun <T> withAuth(alias: String, reason: String, mode: AuthMode, op: () -> T): T {
    if (mode == AuthMode.FRESH) {
      val policy = withContext(Dispatchers.IO) { store.policyOf(alias) }
      BiometricGate.prompt(requireActivity(), reason, policy)
      return runOp(op)
    }
    val first = withContext(Dispatchers.IO) { runCatching(op) }
    first.onSuccess { return it }
    val error = first.exceptionOrNull() ?: throw CodedException("ERR_KEYSTORE", "Key operation failed", null)
    Errors.throwIfInvalidated(error)
    if (!Errors.isAuthRequired(error)) throw Errors.wrap(error)
    if (mode == AuthMode.SILENT) throw Errors.authRequired(error)
    val policy = withContext(Dispatchers.IO) { store.policyOf(alias) }
    BiometricGate.prompt(requireActivity(), reason, policy)
    return runOp(op)
  }

  private suspend fun <T> runOp(op: () -> T): T =
    withContext(Dispatchers.IO) {
      try {
        op()
      } catch (e: Throwable) {
        Errors.throwIfInvalidated(e)
        throw Errors.wrap(e)
      }
    }
}
