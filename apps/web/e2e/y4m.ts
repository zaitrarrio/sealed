/**
 * Writes Facet frames as a raw Y4M (YUV 4:2:0) file for Chromium's fake camera
 * (--use-file-for-fake-video-capture). Raw frames, no video encoder, as ADR-0010 requires of real capture.
 */
import type { FacetSender } from "@sealed/core";
import { closeSync, openSync, writeSync } from "node:fs";

export function writeFacetY4m(path: string, sender: FacetSender, o: { width: number; height: number; codePx: number; frames: number; fps: number }): number {
  const { width: W, height: H } = o;
  const fd = openSync(path, "w");
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F${o.fps}:1 Ip A1:1 C420jpeg\n`);
  const y = new Uint8Array(W * H);
  const u = new Uint8Array((W / 2) * (H / 2));
  const v = new Uint8Array((W / 2) * (H / 2));
  const ox = Math.floor((W - o.codePx) / 2);
  const oy = Math.floor((H - o.codePx) / 2);
  let written = 0;
  for (let n = 0; n < o.frames && !sender.finished; n++) {
    const frame = sender.next();
    const img = sender.render(frame, o.codePx);
    // Background: Facet's warm near-black around the code.
    const rgbAt = (px: number, py: number): [number, number, number] => {
      const cx = px - ox;
      const cy = py - oy;
      if (cx < 0 || cy < 0 || cx >= img.width || cy >= img.height) return [11, 9, 8];
      const i = (cy * img.width + cx) * 4;
      return [img.data[i] as number, img.data[i + 1] as number, img.data[i + 2] as number];
    };
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const [r, g, b] = rgbAt(px, py);
        y[py * W + px] = clamp(0.299 * r + 0.587 * g + 0.114 * b);
      }
    }
    for (let py = 0; py < H / 2; py++) {
      for (let px = 0; px < W / 2; px++) {
        let rs = 0;
        let gs = 0;
        let bs = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const [r, g, b] = rgbAt(px * 2 + dx, py * 2 + dy);
          rs += r;
          gs += g;
          bs += b;
        }
        const r = rs / 4;
        const g = gs / 4;
        const b = bs / 4;
        u[py * (W / 2) + px] = clamp(128 - 0.168736 * r - 0.331264 * g + 0.5 * b);
        v[py * (W / 2) + px] = clamp(128 + 0.5 * r - 0.418688 * g - 0.081312 * b);
      }
    }
    writeSync(fd, "FRAME\n");
    writeSync(fd, y);
    writeSync(fd, u);
    writeSync(fd, v);
    written++;
  }
  closeSync(fd);
  return written;
}

function clamp(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : Math.round(x);
}
