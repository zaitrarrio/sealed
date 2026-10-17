package to.sealed.facet

import java.nio.ByteBuffer

/** JNI surface of src/main/cpp/jni.c, present only when the Rust library was cross-compiled in. */
internal object Native {
  val loaded: Boolean = try {
    System.loadLibrary("sealed_facet")
    System.loadLibrary("sealedfacetjni")
    true
  } catch (_: UnsatisfiedLinkError) {
    false
  }

  external fun abiVersion(): Int
  external fun create(tiersMask: Int): Long
  external fun destroy(dec: Long)
  external fun push(dec: Long, pixels: ByteBuffer, width: Int, height: Int, stride: Int, format: Int): Int
  external fun frame(dec: Long, i: Int): ByteArray
  external fun pixelsPerCell(dec: Long): Float
}
