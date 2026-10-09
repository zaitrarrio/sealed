package to.sealed.keystore

import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import java.math.BigInteger

/** Byte helpers for the JS bridge (standard base64, no line wrapping) and fixed-width big-endian integers. */
object Bytes {
  fun toBase64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)

  fun fromBase64(s: String): ByteArray =
    try {
      Base64.decode(s, Base64.NO_WRAP)
    } catch (e: IllegalArgumentException) {
      throw CodedException("ERR_BAD_INPUT", "Invalid base64 input", e)
    }

  /** Big-endian unsigned encoding of [v] in exactly [len] bytes (left-padded with zeros). */
  fun unsignedFixed(v: BigInteger, len: Int): ByteArray {
    require(v.signum() >= 0) { "negative value" }
    val raw = v.toByteArray()
    // BigInteger.toByteArray() may carry one leading 0x00 sign byte.
    val start = if (raw.size > 1 && raw[0] == 0.toByte()) 1 else 0
    val n = raw.size - start
    require(n <= len) { "value does not fit in $len bytes" }
    val out = ByteArray(len)
    System.arraycopy(raw, start, out, len - n, n)
    return out
  }
}

/** ASN.1 DER ↔ raw conversion for ECDSA P-256 signatures. */
object Der {
  private const val COORD = 32

  /**
   * Converts `SEQUENCE { INTEGER r, INTEGER s }` (what `SHA256withECDSA` returns) to the 64-byte r ∥ s form
   * core expects. Strict: rejects trailing data, indefinite or long-form lengths larger than needed, and integers
   * wider than the curve order.
   */
  fun ecdsaToRaw(der: ByteArray): ByteArray {
    var i = 0
    fun byte(): Int {
      if (i >= der.size) throw malformed()
      return der[i++].toInt() and 0xff
    }
    fun length(): Int {
      val first = byte()
      if (first < 0x80) return first
      if (first != 0x81) throw malformed() // a P-256 signature never needs more than one length byte
      val len = byte()
      if (len < 0x80) throw malformed()
      return len
    }
    if (byte() != 0x30) throw malformed()
    val seqLen = length()
    if (i + seqLen != der.size) throw malformed()
    val out = ByteArray(COORD * 2)
    for (k in 0 until 2) {
      if (byte() != 0x02) throw malformed()
      val len = length()
      if (len < 1 || i + len > der.size) throw malformed()
      var start = i
      var n = len
      while (n > 1 && der[start] == 0.toByte()) {
        start++
        n--
      }
      if (n > COORD) throw malformed()
      System.arraycopy(der, start, out, k * COORD + (COORD - n), n)
      i += len
    }
    if (i != der.size) throw malformed()
    return out
  }

  private fun malformed() = CodedException("ERR_KEYSTORE", "Malformed ECDSA signature from the Keystore", null)
}
