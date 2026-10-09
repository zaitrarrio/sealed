import { p256 } from "@noble/curves/nist.js";
import {
  ErrorCode,
  claimTransfer,
  concat,
  downloadTransfer,
  encodeCbor,
  fromB64url,
  sha256,
  startShare,
  toB64url,
  utf8,
  waitForApproval,
  type RelayClient,
  type UvEvidence,
} from "@sealed/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemorySink, bytesOf, client, expectRelayError, file, makeDevice, makeIdentity } from "./helpers";

const RP_ID = "relay.test";
const ORIGIN = "https://relay.test";

/** A software platform authenticator: ES256 credential, "none" attestation, UV always performed. */
class SoftAuthenticator {
  readonly secret = p256.utils.randomSecretKey();
  readonly credentialId = crypto.getRandomValues(new Uint8Array(32));
  private counter = 0;

  private coseKey(): Uint8Array {
    const pub = p256.getPublicKey(this.secret, false);
    return encodeCbor({ 1: 2, 3: -7, "-1": 1, "-2": pub.slice(1, 33), "-3": pub.slice(33, 65) });
  }

  private clientData(type: string, challenge: string, origin: string): Uint8Array {
    return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(options: Record<string, unknown>, origin = ORIGIN): Record<string, unknown> {
    const rpIdHash = sha256(utf8(RP_ID));
    const flags = 0x01 | 0x04 | 0x40;
    const credLen = new Uint8Array([0, this.credentialId.length]);
    const authData = concat(rpIdHash, new Uint8Array([flags]), new Uint8Array(4), new Uint8Array(16), credLen, this.credentialId, this.coseKey());
    const attestationObject = encodeCbor({ fmt: "none", attStmt: {}, authData });
    const id = toB64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: { clientDataJSON: toB64url(this.clientData("webauthn.create", options["challenge"] as string, origin)), attestationObject: toB64url(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  assert(options: Record<string, unknown>, flags = 0x01 | 0x04): Extract<UvEvidence, { kind: "webauthn" }> {
    this.counter++;
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, this.counter);
    const authData = concat(sha256(utf8(RP_ID)), new Uint8Array([flags]), counter);
    const clientData = this.clientData("webauthn.get", options["challenge"] as string, ORIGIN);
    const sig = p256.sign(concat(authData, sha256(clientData)), this.secret, { format: "der" });
    return { kind: "webauthn", credential_id: toB64url(this.credentialId), client_data_json: toB64url(clientData), authenticator_data: toB64url(authData), signature: toB64url(sig) };
  }
}

async function registerPasskey(c: RelayClient): Promise<SoftAuthenticator> {
  const auth = new SoftAuthenticator();
  const { options } = await c.webauthnRegisterOptions();
  expect(options["rp"]).toMatchObject({ id: RP_ID });
  await c.webauthnRegisterVerify(auth.register(options));
  return auth;
}

describe("WebAuthn passkeys (ADR-0005)", () => {
  it("registers a passkey and approves a browser-key share with an action-bound assertion", async () => {
    const sender = await makeIdentity("browser", "Chrome on Linux");
    const passkey = await registerPasskey(sender.client);
    const row = await env.DB.prepare("SELECT fp, sign_count FROM passkeys WHERE credential_id = ?").bind(toB64url(passkey.credentialId)).first();
    expect(row).toEqual({ fp: sender.fp, sign_count: 0 });

    const data = bytesOf(70_000, 5);
    const session = await startShare({ client: sender.client, origin: "https://sealed.to", files: [file("doc.pdf", data, "application/pdf")], mode: "direct", sender: { keys: sender.device, label: "Chrome", fingerprint: sender.fingerprint } });
    const receiver = makeDevice("secure-enclave", "iPhone");
    const handle = await claimTransfer({ client: client(), transferId: session.transferIdBytes, claimSecret: session.claimSecret, device: receiver, label: "iPhone" });
    // The receiver long-polls while the sender approves.
    const waiting = waitForApproval(client(), handle);
    await session.uploaded;
    const claim = (await sender.client.transferStatus(session.transferId)).claims[0]!;

    // An assertion over a challenge issued for a different action is refused.
    await expectRelayError(
      session.approve(claim, async () => passkey.assert((await sender.client.webauthnAuthOptions(`approve:${session.transferId}:${claim.claim_id}:${toB64url(new Uint8Array(32))}`)).options)),
      403,
      ErrorCode.Forbidden,
    );
    // An assertion without the UV flag is refused.
    await expectRelayError(session.approve(claim, async (action) => passkey.assert((await sender.client.webauthnAuthOptions(action)).options, 0x01)), 403, ErrorCode.Forbidden);

    await session.approve(claim, async (action) => passkey.assert((await sender.client.webauthnAuthOptions(action)).options));
    expect(await waiting).toBe("approved");
    const sink = new MemorySink();
    await downloadTransfer({ client: client(), transferId: handle.transferId, auth: { claimToken: handle.claimToken, claimId: handle.claimId }, device: receiver, sink });
    expect(sink.bytes("doc.pdf")).toEqual(data);
    const after = await env.DB.prepare("SELECT sign_count FROM passkeys WHERE credential_id = ?").bind(toB64url(passkey.credentialId)).first<{ sign_count: number }>();
    expect(after?.sign_count).toBeGreaterThan(0);
  });

  it("rejects a challenge replay, a foreign passkey, and a wrong origin", async () => {
    const alice = await makeIdentity("browser");
    const bob = await makeIdentity("browser");
    const bobKey = await registerPasskey(bob.client);
    await registerPasskey(alice.client);

    // Registration challenge cannot be reused.
    const second = new SoftAuthenticator();
    const { options } = await alice.client.webauthnRegisterOptions();
    const response = second.register(options);
    await alice.client.webauthnRegisterVerify(response);
    await expectRelayError(alice.client.webauthnRegisterVerify(new SoftAuthenticator().register(options)), 400, ErrorCode.BadRequest);

    // Wrong origin in client data.
    const third = new SoftAuthenticator();
    const opts3 = (await alice.client.webauthnRegisterOptions()).options;
    await expectRelayError(alice.client.webauthnRegisterVerify(third.register(opts3, "https://evil.test")), 400, ErrorCode.BadRequest);

    // Bob's passkey cannot approve Alice's transfer.
    const session = await startShare({ client: alice.client, origin: "https://sealed.to", files: [file("x", bytesOf(10))], mode: "direct", sender: { keys: alice.device, label: "a", fingerprint: alice.fingerprint } });
    await claimTransfer({ client: client(), transferId: session.transferIdBytes, claimSecret: session.claimSecret, device: makeDevice("tee"), label: "r" });
    const claim = (await alice.client.transferStatus(session.transferId)).claims[0]!;
    await expectRelayError(session.approve(claim, async (action) => bobKey.assert((await bob.client.webauthnAuthOptions(action)).options)), 403, ErrorCode.Forbidden);
    expect(fromB64url(claim.claim_id)).toHaveLength(16);
  });
});
