/**
 * Native grid decoder (ADR-0023): the Rust `sealed-facet` crate compiled to WebAssembly, driven through a plain
 * C ABI over linear memory. The same symbols are exported by the native library the phones link, so this file is
 * the contract for both.
 *
 * ABI (all integers u32 unless noted; pointers are byte offsets into `memory`):
 *   facet_abi_version()                                  → ABI_VERSION
 *   facet_alloc(len) / facet_free(ptr, len)              buffers owned by the caller
 *   facet_decoder_new(tiers_mask)                        bit t set allows grid tier t (1..3); 0 → null
 *   facet_decoder_free(dec)
 *   facet_decoder_push(dec, ptr, width, height, stride)  RGBA frame → number of frames decoded from it
 *   facet_decoder_frame_len(dec, i)                      length of decoded frame i (header ∥ payload bytes)
 *   facet_decoder_frame_copy(dec, i, out, cap)           copies frame i into out (≤ cap); returns bytes copied
 *   facet_decoder_pixels_per_cell(dec)      (f32)        from the last decoded frame's homography, 0 if none
 *   facet_decoder_last_ms(dec)              (f32)        wall time of the last push, when the host provides a clock
 *
 * Frames decoded by one push stay readable until the next push on the same decoder.
 */
import type { RgbaImage } from "./types";

export const NATIVE_ABI_VERSION = 1;

export interface NativeExports {
  memory: WebAssembly.Memory;
  facet_abi_version(): number;
  facet_alloc(len: number): number;
  facet_free(ptr: number, len: number): void;
  facet_decoder_new(tiersMask: number): number;
  facet_decoder_free(dec: number): void;
  facet_decoder_push(dec: number, ptr: number, width: number, height: number, stride: number): number;
  facet_decoder_frame_len(dec: number, i: number): number;
  facet_decoder_frame_copy(dec: number, i: number, out: number, cap: number): number;
  facet_decoder_pixels_per_cell(dec: number): number;
}

export class NativeGridDecoder {
  private dec: number;
  private input = { ptr: 0, len: 0 };
  private disposed = false;

  constructor(
    private readonly x: NativeExports,
    tiers: readonly number[],
  ) {
    let mask = 0;
    for (const t of tiers) if (t >= 1 && t <= 3) mask |= 1 << t;
    this.dec = x.facet_decoder_new(mask);
    if (!this.dec) throw new Error("native decoder: no grid tier allowed");
  }

  /** Decodes every readable frame in a camera image; returns header ∥ payload bytes per frame. */
  push(image: RgbaImage): Uint8Array[] {
    if (this.disposed) throw new Error("native decoder disposed");
    const stride = image.width * 4;
    const len = stride * image.height;
    if (image.data.length < len) throw new RangeError("image buffer is shorter than width × height × 4");
    if (this.input.len < len) {
      if (this.input.ptr) this.x.facet_free(this.input.ptr, this.input.len);
      this.input = { ptr: this.x.facet_alloc(len), len };
      if (!this.input.ptr) throw new Error("native decoder: out of memory");
    }
    new Uint8Array(this.x.memory.buffer, this.input.ptr, len).set(image.data.subarray(0, len));
    const count = this.x.facet_decoder_push(this.dec, this.input.ptr, image.width, image.height, stride);
    const out: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const n = this.x.facet_decoder_frame_len(this.dec, i);
      if (!n) continue;
      const ptr = this.x.facet_alloc(n);
      try {
        const copied = this.x.facet_decoder_frame_copy(this.dec, i, ptr, n);
        out.push(new Uint8Array(this.x.memory.buffer, ptr, copied).slice());
      } finally {
        this.x.facet_free(ptr, n);
      }
    }
    return out;
  }

  get pixelsPerCell(): number {
    return this.x.facet_decoder_pixels_per_cell(this.dec);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.input.ptr) this.x.facet_free(this.input.ptr, this.input.len);
    this.x.facet_decoder_free(this.dec);
    this.dec = 0;
  }
}

export interface NativeDecoderFactory {
  create(tiers: readonly number[]): NativeGridDecoder;
}

/** Instantiates the WebAssembly module from bytes or a fetch Response (streaming when possible). */
export async function loadNativeDecoder(source: BufferSource | Response | Promise<Response>): Promise<NativeDecoderFactory> {
  const imports = {};
  let instance: WebAssembly.Instance;
  if (source instanceof Response || source instanceof Promise) {
    const r = await source;
    if (typeof WebAssembly.instantiateStreaming === "function" && r.headers.get("content-type")?.includes("application/wasm")) {
      instance = (await WebAssembly.instantiateStreaming(r, imports)).instance;
    } else {
      instance = (await WebAssembly.instantiate(await r.arrayBuffer(), imports)).instance;
    }
  } else {
    instance = (await WebAssembly.instantiate(source, imports)).instance;
  }
  const x = instance.exports as unknown as NativeExports;
  for (const k of ["memory", "facet_abi_version", "facet_alloc", "facet_free", "facet_decoder_new", "facet_decoder_free", "facet_decoder_push", "facet_decoder_frame_len", "facet_decoder_frame_copy", "facet_decoder_pixels_per_cell"] as const) {
    if (!(k in x)) throw new Error(`native decoder: module lacks ${k}`);
  }
  const v = x.facet_abi_version();
  if (v !== NATIVE_ABI_VERSION) throw new Error(`native decoder: ABI ${v}, expected ${NATIVE_ABI_VERSION}`);
  return { create: (tiers) => new NativeGridDecoder(x, tiers) };
}
