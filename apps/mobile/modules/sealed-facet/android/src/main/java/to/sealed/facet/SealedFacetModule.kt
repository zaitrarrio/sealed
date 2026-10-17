package to.sealed.facet

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array

private const val ABI_VERSION = 2

/**
 * Sealed native grid decoder (ADR-0023): the Rust `sealed-facet` crate behind its C ABI, reached through the JNI
 * shim in src/main/cpp. Same contract as the iOS module: decoders by handle, frames returned as base64 strings.
 */
class SealedFacetModule : Module() {
  private val decoders = HashMap<Int, Long>()
  private var nextHandle = 1

  override fun definition() = ModuleDefinition {
    Name("SealedFacet")

    Function("available") { Native.loaded && Native.abiVersion() == ABI_VERSION }

    Function("create") { tiersMask: Int ->
      if (!Native.loaded) return@Function 0
      val dec = Native.create(tiersMask)
      if (dec == 0L) return@Function 0
      val handle = nextHandle++
      decoders[handle] = dec
      handle
    }

    Function("destroy") { handle: Int ->
      decoders.remove(handle)?.let { Native.destroy(it) }
    }

    Function("push") { handle: Int, pixels: Uint8Array, width: Int, height: Int, stride: Int, format: Int ->
      val dec = decoders[handle] ?: return@Function emptyList<String>()
      val buffer = pixels.toDirectBuffer()
      val count = Native.push(dec, buffer, width, height, stride, format)
      val out = ArrayList<String>(count)
      for (i in 0 until count) {
        val bytes = Native.frame(dec, i)
        if (bytes.isNotEmpty()) out.add(Base64.encodeToString(bytes, Base64.NO_WRAP))
      }
      out
    }

    Function("pixelsPerCell") { handle: Int ->
      val dec = decoders[handle] ?: return@Function 0.0
      Native.pixelsPerCell(dec).toDouble()
    }

    OnDestroy {
      for (dec in decoders.values) Native.destroy(dec)
      decoders.clear()
    }
  }
}
