/**
 * Identity flows for this browser (spec §6.3, ADR-0006): create, join an existing identity as an added device,
 * restore with a paper key, add/revoke other devices, and create paper keys.
 */
import {
  RelayClient,
  approveNewDevice,
  compress,
  createAddDeviceOffer,
  createIdentity,
  createPaperKey,
  ctEqual,
  decodePaperKey,
  fromB64url,
  joinIdentity,
  recoverWithPaperKey,
  revokeDevice,
  verifyChain,
  type ChainState,
  type NewDeviceOffer,
  type ParsedCode,
} from "@sealed/core";
import { session } from "./session";

function requireKeys() {
  const { keys } = session.getSnapshot();
  if (!keys) throw new Error("device keys are not loaded yet");
  return keys;
}

/** Creates a new identity whose first device is this browser, registers it with the relay, and adopts it. */
export async function createNewIdentity(label: string): Promise<ChainState> {
  const keys = requireKeys();
  const { relayUrl } = session.getSnapshot();
  const { link, state } = await createIdentity({ signing: keys.signing, agreementPublicKey: keys.agreement.publicKey, label, protection: keys.agreement.protection });
  await new RelayClient({ baseUrl: relayUrl }).createIdentity(link);
  await session.adoptChain(state, [link]);
  return state;
}

/** New-device side, step 1: the code the existing device scans. */
export async function makeAddDeviceOffer(origin: string, label: string): Promise<NewDeviceOffer> {
  const keys = requireKeys();
  return createAddDeviceOffer(origin, { signing: keys.signing, agreementPublicKey: keys.agreement.publicKey, label, protection: keys.agreement.protection });
}

/** New-device side, step 2: after the existing device approved, scan its pairing code and join. */
export async function joinScannedIdentity(code: Extract<ParsedCode, { kind: "pair" }>): Promise<ChainState> {
  const keys = requireKeys();
  const { relayUrl } = session.getSnapshot();
  const client = new RelayClient({ baseUrl: relayUrl });
  const chain = await joinIdentity(client, code, keys.signing.publicKey);
  const { links } = await client.getChain(chain.fingerprint);
  const verified = verifyChain(links, chain.fingerprint);
  await session.adoptChain(verified, links);
  return verified;
}

/** Recovery with a paper key (spec §6.3.5): adds this browser and revokes the devices the user selected. */
export async function restoreWithPaperKey(paperText: string, label: string, revoke: (chain: ChainState) => Uint8Array[]): Promise<ChainState> {
  const keys = requireKeys();
  const { relayUrl } = session.getSnapshot();
  const { fingerprint } = decodePaperKey(paperText);
  const client = new RelayClient({ baseUrl: relayUrl, identity: { fingerprint, signing: keys.signing } });
  await recoverWithPaperKey(client, paperText, { signing: keys.signing, agreementPublicKey: keys.agreement.publicKey, label, protection: keys.agreement.protection }, revoke);
  const { links } = await client.getChain(fingerprint);
  const chain = verifyChain(links, fingerprint);
  await session.adoptChain(chain, links);
  return chain;
}

/** Reads the chain a paper key belongs to, so the user can choose which lost devices to revoke. */
export async function previewPaperKeyChain(paperText: string): Promise<ChainState> {
  const { fingerprint } = decodePaperKey(paperText);
  const { relayUrl } = session.getSnapshot();
  const { links } = await new RelayClient({ baseUrl: relayUrl }).getChain(fingerprint);
  return verifyChain(links, fingerprint);
}

/** Existing-device side: appends add_device for a scanned new-device code after the user confirmed the SAS. */
export function approveScannedDevice(code: Extract<ParsedCode, { kind: "add-device" }>): Promise<ChainState> {
  return session.withChainLock(async () => {
    const keys = requireKeys();
    const chain = await session.refreshOwnChain();
    await approveNewDevice(session.getSnapshot().client, chain, keys.signing, code);
    return session.refreshOwnChain();
  });
}

export function revokeOwnDevice(target: Uint8Array, reason: string): Promise<ChainState> {
  return session.withChainLock(async () => {
    const keys = requireKeys();
    if (ctEqual(compress(target), compress(keys.signing.publicKey))) throw new Error("Use another device or your paper key to revoke this browser.");
    const chain = await session.refreshOwnChain();
    await revokeDevice(session.getSnapshot().client, chain, keys.signing, target, reason);
    return session.refreshOwnChain();
  });
}

export function newPaperKey(): Promise<string> {
  return session.withChainLock(async () => {
    const keys = requireKeys();
    const chain = await session.refreshOwnChain();
    const { text } = await createPaperKey(session.getSnapshot().client, chain, keys.signing);
    await session.refreshOwnChain();
    await session.updateProfile({ paperKeyCreatedAt: Date.now() });
    return text;
  });
}

export function fingerprintBytes(): Uint8Array | null {
  const fp = session.getSnapshot().profile.fingerprint;
  return fp ? fromB64url(fp) : null;
}
