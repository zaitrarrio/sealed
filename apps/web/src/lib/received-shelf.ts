/**
 * Received-file shelf: keeps completed ReceiveSinks alive across navigation so the user can return and
 * save files without losing OPFS contents. Entries expire after SHELF_TTL_MS or when explicitly cleared.
 */
import type { Manifest } from "@sealed/core";
import type { ReceiveSink, ReceivedFile } from "./received";

const SHELF_TTL_MS = 60 * 60_000;

export interface ShelfEntry {
  transferId: string;
  sink: ReceiveSink;
  files: ReceivedFile[];
  manifest: Manifest;
  claimId: string;
  claimToken: string;
  sas: string;
  at: number;
}

const shelf = new Map<string, ShelfEntry>();

function prune(now = Date.now()): void {
  for (const [id, e] of shelf) {
    if (now - e.at > SHELF_TTL_MS) {
      void e.sink.discard();
      shelf.delete(id);
    }
  }
}

export function putShelf(
  transferId: string,
  sink: ReceiveSink,
  files: ReceivedFile[],
  manifest: Manifest,
  claim: { claimId: string; claimToken: string; sas: string },
): void {
  prune();
  const prev = shelf.get(transferId);
  if (prev && prev.sink !== sink) void prev.sink.discard();
  shelf.set(transferId, {
    transferId,
    sink,
    files,
    manifest,
    claimId: claim.claimId,
    claimToken: claim.claimToken,
    sas: claim.sas,
    at: Date.now(),
  });
}

export function getShelf(transferId: string): ShelfEntry | null {
  prune();
  return shelf.get(transferId) ?? null;
}

export function takeShelf(transferId: string): ShelfEntry | null {
  prune();
  const e = shelf.get(transferId) ?? null;
  if (e) shelf.delete(transferId);
  return e;
}

/** Discards one shelf entry's OPFS directory. */
export async function discardShelf(transferId: string): Promise<void> {
  const e = shelf.get(transferId);
  if (!e) return;
  shelf.delete(transferId);
  await e.sink.discard();
}

export function listShelf(): ShelfEntry[] {
  prune();
  return [...shelf.values()].sort((a, b) => b.at - a.at);
}
