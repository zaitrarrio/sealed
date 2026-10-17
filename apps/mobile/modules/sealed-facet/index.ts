/**
 * JavaScript surface of the SealedFacet native module (ios/SealedFacetModule.swift, android/.../SealedFacetModule.kt):
 * the Rust grid decoder (ADR-0023) behind the same contract the web uses for its WebAssembly build
 * (`GridFrameDecoder` in @sealed/core). Frames cross the bridge as base64 strings (a few kilobytes each).
 *
 * The module is optional: without the cross-compiled library (`task build:facet-ios` / `build:facet-android`)
 * `nativeFacetAvailable()` is false and the apps keep the JavaScript decoder.
 */
import type { GridFrameDecoder, NativePixelFormat, RgbaImage } from "@sealed/core";
import { requireOptionalNativeModule } from "expo";

interface NativeModule {
  available(): boolean;
  create(tiersMask: number): number;
  destroy(handle: number): void;
  push(handle: number, pixels: Uint8Array, width: number, height: number, stride: number, format: number): string[];
  pixelsPerCell(handle: number): number;
}

const native = requireOptionalNativeModule<NativeModule>("SealedFacet");
const FORMAT_CODE: Record<NativePixelFormat, number> = { rgba: 0, bgra: 1, rgb: 2 };

export function nativeFacetAvailable(): boolean {
  try {
    return Boolean(native?.available());
  } catch {
    return false;
  }
}

function fromBase64(s: string): Uint8Array {
  const bin = globalThis.atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class NativeFacetDecoder implements GridFrameDecoder {
  private handle: number;

  constructor(tiers: readonly number[]) {
    if (!native) throw new Error("SealedFacet native module is not linked");
    let mask = 0;
    for (const t of tiers) if (t >= 1 && t <= 3) mask |= 1 << t;
    this.handle = native.create(mask);
    if (!this.handle) throw new Error("SealedFacet: could not create a decoder (library missing or no grid tier)");
  }

  push(image: RgbaImage): Uint8Array[] {
    const data = image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    return this.pushRaw(data, image.width, image.height, image.width * 4, "rgba");
  }

  pushRaw(data: Uint8Array, width: number, height: number, stride: number, format: NativePixelFormat): Uint8Array[] {
    if (!this.handle || !native) return [];
    return native.push(this.handle, data, width, height, stride, FORMAT_CODE[format]).map(fromBase64);
  }

  get pixelsPerCell(): number {
    return this.handle && native ? native.pixelsPerCell(this.handle) : 0;
  }

  dispose(): void {
    if (this.handle && native) native.destroy(this.handle);
    this.handle = 0;
  }
}

/** A decoder for `tiers`, or null when the native library is not available on this build. */
export function createNativeFacetDecoder(tiers: readonly number[]): NativeFacetDecoder | null {
  if (!nativeFacetAvailable()) return null;
  try {
    return new NativeFacetDecoder(tiers);
  } catch {
    return null;
  }
}
