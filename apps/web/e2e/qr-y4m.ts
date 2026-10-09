/** Writes a still Y4M showing one QR code, for testing the in-app camera scanner with Chromium's fake camera. */
import { create } from "qrcode";
import { writeFileSync } from "node:fs";

export function writeQrY4m(path: string, text: string, width = 640, height = 480, frames = 20): void {
  const qr = create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 4;
  const scale = Math.floor(Math.min(width, height) / (n + quiet * 2));
  const size = scale * (n + quiet * 2);
  const ox = Math.floor((width - size) / 2);
  const oy = Math.floor((height - size) / 2);
  const y = new Uint8Array(width * height).fill(30);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const mx = Math.floor(px / scale) - quiet;
      const my = Math.floor(py / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.data[my * n + mx] === 1;
      y[(oy + py) * width + ox + px] = dark ? 16 : 235;
    }
  }
  const chroma = new Uint8Array((width / 2) * (height / 2)).fill(128);
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), Buffer.from(y), Buffer.from(chroma), Buffer.from(chroma)]);
  writeFileSync(path, Buffer.concat([header, ...Array.from({ length: frames }, () => frame)]));
}
