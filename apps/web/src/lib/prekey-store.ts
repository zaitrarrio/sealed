/**
 * Prekey secrets at rest (spec §5.2, ADR-0007). One-time and medium-term prekey private keys are software keys;
 * each is wrapped with HPKE (context "local") to this device's non-extractable agreement key before it is
 * written to IndexedDB, so a copy of the database alone does not reveal them.
 */
import { SoftwareAgreementKey, fromB64url, toB64url, unwrapKey, wrapKey, type AgreementKey, type PrekeyStore } from "@sealed/core";
import { allRecords, deleteRecord, getRecord, putRecord } from "./idb";

export interface PrekeyRecord {
  id: string; // base64url prekey id (8 bytes)
  kind: "one-time" | "medium-term";
  wrapped: Uint8Array;
  createdAt: number;
  /** Medium-term prekeys: the expiry published in the chain. */
  expires?: number;
}

function ctx(id: Uint8Array) {
  return { kind: "local" as const, fileId: id };
}

export class IdbPrekeyStore implements PrekeyStore {
  constructor(private readonly deviceKey: AgreementKey) {}

  async put(id: Uint8Array, secretKey: Uint8Array): Promise<void> {
    await this.putKind(id, secretKey, "one-time");
  }

  async putKind(id: Uint8Array, secretKey: Uint8Array, kind: PrekeyRecord["kind"], expires?: number): Promise<void> {
    const wrapped = await wrapKey(secretKey, this.deviceKey.publicKey, ctx(id));
    const rec: PrekeyRecord = { id: toB64url(id), kind, wrapped, createdAt: Math.floor(Date.now() / 1000), ...(expires !== undefined ? { expires } : {}) };
    await putRecord("prekeys", rec);
  }

  async get(id: Uint8Array): Promise<Uint8Array | null> {
    const rec = await getRecord<PrekeyRecord>("prekeys", toB64url(id));
    if (!rec) return null;
    return unwrapKey(new Uint8Array(rec.wrapped), this.deviceKey, ctx(id));
  }

  async delete(id: Uint8Array): Promise<void> {
    await deleteRecord("prekeys", toB64url(id));
  }

  async list(kind?: PrekeyRecord["kind"]): Promise<PrekeyRecord[]> {
    const all = await allRecords<PrekeyRecord>("prekeys");
    return kind ? all.filter((r) => r.kind === kind) : all;
  }

  /** Medium-term prekeys that are still retained (current and previous), as agreement keys. */
  async mediumTermKeys(now = Math.floor(Date.now() / 1000), retainSeconds = 7 * 86400): Promise<{ id: Uint8Array; key: AgreementKey; expires: number }[]> {
    const out: { id: Uint8Array; key: AgreementKey; expires: number }[] = [];
    for (const r of await this.list("medium-term")) {
      const expires = r.expires ?? 0;
      const id = fromB64url(r.id);
      if (expires + retainSeconds < now) {
        await this.delete(id);
        continue;
      }
      const secret = await unwrapKey(new Uint8Array(r.wrapped), this.deviceKey, ctx(id));
      out.push({ id, key: new SoftwareAgreementKey(secret), expires });
    }
    return out.sort((a, b) => b.expires - a.expires);
  }
}

