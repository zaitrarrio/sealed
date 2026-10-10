/**
 * Who a received manifest says it is from, and whether that can be believed. A manifest signature is checked
 * against the signing key carried in the same manifest, so on its own it proves nothing about identity: the
 * name is only shown as verified when the manifest's identity fingerprint is a pinned contact (or this
 * identity) and the signing key is an active device on that pinned chain.
 */
import { compress, ctEqual, fromB64url, type ChainState } from "@sealed/core";
import { cachedChain, listContacts } from "./contacts-store";

export interface SenderClaim {
  label: string;
  signingPublicKey: Uint8Array;
  fingerprint?: Uint8Array;
}

export interface SenderView {
  verified: boolean;
  /** Text for "From …". */
  display: string;
}

function hasActiveSigner(chain: ChainState, key: Uint8Array): boolean {
  return [...chain.devices.values()].some((d) => d.revokedSeq === undefined && ctEqual(compress(d.signingPublicKey), compress(key)));
}

export async function describeSender(sender: SenderClaim | null | undefined, own: ChainState | null): Promise<SenderView | null> {
  if (!sender) return null;
  const fp = sender.fingerprint;
  if (fp) {
    if (own && ctEqual(fp, own.fingerprint) && hasActiveSigner(own, sender.signingPublicKey)) return { verified: true, display: "you, from another device" };
    for (const c of await listContacts()) {
      if (c.blocked || !ctEqual(fromB64url(c.id), fp)) continue;
      const chain = cachedChain(c);
      if (chain && hasActiveSigner(chain, sender.signingPublicKey)) return { verified: true, display: c.displayName };
    }
  }
  return { verified: false, display: `“${sender.label}” (unverified)` };
}
