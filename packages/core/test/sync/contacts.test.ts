import { describe, expect, it } from "vitest";
import { randomBytes } from "../../src/crypto/primitives";
import { deriveSyncKey, openSyncBlob, sealSyncBlob, type SyncBlob } from "../../src/sync/contacts";

describe("contacts sync blob", () => {
  it("round-trips encrypted contacts", async () => {
    const key = deriveSyncKey(randomBytes(32));
    const blob: SyncBlob = {
      version: 1,
      contacts: [{ fingerprint: randomBytes(32), displayName: "Ada", pairedAt: 1 }],
      updatedAt: 2,
    };
    const sealed = await sealSyncBlob(key, blob);
    const opened = await openSyncBlob(key, sealed);
    expect(opened.version).toBe(1);
    expect(opened.contacts[0]!.displayName).toBe("Ada");
    expect(opened.contacts[0]!.fingerprint).toEqual(blob.contacts[0]!.fingerprint);
  });
});
