package to.sealed.keystore

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import expo.modules.kotlin.exception.CodedException

/**
 * Error mapping for Keystore operations. JS sees stable codes:
 *   ERR_AUTH_REQUIRED     the key needs a fresh user authentication (and prompting was not allowed)
 *   ERR_AUTH_CANCELLED    the user dismissed the prompt
 *   ERR_AUTH_FAILED       the prompt failed (lockout, hardware error)
 *   ERR_KEY_INVALIDATED   the key was permanently invalidated (biometric enrollment changed)
 *   ERR_KEY_NOT_FOUND     no keys for the alias
 *   ERR_KEYSTORE          any other Keystore failure
 */
object Errors {
  private fun causes(e: Throwable): Sequence<Throwable> = generateSequence(e) { it.cause.takeIf { c -> c !== it } }

  fun isAuthRequired(e: Throwable): Boolean = causes(e).any { it is UserNotAuthenticatedException }

  fun isInvalidated(e: Throwable): Boolean = causes(e).any { it is KeyPermanentlyInvalidatedException }

  fun throwIfInvalidated(e: Throwable) {
    if (isInvalidated(e)) {
      throw CodedException(
        "ERR_KEY_INVALIDATED",
        "This device's keys were invalidated because its biometric enrollment changed. Re-add this device to your identity.",
        e,
      )
    }
  }

  fun authRequired(e: Throwable?) = CodedException("ERR_AUTH_REQUIRED", "This operation needs the device owner to unlock the key", e)

  fun wrap(e: Throwable): CodedException = when {
    e is CodedException -> e
    isInvalidated(e) -> CodedException("ERR_KEY_INVALIDATED", "This device's keys were invalidated", e)
    isAuthRequired(e) -> authRequired(e)
    else -> CodedException("ERR_KEYSTORE", e.message ?: e.javaClass.simpleName, e)
  }
}
