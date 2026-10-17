/**
 * The native grid decoder on this phone (ADR-0023), when the Rust library was built into the app
 * (modules/sealed-facet). Camera frames reach it raw (BGRA on iOS, RGBA/RGB on Android), so no JavaScript pixel
 * conversion happens on the native path.
 */
import type { GridFrameDecoder, NativePixelFormat } from "@sealed/core";
import { createNativeFacetDecoder, nativeFacetAvailable } from "../../modules/sealed-facet";
import type { RawPixelFormat } from "./frame-convert";

export { nativeFacetAvailable };

export function createGridDecoder(tiers: readonly number[]): GridFrameDecoder | null {
  return createNativeFacetDecoder(tiers);
}

/** VisionCamera's pixel format names → the decoder's layouts. */
export function nativeFormat(f: RawPixelFormat): NativePixelFormat {
  return f === "rgb-bgra-8-bit" ? "bgra" : f === "rgb-rgb-8-bit" ? "rgb" : "rgba";
}
