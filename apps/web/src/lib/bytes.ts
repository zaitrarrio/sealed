/**
 * Byte helpers for DOM APIs. TypeScript's DOM lib types `BufferSource` as views over a plain `ArrayBuffer`;
 * buffers produced by @sealed/core are typed over `ArrayBufferLike`, so they are copied into fresh buffers
 * before crossing into WebCrypto, Blob, WebRTC or fetch.
 */
export function buf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(u);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function percent(fraction: number): string {
  return `${Math.max(0, Math.min(100, Math.floor(fraction * 100)))}%`;
}
