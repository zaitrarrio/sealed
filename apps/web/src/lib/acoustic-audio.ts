/**
 * Web Audio helpers for acoustic transfer (ADR-0024). Mic is opened only while receiving; playback uses
 * audible tones during an explicit send.
 */
import { acousticProfile, type AcousticProfileId, type AcousticSender, type AcousticReceiver } from "@sealed/core";

/** Plays PCM packets from an AcousticSender until finished or aborted. */
export async function playAcousticSender(
  sender: AcousticSender,
  profile: AcousticProfileId,
  opts: { signal?: AbortSignal; onPacket?: (n: number) => void } = {},
): Promise<void> {
  const p = acousticProfile(profile);
  const ctx = new AudioContext({ sampleRate: p.sampleRate });
  try {
    await ctx.resume();
    let n = 0;
    while (!sender.finished) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const pcm = sender.nextPcm();
      const buf = ctx.createBuffer(1, pcm.length, p.sampleRate);
      buf.copyToChannel(Float32Array.from(pcm), 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const done = new Promise<void>((resolve) => {
        src.onended = () => resolve();
      });
      src.start();
      n++;
      opts.onPacket?.(n);
      await done;
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/** Opens the mic and feeds mono PCM into an AcousticReceiver until complete or aborted. */
export async function captureAcousticReceiver(
  receiver: AcousticReceiver,
  profile: AcousticProfileId,
  opts: { signal?: AbortSignal; onProgress?: () => void } = {},
): Promise<void> {
  const p = acousticProfile(profile);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: p.sampleRate,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const ctx = new AudioContext({ sampleRate: p.sampleRate });
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but widely available; buffer size balances latency and decode cost.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (ev) => {
    if (opts.signal?.aborted || receiver.progress.complete) return;
    const input = ev.inputBuffer.getChannelData(0);
    receiver.pushPcm(input.slice());
    opts.onProgress?.();
  };
  source.connect(processor);
  processor.connect(ctx.destination); // required for some browsers to fire onaudioprocess; keep gain silent
  const mute = ctx.createGain();
  mute.gain.value = 0;
  processor.disconnect();
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  try {
    await ctx.resume();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("aborted", "AbortError"));
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const tick = () => {
        if (receiver.progress.complete) {
          opts.signal?.removeEventListener("abort", onAbort);
          resolve();
          return;
        }
        if (opts.signal?.aborted) {
          opts.signal.removeEventListener("abort", onAbort);
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  } finally {
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    mute.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => undefined);
  }
}
