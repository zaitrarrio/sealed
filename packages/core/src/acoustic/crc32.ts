/** IEEE CRC-32 (Ethernet / PNG polynomial). Used to authenticate acoustic packet headers before FEC. */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0xffffffff): number {
  let c = seed >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ (data[i] as number)) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
