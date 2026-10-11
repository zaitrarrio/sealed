import { describe, expect, it } from "vitest";
import { SoftwareSigningKey } from "../../src/crypto/keys";
import { randomBytes } from "../../src/crypto/primitives";
import { decodePaperKey, encodePaperKey, encodePaperKeyBase32 } from "../../src/protocol/pairing";
import { toB64url } from "../../src/bytes";

describe("BIP-39 paper keys", () => {
  it("encodes and decodes with fingerprint prefix", () => {
    const fp = randomBytes(32);
    const key = new SoftwareSigningKey();
    const text = encodePaperKey(fp, key);
    expect(text.startsWith(toB64url(fp))).toBe(true);
    const decoded = decodePaperKey(text);
    expect(decoded.fingerprint).toEqual(fp);
    expect(decoded.key.secretKey).toEqual(key.secretKey);
  });

  it("still accepts legacy base32 paper keys", () => {
    const fp = randomBytes(32);
    const key = new SoftwareSigningKey();
    const text = encodePaperKeyBase32(fp, key);
    const decoded = decodePaperKey(text);
    expect(decoded.fingerprint).toEqual(fp);
    expect(decoded.key.secretKey).toEqual(key.secretKey);
  });
});
