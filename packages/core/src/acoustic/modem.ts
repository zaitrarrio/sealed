/**
 * Multi-carrier QPSK acoustic modem. Each OFDM-like symbol places one QPSK constellation point on every
 * profile carrier; a rising linear chirp marks the start of each packet for receiver synchronisation.
 */
import { acousticProfile, bitsPerSymbol, type AcousticProfile, type AcousticProfileId } from "./profiles";
import { encodePacket, decodePacket, type AcousticPacket } from "./packet";

const TWO_PI = Math.PI * 2;
const PREAMBLE_MS = 40;
const AMP = 0.22;

function qpskPhase(bits: number): number {
  // Gray: 00→π/4, 01→3π/4, 11→5π/4, 10→7π/4
  switch (bits & 3) {
    case 0:
      return Math.PI / 4;
    case 1:
      return (3 * Math.PI) / 4;
    case 3:
      return (5 * Math.PI) / 4;
    default:
      return (7 * Math.PI) / 4;
  }
}

function nearestQpsk(i: number, q: number): number {
  // Return Gray bits for the quadrant.
  if (i >= 0 && q >= 0) return 0;
  if (i < 0 && q >= 0) return 1;
  if (i < 0 && q < 0) return 3;
  return 2;
}

function preambleSamples(p: AcousticProfile): number {
  return Math.round((PREAMBLE_MS / 1000) * p.sampleRate);
}

/** Rising chirp from the first to last carrier, used for packet detection. */
function writePreamble(out: Float32Array, offset: number, p: AcousticProfile): void {
  const n = preambleSamples(p);
  const f0 = p.carriersHz[0]!;
  const f1 = p.carriersHz[p.carriersHz.length - 1]!;
  for (let i = 0; i < n; i++) {
    const t = i / p.sampleRate;
    const f = f0 + (f1 - f0) * (i / Math.max(1, n - 1));
    out[offset + i] = AMP * Math.sin(TWO_PI * f * t);
  }
}

/** Correlates a chirp template against PCM; returns peak index or -1. */
export function findPreamble(pcm: Float32Array, p: AcousticProfile, start = 0): number {
  const n = preambleSamples(p);
  if (pcm.length - start < n) return -1;
  const template = new Float32Array(n);
  writePreamble(template, 0, p);
  let best = -1;
  let bestScore = 0;
  const step = Math.max(1, Math.floor(p.sampleRate / 2000)); // ~0.5 ms search step
  const energyT = Math.sqrt(template.reduce((a, v) => a + v * v, 0)) || 1;
  for (let off = start; off + n <= pcm.length; off += step) {
    let dot = 0;
    let energyS = 0;
    for (let i = 0; i < n; i++) {
      const s = pcm[off + i]!;
      dot += s * template[i]!;
      energyS += s * s;
    }
    const score = dot / (energyT * (Math.sqrt(energyS) || 1));
    if (score > bestScore) {
      bestScore = score;
      best = off;
    }
  }
  return bestScore > 0.35 ? best : -1;
}

function modulateSymbol(out: Float32Array, offset: number, p: AcousticProfile, bits: number[]): void {
  const n = p.symbolSamples;
  const carriers = p.carriersHz;
  for (let i = 0; i < n; i++) {
    const t = i / p.sampleRate;
    let sample = 0;
    for (let c = 0; c < carriers.length; c++) {
      const phase = qpskPhase(bits[c] ?? 0);
      sample += Math.cos(TWO_PI * carriers[c]! * t + phase);
    }
    out[offset + i] = (AMP / Math.sqrt(carriers.length)) * sample;
  }
}

function demodulateSymbol(pcm: Float32Array, offset: number, p: AcousticProfile): number[] {
  const n = p.symbolSamples;
  const carriers = p.carriersHz;
  const bits: number[] = [];
  for (let c = 0; c < carriers.length; c++) {
    const f = carriers[c]!;
    let iAcc = 0;
    let qAcc = 0;
    for (let k = 0; k < n; k++) {
      const t = k / p.sampleRate;
      const s = pcm[offset + k] ?? 0;
      iAcc += s * Math.cos(TWO_PI * f * t);
      qAcc += s * Math.sin(TWO_PI * f * t); // sin for Q with cos reference → negative of imag; nearestQpsk still works by quadrant if we flip
    }
    // Using cos(ωt) and sin(ωt): I = Σ s cos, Q = Σ s sin. Constellation at π/4 etc. maps correctly with -Q.
    bits.push(nearestQpsk(iAcc, -qAcc));
  }
  return bits;
}

function bytesToCarrierBits(bytes: Uint8Array, carriers: number): number[] {
  const out: number[] = [];
  const totalBits = bytes.length * 8;
  let bitPos = 0;
  while (bitPos < totalBits || out.length % carriers !== 0) {
    let val = 0;
    for (let k = 0; k < 2; k++) {
      const idx = bitPos + k;
      if (idx < totalBits) {
        const byte = bytes[idx >> 3]!;
        val = (val << 1) | ((byte >> (7 - (idx & 7))) & 1);
      } else {
        val <<= 1;
      }
    }
    out.push(val);
    bitPos += 2;
    if (bitPos >= totalBits && out.length % carriers === 0) break;
  }
  return out;
}

