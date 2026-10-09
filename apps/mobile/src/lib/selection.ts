/**
 * The current file selection, shared between Share, Share offline and Send-to-contact so the user can switch
 * transports without picking again (spec §3.2: "the client offers Share offline with the same selection").
 * Held in memory only.
 */
import { useSyncExternalStore } from "react";
import type { PickedFile } from "./files";

let current: PickedFile[] = [];
const listeners = new Set<() => void>();

export function setSelection(files: PickedFile[]): void {
  current = files;
  for (const l of listeners) l();
}

export function getSelection(): PickedFile[] {
  return current;
}

export function useSelection(): [PickedFile[], (f: PickedFile[]) => void] {
  const files = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return [files, setSelection];
}

/** The source recorded in the manifest (spec §8.2 key 12): "cloud" when any file came from a cloud provider. */
export function selectionSource(files: readonly PickedFile[]): string {
  return files.some((f) => f.source === "cloud") ? "cloud" : "local";
}
