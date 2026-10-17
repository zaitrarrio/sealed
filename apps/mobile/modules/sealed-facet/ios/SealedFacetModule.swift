import ExpoModulesCore
#if SEALED_FACET_LIBRARY
import SealedFacet
#endif

/// Sealed native grid decoder (ADR-0023): the Rust `sealed-facet` crate behind its C ABI (sealed_facet.h).
///
/// The JavaScript side owns the camera (VisionCamera's frame processor copies each frame out) and the stream
/// state (RaptorQ, keys); this module turns one camera buffer into the Facet frames it contains. Decoders are
/// kept in a table by handle; a decoder is not thread-safe, and all calls come from the JavaScript thread.
public final class SealedFacetModule: Module {
  #if SEALED_FACET_LIBRARY
  private var decoders: [Int: OpaquePointer] = [:]
  private var nextHandle = 1
  #endif

  public func definition() -> ModuleDefinition {
    Name("SealedFacet")

    /// Whether the Rust library is linked and speaks the expected ABI.
    Function("available") { () -> Bool in
      #if SEALED_FACET_LIBRARY
      return facet_abi_version() == SEALED_FACET_ABI_VERSION
      #else
      return false
      #endif
    }

    /// Creates a decoder for the grid tiers in `tiersMask` (bit t for tier t, 1…3). Returns a handle, 0 on failure.
    Function("create") { (tiersMask: Int) -> Int in
      #if SEALED_FACET_LIBRARY
      guard let dec = facet_decoder_new(UInt32(tiersMask)) else { return 0 }
      let handle = self.nextHandle
      self.nextHandle += 1
      self.decoders[handle] = dec
      return handle
      #else
      return 0
      #endif
    }

    Function("destroy") { (handle: Int) in
      #if SEALED_FACET_LIBRARY
      if let dec = self.decoders.removeValue(forKey: handle) { facet_decoder_free(dec) }
      #endif
    }

    /// Decodes one camera buffer (`format`: 0 RGBA, 1 BGRA, 2 RGB). Returns the frames found, base64 each
    /// (header ∥ payload), so the few kilobytes cross the bridge as plain strings.
    Function("push") { (handle: Int, pixels: Uint8Array, width: Int, height: Int, stride: Int, format: Int) -> [String] in
      #if SEALED_FACET_LIBRARY
      guard let dec = self.decoders[handle], width > 0, height > 0, stride * height <= pixels.byteLength else { return [] }
      let count = facet_decoder_push_format(dec, pixels.rawPointer.assumingMemoryBound(to: UInt8.self), UInt32(width), UInt32(height), UInt32(stride), UInt32(format))
      var out: [String] = []
      out.reserveCapacity(Int(count))
      for i in 0..<count {
        let len = Int(facet_decoder_frame_len(dec, i))
        if len == 0 { continue }
        var bytes = [UInt8](repeating: 0, count: len)
        let copied = bytes.withUnsafeMutableBufferPointer { facet_decoder_frame_copy(dec, i, $0.baseAddress, UInt32(len)) }
        out.append(Data(bytes[0..<Int(copied)]).base64EncodedString())
      }
      return out
      #else
      return []
      #endif
    }

    Function("pixelsPerCell") { (handle: Int) -> Double in
      #if SEALED_FACET_LIBRARY
      guard let dec = self.decoders[handle] else { return 0 }
      return Double(facet_decoder_pixels_per_cell(dec))
      #else
      return 0
      #endif
    }

    OnDestroy {
      #if SEALED_FACET_LIBRARY
      for (_, dec) in self.decoders { facet_decoder_free(dec) }
      self.decoders.removeAll()
      #endif
    }
  }
}
