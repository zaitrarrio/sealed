/**
 * A camera video of a torch blinking a Sealed back-channel schedule (ADR-0022): a dim room with a bright spot
 * that follows the on/off steps. The fake camera loops it, so a "done" schedule repeats like the real player.
 */
import { torchSchedule, type TorchMessage } from "@sealed/core";
import { closeSync, openSync, writeSync } from "node:fs";

export function writeTorchY4m(path: string, msg: TorchMessage, width = 320, height = 240, fps = 30): void {
  const fd = openSync(path, "w");
  writeSync(fd, `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const u = new Uint8Array((width / 2) * (height / 2)).fill(128);
  const steps = [{ on: false, ms: 1000 }, ...torchSchedule(msg)];
  for (const s of steps) {
    const frames = Math.round((s.ms / 1000) * fps);
    const y = new Uint8Array(width * height).fill(40);
    if (s.on) {
      // A 24-px spot near the top: about 0.7 % of the frame, saturated.
      for (let py = 20; py < 44; py++) for (let px = 150; px < 174; px++) y[py * width + px] = 255;
    }
    for (let n = 0; n < frames; n++) {
      writeSync(fd, "FRAME\n");
      writeSync(fd, y);
      writeSync(fd, u);
      writeSync(fd, u);
    }
  }
  closeSync(fd);
}
