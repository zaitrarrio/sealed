/**
 * Pinned contacts (spec §6.3.3 step 4, ADR-0006). Records live only in this browser's IndexedDB and are never
 * sent to the relay. The verified chain links are cached beside the pin so a refresh can detect forks against
 * everything this browser has already verified, not only the pinned head.
 *
 * At-rest encryption: the web client stores contact records in plaintext IndexedDB. They hold public material
 * only (fingerprints, chain heads, public keys and a display name); confidentiality of that list relies on the
 * browser profile. Native clients keep the list in the encrypted sync blob.
 */
import { fromB64url, toB64url, verifyChain, type ChainState, type Contact } from "@sealed/core";
import { allRecords, deleteRecord, getRecord, putRecord } from "./idb";

export interface ContactRecord {
  id: string; // base64url fingerprint
  displayName: string;
  pinnedSeq: number;
  pinnedHead: Uint8Array;
  pairedAt: number;
  /** base64url links of the most recently verified chain (extends the pinned prefix). */
  chainLinks: string[];
  /** Set when a refresh found a fork or verification failure; sending is blocked until re-paired. */
  blocked?: { reason: string; at: number };
  /** Set when the chain changed devices since the user last looked; cleared on view. */
  notice?: string;
}

export function toContact(r: ContactRecord): Contact {
  return { fingerprint: fromB64url(r.id), displayName: r.displayName, pinnedSeq: r.pinnedSeq, pinnedHead: new Uint8Array(r.pinnedHead), pairedAt: r.pairedAt };
}

export function recordFromContact(c: Contact, links: readonly Uint8Array[]): ContactRecord {
  return { id: toB64url(c.fingerprint), displayName: c.displayName, pinnedSeq: c.pinnedSeq, pinnedHead: c.pinnedHead, pairedAt: c.pairedAt, chainLinks: links.map(toB64url) };
}

export function cachedChain(r: ContactRecord): ChainState | null {
  try {
    return verifyChain(r.chainLinks.map(fromB64url), fromB64url(r.id));
  } catch {
    return null;
  }
}

export async function listContacts(): Promise<ContactRecord[]> {
  const all = await allRecords<ContactRecord>("contacts");
  return all.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function getContact(fp: string): Promise<ContactRecord | undefined> {
  return getRecord<ContactRecord>("contacts", fp);
}

export async function saveContact(r: ContactRecord): Promise<void> {
  await putRecord("contacts", r);
}

export async function removeContact(fp: string): Promise<void> {
  await deleteRecord("contacts", fp);
}
