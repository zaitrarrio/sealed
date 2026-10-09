package to.sealed.keystore

import android.app.KeyguardManager
import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.exception.CodedException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * BiometricPrompt as a suspending call. A successful authentication opens the validity window of every
 * time-bound Keystore key of this app (both device keys use `setUserAuthenticationParameters(window, …)`).
 */
object BiometricGate {
  fun biometricStatus(context: Context): String =
    when (BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG)) {
      BiometricManager.BIOMETRIC_SUCCESS -> "available"
      BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "not-enrolled"
      else -> "unavailable"
    }

  fun deviceCredentialSet(context: Context): Boolean =
    (context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isDeviceSecure == true

  suspend fun prompt(activity: FragmentActivity, reason: String, policy: KeyPolicy) {
    withContext(Dispatchers.Main) {
      suspendCancellableCoroutine { cont ->
        val callback = object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            if (cont.isActive) cont.resume(Unit)
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            if (!cont.isActive) return
            val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
              errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
              errorCode == BiometricPrompt.ERROR_CANCELED
            val code = if (cancelled) "ERR_AUTH_CANCELLED" else "ERR_AUTH_FAILED"
            cont.resumeWithException(CodedException(code, errString.toString(), null))
          }

          // onAuthenticationFailed() reports one rejected attempt; the prompt stays up for another try.
        }
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
        val builder = BiometricPrompt.PromptInfo.Builder()
          .setTitle("Sealed")
          .setSubtitle(reason)
          .setConfirmationRequired(false)
        when (policy) {
          KeyPolicy.BIOMETRY_CURRENT_SET -> builder.setAllowedAuthenticators(BIOMETRIC_STRONG).setNegativeButtonText("Cancel")
          KeyPolicy.USER_PRESENCE -> builder.setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        }
        prompt.authenticate(builder.build())
        cont.invokeOnCancellation { prompt.cancelAuthentication() }
      }
    }
  }
}
