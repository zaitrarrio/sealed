/**
 * Paired mode orchestration (spec §6.3–6.4): contact refresh with fork blocking, send (live when the contact has
 * a device online, else stored; live falls back to stored automatically), and the inbox.
 */
import {
  ChainError,
  activeDevices,
  extendChain,
  fromB64url,
  receivePaired,
  refreshContactChain,
  sendToContact,
  toB64url,
  type ChainState,
  type EnvelopeInput,
  type MailboxItem,
  type Manifest,
} from "@sealed/core";
import { cachedChain, getContact, saveContact, toContact, type ContactRecord } from "./contacts-store";
import { LiveStall, sendLive } from "./live";
import type { ReceiveSink } from "./received";
import { session } from "./session";

export class ContactBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactBlocked";
  }
}

/**
 * Refreshes a contact's chain from the relay and verifies it extends both the pin and every link this browser
 * verified before. A fork marks the contact blocked (persisted) and throws ContactBlocked.
 */
export async function refreshContact(record: ContactRecord): Promise<{ record: ContactRecord; chain: ChainState }> {
  if (record.blocked) throw new ContactBlocked(record.blocked.reason);
  const { client } = session.getSnapshot();
  const cached = cachedChain(record) ?? undefined;
  let chain: ChainState;
  try {
    ({ chain } = await refreshContactChain(client, toContact(record), cached));
  } catch (e) {
    if (e instanceof ChainError || (e instanceof Error && /fork|pinned/i.test(e.message))) {
      const reason = `${record.displayName}'s identity no longer matches what you verified in person. Sending is blocked until you pair again.`;
      const blocked: ContactRecord = { ...record, blocked: { reason, at: Date.now() } };
      await saveContact(blocked);
      throw new ContactBlocked(reason);
    }
    throw e;
  }
  const { links } = await client.getChain(chain.fingerprint);
  // Re-check the fetched links against the chain we verified (the relay could answer differently twice).
  if (cached) extendChain(cached, links);
  const before = cached ? activeDevices(cached).map((d) => d.label) : [];
  const after = activeDevices(chain).map((d) => d.label);
  const added = after.filter((l) => !before.includes(l));
  const next: ContactRecord = {
    ...record,
    chainLinks: links.map(toB64url),
    ...(cached && added.length > 0 ? { notice: `${record.displayName} added ${added.length === 1 ? "a new device" : "new devices"}: ${added.join(", ")}` } : {}),
  };
  await saveContact(next);
  return { record: next, chain };
}

export type SendRoute = "live" | "stored";

export interface SendProgress {
  route: SendRoute;
  phase: "connecting" | "sending" | "fallback" | "done";
  bytes: number;
  total: number;
  note?: string;
}

/** Sends files to a contact: live first when a device is online, stored delivery otherwise or on stall. */
export async function sendToPairedContact(fp: string, files: () => EnvelopeInput[], opts: { onProgress: (p: SendProgress) => void; signal?: AbortSignal; source?: string }): Promise<{ route: SendRoute; transferId: string; manifest: Manifest }> {
  const s = session.getSnapshot();
  if (!s.keys || !s.chain || !s.profile.fingerprint) throw new Error("This browser needs an identity to send to contacts.");
  const record = await getContact(fp);
  if (!record) throw new Error("Unknown contact.");
  const { chain: recipient } = await refreshContact(record);
  if (activeDevices(recipient).length === 0) throw new Error(`${record.displayName} has no active devices.`);
  const self = await session.refreshOwnChain();
  const fingerprint = fromB64url(s.profile.fingerprint);
  const total = files().reduce((a, f) => a + f.size, 0);

  const online = s.presence?.online.get(fp) ?? 0;
  if (online > 0 && s.presence && s.presence.status === "open" && typeof RTCPeerConnection === "function") {
    opts.onProgress({ route: "live", phase: "connecting", bytes: 0, total });
    try {
      const r = await sendLive({
        client: s.client,
        presence: s.presence,
        keys: s.keys,
        self: { fingerprint, label: s.profile.label },
        recipient,
        files: files(),
        ...(opts.source ? { source: opts.source } : {}),
        onProgress: (b, t) => opts.onProgress({ route: "live", phase: "sending", bytes: b, total: t }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      opts.onProgress({ route: "live", phase: "done", bytes: total, total });
      return { route: "live", transferId: r.transferId, manifest: r.manifest };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const why = e instanceof LiveStall ? e.message : "the live connection failed";
      opts.onProgress({ route: "stored", phase: "fallback", bytes: 0, total, note: `Switching to stored delivery (${why}).` });
    }
  }
  opts.onProgress({ route: "stored", phase: "sending", bytes: 0, total });
  const r = await sendToContact({
    client: s.client,
    recipient,
    self,
    files: files(),
    sender: { keys: s.keys, label: s.profile.label, fingerprint },
    ...(opts.source ? { source: opts.source } : {}),
    onProgress: (b, t) => opts.onProgress({ route: "stored", phase: "sending", bytes: b, total: t }),
  });
  opts.onProgress({ route: "stored", phase: "done", bytes: total, total });
  return { route: "stored", transferId: r.transferId, manifest: r.manifest };
}

/** The verified chain of a mailbox item's sender: a pinned contact, or this identity (self-copies). */
export async function senderChainFor(item: MailboxItem): Promise<{ chain: ChainState; name: string }> {
  const s = session.getSnapshot();
  if (s.profile.fingerprint && item.sender_fp === s.profile.fingerprint) {
    return { chain: await session.refreshOwnChain(), name: "You (another device)" };
  }
  const record = await getContact(item.sender_fp);
  if (!record) throw new ContactBlocked("This delivery is from someone you have not paired with.");
  const { chain } = await refreshContact(record);
  return { chain, name: record.displayName };
}

/** Downloads one inbox item into `sink`, then replenishes prekeys. */
export async function openInboxItem(item: MailboxItem, sink: ReceiveSink, onProgress: (done: number, total: number) => void, onManifest?: (m: Manifest) => void): Promise<Manifest> {
  const s = session.getSnapshot();
  if (!s.keys || !session.prekeys) throw new Error("device keys are not loaded");
  const { chain } = await senderChainFor(item);
  const mediumTermKeys = (await session.prekeys.mediumTermKeys()).map(({ id, key }) => ({ id, key }));
  const manifest = await receivePaired({
    client: s.client,
    item,
    device: s.keys,
    senderChain: chain,
    mediumTermKeys,
    prekeys: session.prekeys,
    sink,
    ...(onManifest ? { onManifest } : {}),
    onProgress,
  });
  void session.maintainPrekeys().catch(() => undefined);
  return manifest;
}
