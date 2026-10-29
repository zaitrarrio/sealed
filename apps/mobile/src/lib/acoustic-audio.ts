/**
 * Mobile acoustic I/O (ADR-0024) via expo-audio: play Float32 PCM as short WAV clips; record and feed the
 * AcousticReceiver. The mic is requested only while listening.
 */
import { acousticProfile, type AcousticProfileId, type AcousticReceiver, type AcousticSender } from "@sealed/core";
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  createAudioPlayer,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioRecorder,
  type AudioStatus,
  type RecordingOptions,
} from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

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

function playWav(uri: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  const player = createAudioPlayer({ uri }, { updateInterval: 50, keepAudioSessionActive: true });
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      subscription.remove();
      signal?.removeEventListener("abort", onAbort);
      try {
        player.remove();
      } catch {
        /* already released */
      }
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      try {
        player.pause();
      } catch {
        /* already released */
      }
      finish(new Error("aborted"));
    };
    const onStatus = (status: AudioStatus) => {
      if (!status.isLoaded) return;
      if (status.error) {
        finish(new Error(status.error));
        return;
      }
      if (status.didJustFinish) finish();
    };
    const subscription = player.addListener("playbackStatusUpdate", onStatus);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    player.play();
  });
}

/** Plays PCM packets from an AcousticSender until finished or aborted. */
export async function playAcousticSender(
  sender: AcousticSender,
  profile: AcousticProfileId,
  opts: { signal?: AbortSignal; onPacket?: (n: number) => void } = {},
): Promise<void> {
  const p = acousticProfile(profile);
  await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
  const dir = cacheDir();
  let n = 0;
  while (!sender.finished) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const pcm = sender.nextPcm();
    const wav = floatToWav(pcm, p.sampleRate);
    const file = new File(dir, `sealed-acoustic-${n}.wav`);
    file.create();
    file.write(wav);
    await playWav(file.uri, opts.signal);
    n++;
    opts.onPacket?.(n);
    try {
      file.delete();
    } catch {
      /* ignore */
    }
  }
}

function recordOptions(sampleRate: number): RecordingOptions {
  return {
    extension: ".wav",
    sampleRate,
    numberOfChannels: 1,
    bitRate: sampleRate * 16,
    android: {
      extension: ".wav",
      outputFormat: "default",
      audioEncoder: "default",
      sampleRate,
    },
    ios: {
      extension: ".wav",
      outputFormat: IOSOutputFormat.LINEARPCM,
      audioQuality: AudioQuality.MAX,
      sampleRate,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
    web: {
      mimeType: "audio/wav",
      bitsPerSecond: sampleRate * 16,
    },
  };
}

/** `AudioRecorder` is constructed with platform fields flattened, the same shape expo-audio passes natively. */
function nativeRecordingOptions(sampleRate: number): RecordingOptions {
  const options = recordOptions(sampleRate);
  const common = {
    extension: options.extension,
    sampleRate: options.sampleRate,
    numberOfChannels: options.numberOfChannels,
    bitRate: options.bitRate,
    isMeteringEnabled: false,
  };
  if (Platform.OS === "android") return { ...common, ...options.android } as unknown as RecordingOptions;
  if (Platform.OS === "web") return { ...common, ...options.web } as unknown as RecordingOptions;
  return { ...common, ...options.ios } as unknown as RecordingOptions;
}

function releaseRecorder(recorder: AudioRecorder) {
  try {
    recorder.release();
  } catch {
    /* already released */
  }
}

/** Records from the mic in short clips and feeds PCM into the receiver. */
export async function captureAcousticReceiver(
  receiver: AcousticReceiver,
  profile: AcousticProfileId,
  opts: { signal?: AbortSignal; onProgress?: () => void } = {},
): Promise<void> {
  const p = acousticProfile(profile);
  const permission = await requestRecordingPermissionsAsync();
  if (!permission.granted) throw new Error("microphone permission denied");
  await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

  const options = recordOptions(p.sampleRate);
  const recording = new AudioModule.AudioRecorder(nativeRecordingOptions(p.sampleRate));
  await recording.prepareToRecordAsync(options);
  recording.record();

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
          await recording.stop();
          const uri = recording.uri;
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
            await recording.prepareToRecordAsync(options);
            recording.record();
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
      if (recording.isRecording) await recording.stop();
    } catch {
      /* already stopped */
    }
    releaseRecorder(recording);
  }
}
