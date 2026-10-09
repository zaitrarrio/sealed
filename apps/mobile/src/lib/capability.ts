/**
 * Quick capture capability check for the reverse key code (spec §7.7, ADR-0010 step 4). Before a stream exists
 * the receiver can only measure the camera's delivered frame rate and resolution; decode throughput and pixels
 * per cell are unknown, so the web receiver reports T1 when the camera delivers at least 24 fps at 720p and
 * T0 otherwise. Web receivers never claim T2/T3 (spec §10.1).
 */
import type { Tier } from "@sealed/core";

export interface CameraProbe {
  fps: number;
  width: number;
  height: number;
}

export function tierForProbe(p: CameraProbe): Tier {
  if (p.fps >= 24 && Math.min(p.width, p.height) >= 720) return 1;
  return 0;
}

/** Measures delivered fps over ~1 s with requestVideoFrameCallback (or the track settings when unavailable). */
export async function probeCamera(video: HTMLVideoElement, stream: MediaStream, ms = 1000): Promise<CameraProbe> {
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings() ?? {};
  const width = settings.width ?? video.videoWidth;
  const height = settings.height ?? video.videoHeight;
  if (typeof video.requestVideoFrameCallback !== "function") return { fps: settings.frameRate ?? 0, width, height };
  const times: number[] = [];
  await new Promise<void>((resolve) => {
    const end = performance.now() + ms;
    const cb = (now: number) => {
      times.push(now);
      if (now < end) video.requestVideoFrameCallback(cb);
      else resolve();
    };
    video.requestVideoFrameCallback(cb);
    setTimeout(resolve, ms + 500);
  });
  const fps = times.length >= 2 ? ((times.length - 1) * 1000) / ((times[times.length - 1] as number) - (times[0] as number)) : (settings.frameRate ?? 0);
  return { fps, width, height };
}
