/**
 * Inbox state for this device: stored mailbox deliveries (spec §6.4.2) refreshed on presence "mailbox" frames,
 * and live transfers arriving over WebRTC (§6.4.3). Runs while the app is open and this device is an active
 * device of an identity.
 */
import type { MailboxItem } from "@sealed/core";
import { useSyncExternalStore } from "react";
import { getContact, listContacts } from "./contacts-store";
import { startLiveReceiver, type IncomingLive } from "./live";
import { refreshContact } from "./paired";
import { ReceiveSink, type ReceivedFile } from "./received";
import { session } from "./session";

/** A stored delivery that arrived after this device had already loaded its inbox. */
export interface InboxArrival {
  id: string;
  senderFp: string;
}

export interface InboxState {
  items: MailboxItem[];
  loading: boolean;
  error: string | null;
  live: IncomingLive[];
  /** Files of completed live transfers, by live transfer id. */
  liveFiles: Record<string, ReceivedFile[]>;
  /** New mailbox deliveries to surface. The first load is a baseline and does not count. */
  arrivals: InboxArrival[];
  updatedAt: number;
}

let state: InboxState = { items: [], loading: false, error: null, live: [], liveFiles: {}, arrivals: [], updatedAt: 0 };
/** Transfer ids already seen. Null until the first successful mailbox load. */
let knownStored: Set<string> | null = null;
let refreshChain: Promise<void> = Promise.resolve();
/** Arrivals already handed to an inbox screen, so a remount does not open them twice. */
const claimedArrivals = new Set<string>();
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

export function refreshInbox(): Promise<void> {
  const run = refreshChain.then(loadMailbox, loadMailbox);
  refreshChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadMailbox(): Promise<void> {
  const s = session.getSnapshot();
  if (!s.active) return;
  set({ loading: true });
  try {
    const { items } = await s.client.mailbox();
    const fresh: InboxArrival[] = [];
    if (knownStored === null) {
      knownStored = new Set(items.map((item) => item.transfer_id));
    } else {
      for (const item of items) {
        if (knownStored.has(item.transfer_id)) continue;
        knownStored.add(item.transfer_id);
        fresh.push({ id: item.transfer_id, senderFp: item.sender_fp });
      }
    }
    set({
      items,
      loading: false,
      error: null,
      updatedAt: Date.now(),
      ...(fresh.length > 0 ? { arrivals: [...fresh, ...state.arrivals.filter((a) => !fresh.some((f) => f.id === a.id))] } : {}),
    });
  } catch (e) {
    set({ loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Hands one arrival to the inbox screen. Returns false if another screen already took it. */
export function claimArrival(id: string): boolean {
  if (claimedArrivals.has(id) || !state.arrivals.some((a) => a.id === id)) return false;
  claimedArrivals.add(id);
  set({ arrivals: state.arrivals.filter((a) => a.id !== id) });
  return true;
}

export function dismissArrival(id: string): void {
  claimedArrivals.add(id);
  set({ arrivals: state.arrivals.filter((a) => a.id !== id) });
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
        const keys = session.getSnapshot().keys;
        if (!keys) throw new Error("device keys are not loaded");
        const sink = new ReceiveSink(keys.agreement);
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
