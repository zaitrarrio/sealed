import { describe, expect, it } from "vitest";
import { encodePacket, decodePacket } from "../../src/acoustic/packet";
import { modulatePacket, demodulateAt, findPreamble } from "../../src/acoustic/modem";
import { applyAcousticChannel } from "../../src/acoustic/channel";
import { acousticProfile, rawByteRate, PROFILE_A0, PROFILE_A1 } from "../../src/acoustic/profiles";
import { randomBytes } from "../../src/crypto/primitives";

describe("acoustic packet framing", () => {
  it("round-trips header and payload with CRC", () => {
    const packet = {
      profile: 0 as const,
      type: "data" as const,
      flags: 0,
      streamId: randomBytes(4),
      sbn: 1,
      esi: 42,
      payload: randomBytes(32),
    };
    const enc = encodePacket(packet);
    const dec = decodePacket(enc);
    expect(dec).not.toBeNull();
    expect(dec!.packet.payload).toEqual(packet.payload);
    expect(dec!.packet.esi).toBe(42);
    enc[enc.length - 1]! ^= 0xff;
    expect(decodePacket(enc)).toBeNull();
  });
});

describe("acoustic modem", () => {
  for (const profile of [0, 1] as const) {
    it(`modulates and demodulates a clean ${acousticProfile(profile).name} packet`, () => {
      const packet = {
        profile,
        type: "data" as const,
        flags: 0,
        streamId: new Uint8Array([1, 2, 3, 4]),
        sbn: 0,
        esi: 7,
        payload: randomBytes(acousticProfile(profile).symbolSize),
      };
      const pcm = modulatePacket(packet, profile);
      const at = findPreamble(pcm, acousticProfile(profile), 0);
      expect(at).toBeGreaterThanOrEqual(0);
      const got = demodulateAt(pcm, at, profile);
      expect(got).not.toBeNull();
      expect(got!.payload).toEqual(packet.payload);
      expect(got!.esi).toBe(7);
    });

    it(`survives mild noise on ${acousticProfile(profile).name}`, () => {
      const p = acousticProfile(profile);
      const packet = {
        profile,
        type: "data" as const,
        flags: 0,
        streamId: new Uint8Array([9, 8, 7, 6]),
        sbn: 0,
        esi: 3,
        payload: randomBytes(p.symbolSize),
      };
      const clean = modulatePacket(packet, profile);
      const noisy = applyAcousticChannel(clean, p, { noiseStd: 0.01, seed: 42 });
      const at = findPreamble(noisy, p, 0);
      expect(at).toBeGreaterThanOrEqual(0);
      const got = demodulateAt(noisy, at, profile);
      expect(got).not.toBeNull();
      expect(got!.payload).toEqual(packet.payload);
    });
  }

  it("A0 raw rate meets the design floor before FEC", () => {
    expect(rawByteRate(PROFILE_A0)).toBeGreaterThanOrEqual(PROFILE_A0.targetGoodputBps);
  });

  it("A1 raw rate meets the design floor before FEC", () => {
    expect(rawByteRate(PROFILE_A1)).toBeGreaterThanOrEqual(PROFILE_A1.targetGoodputBps);
  });
});
