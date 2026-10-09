/**
 * Inbox state for this device: stored mailbox deliveries (spec §6.4.2) refreshed on presence "mailbox" frames,
 * and live transfers arriving over WebRTC (§6.4.3). Runs while the app is open and this browser is an active
 * device of an identity.
 */
import type { MailboxItem } from "@sealed/core";
import { useSyncExternalStore } from "react";
import { getContact, listContacts } from "./contacts-store";
import { startLiveReceiver, type IncomingLive } from "./live";
import { refreshContact } from "./paired";
import { ReceiveSink, type ReceivedFile } from "./received";
import { session } from "./session";

export interface InboxState {
  items: MailboxItem[];
  loading: boolean;
  error: string | null;
  live: IncomingLive[];
  /** Files of completed live transfers, by live transfer id. */
  liveFiles: Record<string, ReceivedFile[]>;
  updatedAt: number;
}

let state: InboxState = { items: [], loading: false, error: null, live: [], liveFiles: {}, updatedAt: 0 };
const listeners = new Set<() => void>();
const liveSinks = new Map<string, ReceiveSink>();
let stopLive: (() => void) | null = null;
let stopPresence: (() => void) | null = null;
let attachedTo: unknown = null;

function set(patch: Partial<InboxState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useInbox(): InboxState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export async function refreshInbox(): Promise<void> {
  const s = session.getSnapshot();
  if (!s.active) return;
  set({ loading: true });
  try {
    const { items } = await s.client.mailbox();
    set({ items, loading: false, error: null, updatedAt: Date.now() });
  } catch (e) {
    set({ loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export function removeInboxItem(transferId: string): void {
  set({ items: state.items.filter((i) => i.transfer_id !== transferId) });
}

export function dismissLive(id: string): void {
  const sink = liveSinks.get(id);
  liveSinks.delete(id);
  void sink?.discard();
  const liveFiles = { ...state.liveFiles };
  delete liveFiles[id];
  set({ live: state.live.filter((l) => l.id !== id), liveFiles });
}

/** Attaches to the session's presence socket (idempotent per socket). Call whenever the session changes. */
export function attachInbox(): void {
  const s = session.getSnapshot();
  if (!s.active || !s.presence || !s.keys) {
    detach();
    return;
  }
  if (attachedTo === s.presence) return;
  detach();
  attachedTo = s.presence;
  const presence = s.presence;
  stopPresence = presence.on((frame) => {
    if (frame.type === "mailbox") void refreshInbox();
  });
  if (typeof RTCPeerConnection === "function") {
    stopLive = startLiveReceiver({
      client: s.client,
      presence,
      keys: s.keys,
      resolveSender: async (fp) => {
        const rec = await getContact(fp);
        if (!rec || rec.blocked) return null;
        try {
          const { chain } = await refreshContact(rec);
          return { chain, displayName: rec.displayName };
        } catch {
          return null;
        }
      },
      makeSink: (id) => {
        const sink = new ReceiveSink();
        liveSinks.set(id, sink);
        return sink;
      },
      onUpdate: (t) => {
        const others = state.live.filter((l) => l.id !== t.id);
        const patch: Partial<InboxState> = { live: [t, ...others] };
        if (t.status === "done") {
          const sink = liveSinks.get(t.id);
          if (sink) patch.liveFiles = { ...state.liveFiles, [t.id]: [...sink.files] };
        }
        set(patch);
      },
    });
  }
  void refreshInbox();
  void watchContacts();
}

/** Subscribes the presence socket to every pinned contact (call after pairing or removing a contact). */
export async function watchContacts(): Promise<void> {
  const presence = session.getSnapshot().presence;
  if (!presence) return;
  const contacts = await listContacts();
  presence.watch(contacts.filter((c) => !c.blocked).map((c) => c.id));
}

function detach(): void {
  stopLive?.();
  stopPresence?.();
  stopLive = null;
  stopPresence = null;
  attachedTo = null;
}
