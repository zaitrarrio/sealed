/**
 * URL of the native grid decoder module (ADR-0023), resolved by Vite from @sealed/core's package exports and
 * emitted as an asset. Built by `task build:facet-wasm`; when the file is absent the import still resolves to a
 * URL that 404s, and the workers fall back to the JavaScript decoder.
 */
// eslint-disable-next-line import/no-unresolved
import url from "@sealed/core/wasm/sealed_facet.wasm?url";

export const nativeWasmUrl: string = url;

let probe: Promise<boolean> | null = null;

/**
 * Whether the native grid decoder can run in this browser (module present and instantiable). Decides the tier a
 * receiver offers: with it, grid tier 1; without, QR only. Cached per page.
 */
export function nativeDecoderAvailable(): Promise<boolean> {
  probe ??= (async () => {
    try {
      if (typeof WebAssembly !== "object") return false;
      const res = await fetch(nativeWasmUrl);
      if (!res.ok) return false;
      const bytes = await res.arrayBuffer();
      const { loadNativeDecoder } = await import("@sealed/core");
      await loadNativeDecoder(bytes);
      return true;
    } catch {
      return false;
    }
  })();
  return probe;
}