function carrierBitsToBytes(bits: number[], byteLen: number): Uint8Array {
  const out = new Uint8Array(byteLen);
  let bitPos = 0;
  for (const q of bits) {
    for (let k = 1; k >= 0; k--) {
      if (bitPos >= byteLen * 8) return out;
      const bit = (q >> k) & 1;
      out[bitPos >> 3]! |= bit << (7 - (bitPos & 7));
      bitPos++;
    }
  }
  return out;
}

/** Encodes one acoustic packet to mono PCM (−1..1). */
export function modulatePacket(packet: AcousticPacket, profileId?: AcousticProfileId): Float32Array {
  const p = acousticProfile(profileId ?? packet.profile);
  const bytes = encodePacket(packet);
  const carriers = p.carriersHz.length;
  const bitPairs = bytesToCarrierBits(bytes, carriers);
  const symbols = bitPairs.length / carriers;
  const pre = preambleSamples(p);
  const out = new Float32Array(pre + symbols * p.symbolSamples + Math.floor(p.sampleRate * 0.02));
  writePreamble(out, 0, p);
  let off = pre;
  for (let s = 0; s < symbols; s++) {
    const slice = bitPairs.slice(s * carriers, (s + 1) * carriers);
    modulateSymbol(out, off, p, slice);
    off += p.symbolSamples;
  }
  return out;
}

/** Attempts to decode one packet starting at a preamble found at `preambleAt`. */
export function demodulateAt(pcm: Float32Array, preambleAt: number, profileId: AcousticProfileId): AcousticPacket | null {
  const p = acousticProfile(profileId);
  const pre = preambleSamples(p);
  const start = preambleAt + pre;
  // Peek header length by demodulating enough symbols for PACKET_HEADER_BYTES + CRC + a short payload guess.
  // We don't know payload length yet — decode progressively.
  const carriers = p.carriersHz.length;
  const bitsPerSym = bitsPerSymbol(p);
  const bytesPerSymbol = bitsPerSym / 8;

  // First decode enough for the 18-byte header.
  const headerSymbols = Math.ceil(18 / bytesPerSymbol);
  const headerBits: number[] = [];
  let off = start;
  for (let s = 0; s < headerSymbols; s++) {
    if (off + p.symbolSamples > pcm.length) return null;
    headerBits.push(...demodulateSymbol(pcm, off, p));
    off += p.symbolSamples;
  }
  const headerBytes = carrierBitsToBytes(headerBits, 18);
  // Read payload length from header bytes 16-17 (before CRC validation of full packet).
  if (headerBytes[0] !== 0x53 || headerBytes[1] !== 0x41 || headerBytes[2] !== 0x4c || headerBytes[3] !== 0x41) return null;
  const payloadLen = (headerBytes[16]! << 8) | headerBytes[17]!;
  const totalBytes = 18 + payloadLen + 4;
  const totalSymbols = Math.ceil(totalBytes / bytesPerSymbol);
  const allBits: number[] = [];
  off = start;
  for (let s = 0; s < totalSymbols; s++) {
    if (off + p.symbolSamples > pcm.length) return null;
    allBits.push(...demodulateSymbol(pcm, off, p));
    off += p.symbolSamples;
  }
  const raw = carrierBitsToBytes(allBits, totalBytes);
  const decoded = decodePacket(raw, 0);
  return decoded?.packet ?? null;
}

/**
 * Scans PCM for packets of the given profile. Returns decoded packets and the sample index after the last
 * successful decode (for streaming receivers).
 */
export function demodulateStream(
  pcm: Float32Array,
  profileId: AcousticProfileId,
  from = 0,
): { packets: AcousticPacket[]; nextFrom: number } {
  const p = acousticProfile(profileId);
  const packets: AcousticPacket[] = [];
  let cursor = from;
  const maxScan = pcm.length;
  while (cursor + preambleSamples(p) + p.symbolSamples < maxScan) {
    const at = findPreamble(pcm, p, cursor);
    if (at < 0) break;
    const pkt = demodulateAt(pcm, at, profileId);
    if (pkt) {
      packets.push(pkt);
      // Advance past this packet approximately.
      const bytes = encodePacket(pkt).length;
      const symbols = Math.ceil((bytes * 8) / bitsPerSymbol(p));
      cursor = at + preambleSamples(p) + symbols * p.symbolSamples;
    } else {
      cursor = at + Math.floor(p.sampleRate * 0.005);
    }
  }
  return { packets, nextFrom: cursor };
}

/** Concatenates PCM buffers (with a short gap of silence between packets). */
export function concatenatePcm(parts: readonly Float32Array[], gapSamples = 480): Float32Array {
  let len = 0;
  for (let i = 0; i < parts.length; i++) len += parts[i]!.length + (i + 1 < parts.length ? gapSamples : 0);
  const out = new Float32Array(len);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i]!, off);
    off += parts[i]!.length;
    if (i + 1 < parts.length) off += gapSamples;
  }
  return out;
}
