/**
 * Mobile acoustic I/O (ADR-0024) via expo-av: play Float32 PCM as short WAV clips; record and feed the
 * AcousticReceiver. The mic is requested only while listening.
 */
import { Audio } from "expo-av";
import { Directory, File, Paths } from "expo-file-system";
import { acousticProfile, type AcousticProfileId, type AcousticReceiver, type AcousticSender } from "@sealed/core";

function floatToWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const dataLength = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataLength, true);
  let o = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    view.setInt16(o, (s * 0x7fff) | 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

function cacheDir(): Directory {
  const d = new Directory(Paths.cache, "acoustic");
  if (!d.exists) d.create();
  return d;
}

/** Plays PCM packets from an AcousticSender until finished or aborted. */
export async function playAcousticSender(
  sender: AcousticSender,
  profile: AcousticProfileId,
  opts: { signal?: AbortSignal; onPacket?: (n: number) => void } = {},
): Promise<void> {
  const p = acousticProfile(profile);
  await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, allowsRecordingIOS: false });
  const dir = cacheDir();
  let n = 0;
  while (!sender.finished) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const pcm = sender.nextPcm();
    const wav = floatToWav(pcm, p.sampleRate);
    const file = new File(dir, `sealed-acoustic-${n}.wav`);
    file.create();
    file.write(wav);
    const { sound } = await Audio.Sound.createAsync({ uri: file.uri }, { shouldPlay: true });
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        void sound.stopAsync().finally(() => {
          void sound.unloadAsync();
          reject(new Error("aborted"));
        });
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      sound.setOnPlaybackStatusUpdate((st) => {
        if (!st.isLoaded) return;
        if (st.didJustFinish) {
          opts.signal?.removeEventListener("abort", onAbort);
          void sound.unloadAsync().then(() => resolve());
        }
      });
    });
    n++;
    opts.onPacket?.(n);
    try {
      file.delete();
    } catch {
      /* ignore */
    }
  }
}

const recordOpts = (sampleRate: number) => ({
  android: {
    extension: ".wav",
    outputFormat: Audio.AndroidOutputFormat.DEFAULT,
    audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
    sampleRate,
    numberOfChannels: 1,
    bitRate: sampleRate * 16,
  },
  ios: {
    extension: ".wav",
    outputFormat: Audio.IOSOutputFormat.LINEARPCM,
    audioQuality: Audio.IOSAudioQuality.MAX,
    sampleRate,
    numberOfChannels: 1,
    bitRate: sampleRate * 16,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/wav",
    bitsPerSecond: sampleRate * 16,
  },
});

/** Records from the mic in short clips and feeds PCM into the receiver. */
export async function captureAcousticReceiver(
  receiver: AcousticReceiver,
  profile: AcousticProfileId,
  opts: { signal?: AbortSignal; onProgress?: () => void } = {},
): Promise<void> {
  const p = acousticProfile(profile);
  await Audio.requestPermissionsAsync();
  await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

  const recording = new Audio.Recording();
  await recording.prepareToRecordAsync(recordOpts(p.sampleRate));
  await recording.startAsync();

  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error("aborted"));
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const tick = async () => {
        if (receiver.progress.complete) {
          opts.signal?.removeEventListener("abort", onAbort);
          resolve();
          return;
        }
        if (opts.signal?.aborted) {
          opts.signal.removeEventListener("abort", onAbort);
          reject(new Error("aborted"));
          return;
        }
        opts.onProgress?.();
        try {
          await recording.stopAndUnloadAsync();
          const uri = recording.getURI();
          if (uri) {
            const file = new File(uri);
            if (file.exists) {
              const bytes = await file.bytes();
              if (bytes.length > 44) {
                const samples = Math.floor((bytes.length - 44) / 2);
                const pcm = new Float32Array(samples);
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                for (let i = 0; i < samples; i++) pcm[i] = view.getInt16(44 + i * 2, true) / 0x7fff;
                receiver.pushPcm(pcm);
              }
              try {
                file.delete();
              } catch {
                /* ignore */
              }
            }
          }
          if (!receiver.progress.complete && !opts.signal?.aborted) {
            await recording.prepareToRecordAsync(recordOpts(p.sampleRate));
            await recording.startAsync();
            setTimeout(() => void tick(), 400);
            return;
          }
        } catch {
          // keep polling until abort/complete
        }
        setTimeout(() => void tick(), 400);
      };
      setTimeout(() => void tick(), 400);
    });
  } finally {
    try {
      const st = await recording.getStatusAsync();
      if (st.isRecording) await recording.stopAndUnloadAsync();
    } catch {
      /* already stopped */
    }
  }
}
