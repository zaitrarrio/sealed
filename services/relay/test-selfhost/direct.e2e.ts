/**
 * End-to-end Direct flow against a running relay over real HTTP (ADR-0012 "relay/selfhost").
 *   RELAY_URL=http://localhost:8787 pnpm --filter @sealed/relay test:selfhost
 */
import {
  RelayClient,
  SoftwareAgreementKey,
  SoftwareSigningKey,
  claimTransfer,
  createIdentity,
  sha256,
  toB64url,
  downloadTransfer,
  startShare,
  waitForApproval,
  type AgreementKey,
  type SigningKey,
} from "@sealed/core";
import { expect, it } from "vitest";

const BASE = process.env.RELAY_URL ?? "http://127.0.0.1:8787";

/** Software keys that report hardware protection, standing in for a Secure Enclave device. */
function enclaveDevice(): { agreement: AgreementKey; signing: SigningKey } {
  const a = new SoftwareAgreementKey();
  const s = new SoftwareSigningKey();
  return {
    agreement: { publicKey: a.publicKey, protection: "secure-enclave", dh: (p) => a.dh(p) },
    signing: { publicKey: s.publicKey, protection: "secure-enclave", sign: (m) => s.sign(m) },
  };
}

it("shares, claims, approves and downloads exact bytes through the relay", async () => {
  const health = (await (await fetch(`${BASE}/v1/health`)).json()) as { ok: boolean };
  expect(health.ok).toBe(true);

  const sender = enclaveDevice();
  const { link, state } = await createIdentity({ signing: sender.signing, agreementPublicKey: sender.agreement.publicKey, label: "e2e sender", protection: "secure-enclave" });
  const anon = new RelayClient({ baseUrl: BASE });
  await anon.createIdentity(link);
  const c = new RelayClient({ baseUrl: BASE, identity: { fingerprint: state.fingerprint, signing: sender.signing } });

  const data = new Uint8Array(3_000_000).map((_, i) => (i * 31 + (i >> 9)) & 0xff);
  const share = await startShare({
    client: c,
    origin: "https://sealed.to",
    files: [{ path: "e2e/file.bin", mediaType: "application/octet-stream", size: data.length, data }],
    mode: "direct",
    sender: { keys: sender, label: "e2e sender", fingerprint: state.fingerprint },
  });
  const receiver = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
  const handle = await claimTransfer({ client: anon, transferId: share.transferIdBytes, claimSecret: share.claimSecret, device: receiver, label: "e2e receiver" });
  await share.uploaded;
  const claim = (await c.transferStatus(share.transferId)).claims[0]!;
  expect(share.sasFor(claim)).toBe(handle.sas);
  await share.approve(claim, async () => ({ kind: "device" }));
  expect(await waitForApproval(anon, handle)).toBe("approved");

  const parts: Uint8Array[] = [];
  await downloadTransfer({ client: anon, transferId: handle.transferId, auth: { claimToken: handle.claimToken, claimId: handle.claimId }, device: receiver, sink: { onFileData: (_e, ch) => void parts.push(ch.slice()) } });
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  expect((await c.getChain(state.fingerprint)).headSeq).toBe(0);
  // Compare digests: a deep compare of 3 MB is slow enough for the server to drop idle keep-alive sockets.
  expect(out.length).toBe(data.length);
  expect(toB64url(sha256(out))).toBe(toB64url(sha256(data)));
}, 120_000);
