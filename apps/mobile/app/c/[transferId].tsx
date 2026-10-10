/**
 * Claim landing (spec §3.3 steps 3–6, §6.1.2–6.1.4). Reached by scanning in-app or by the phone camera opening
 * https://<origin>/c/<transfer>#<claim secret>; the code arrives via the in-memory stash (`?ref=`), never as a
 * route parameter. No account is needed: this phone's device keys exist from first launch.
 *
 * Files are stored encrypted at rest as they arrive (lib/received.ts); a failed or cancelled download keeps
 * nothing.
 */
import { RelayError, claimTransfer, concat, downloadTransfer, fromB64url, sha256, waitForApproval, type ClaimHandle, type Manifest } from "@sealed/core";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ReceivedFiles } from "../../src/components/ReceivedFiles";
import { ReportForm } from "../../src/components/ReportForm";
import { formatBytes } from "../../src/lib/bytes";
import { takeCode } from "../../src/lib/code-stash";
import { useOnUnmount, useUnmountSignal } from "../../src/lib/hooks";
import { claimAttestation } from "../../src/lib/native-keys";
import { ReceiveSink, type ReceivedFile } from "../../src/lib/received";
import { describeSender, type SenderView } from "../../src/lib/sender-check";
import { useSession } from "../../src/lib/session";
import { B, Button, CheckCode, Disclosure, Notice, P, Progress, Screen, Spinner, Title, errorMessage } from "../../src/ui/kit";

type Phase =
  | { name: "claiming" }
  | { name: "waiting"; handle: ClaimHandle }
  | { name: "downloading"; handle: ClaimHandle; manifest: Manifest | null; done: number; total: number }
  | { name: "done"; handle: ClaimHandle; manifest: Manifest; files: ReceivedFile[]; sender: SenderView | null }
  | { name: "ended"; title: string; detail: string; handle?: ClaimHandle };

function endedFor(status: "denied" | "expired" | "revoked"): { title: string; detail: string } {
  switch (status) {
    case "denied":
      return { title: "The sender declined", detail: "Nothing was shared with this device. If you expected these files, ask the sender to share again." };
    case "expired":
      return { title: "This code has expired", detail: "The request timed out or the share ended. Ask the sender to show a new code." };
    case "revoked":
      return { title: "Access was revoked", detail: "The sender withdrew this device's access before the download finished." };
  }
}

function claimError(e: unknown): { title: string; detail: string } {
  if (e instanceof RelayError) {
    if (e.code === "claim_consumed") return { title: "Someone already scanned this code", detail: "A code works once. If that was not you, tell the sender: they will see the other request and can deny it." };
    if (e.code === "claim_window_closed") return { title: "The room has closed", detail: "The sender's joining window ended." };
    if (e.code === "room_full") return { title: "The room is full", detail: "The sender's device limit was reached." };
    if (e.status === 404) return { title: "This code is not valid any more", detail: "The share may have ended or expired. Ask the sender for a new code." };
    return { title: "The relay refused this code", detail: e.message };
  }
  return { title: "Could not reach the relay", detail: errorMessage(e) };
}

export default function Claim() {
  const s = useSession();
  const { transferId = "", ref } = useLocalSearchParams<{ transferId: string; ref?: string }>();
  const [phase, setPhase] = useState<Phase>({ name: "claiming" });
  const sinkRef = useRef<ReceiveSink | null>(null);
  const finished = useRef(false);
  const started = useRef(false);
  const code = useRef<string | null | undefined>(undefined);
  if (code.current === undefined) code.current = takeCode(ref);
  const signal = useUnmountSignal();
  useOnUnmount(() => {
    if (!finished.current) void sinkRef.current?.discard();
  });

  useEffect(() => {
    if (started.current || !s.keys) return;
    let transferBytes: Uint8Array;
    let claimSecret: Uint8Array;
    try {
      const url = new URL(code.current ?? "");
      transferBytes = fromB64url(transferId);
      claimSecret = fromB64url(url.hash.replace(/^#/, ""));
      if (transferBytes.length !== 16 || claimSecret.length !== 16) throw new Error("malformed");
    } catch {
      setPhase({ name: "ended", title: "This code is incomplete", detail: "The link is missing its secret part. Scan the code again rather than typing the link." });
      return;
    }
    started.current = true;
    code.current = null;
    const keys = s.keys;
    const client = s.client;
    void (async () => {
      let handle: ClaimHandle;
      try {
        const attestation = await claimAttestation(sha256(concat(claimSecret, keys.agreement.publicKey)));
        handle = await claimTransfer({ client, transferId: transferBytes, claimSecret, device: keys, label: s.profile.label, ...(attestation ? { attestation } : {}) });
      } catch (e) {
        setPhase({ name: "ended", ...claimError(e) });
        return;
      }
      setPhase({ name: "waiting", handle });
      let outcome: Awaited<ReturnType<typeof waitForApproval>>;
      try {
        outcome = await waitForApproval(client, handle, signal);
      } catch (e) {
        if (!signal.aborted) setPhase({ name: "ended", handle, ...claimError(e) });
        return;
      }
      if (outcome !== "approved") {
        setPhase({ name: "ended", handle, ...endedFor(outcome) });
        return;
      }
      let manifest: Manifest | null = null;
      let senderView: Promise<SenderView | null> = Promise.resolve(null);
      setPhase({ name: "downloading", handle, manifest: null, done: 0, total: 0 });
      // The unwrap needs the agreement key: one Face ID / fingerprint prompt naming what is being opened.
      keys.agreement.setReason("Receive the files you were sent");
      const sink = new ReceiveSink(keys.agreement);
      sinkRef.current = sink;
      try {
        const m = await downloadTransfer({
          client,
          transferId: handle.transferId,
          auth: { claimToken: handle.claimToken, claimId: handle.claimId },
          device: keys,
          sink,
          signal,
          onManifest: (mm) => {
            manifest = mm;
            senderView = describeSender(mm.sender, s.chain).then((v) => {
              if (v) sink.from = v.display;
              return v;
            });
            setPhase({ name: "downloading", handle, manifest: mm, done: 0, total: mm.files.reduce((a, f) => a + f.size, 0) });
          },
          onProgress: (p) => setPhase({ name: "downloading", handle, manifest, done: p.bytesDone, total: p.totalBytes }),
        });
        finished.current = true;
        const sender = await senderView.catch(() => null);
        setPhase({ name: "done", handle, manifest: m, files: [...sink.files], sender });
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof RelayError && (e.code === "revoked" || e.status === 410)) setPhase({ name: "ended", handle, ...endedFor("revoked") });
        else setPhase({ name: "ended", handle, title: "The download failed", detail: `${errorMessage(e)}. Nothing partial was kept.` });
        void sink.discard();
      }
    })();
  }, [s.keys, s.client, s.profile.label, transferId, signal]);

  return (
    <Screen>
      {phase.name === "claiming" ? (
        <>
          <Title eyebrow="Receive">Connecting…</Title>
          <Spinner label="Asking the sender for these files" />
        </>
      ) : null}
      {phase.name === "waiting" ? (
        <>
          <Title eyebrow="Receive">Check this code with the sender</Title>
          <CheckCode value={phase.handle.sas} label="Check code" testID="receiver-sas" />
          <P>
            The sender's screen shows <B>{s.profile.label}</B> and a check code. If both codes match, they approve and the files arrive here. If they do not match, tell the sender to deny.
          </P>
          <Spinner label="Waiting for approval" />
        </>
      ) : null}
      {phase.name === "downloading" ? (
        <>
          <Title eyebrow="Approved">Receiving</Title>
          <CheckCode value={phase.handle.sas} small />
          {phase.manifest ? (
            <P>
              {phase.manifest.files.length} {phase.manifest.files.length === 1 ? "file" : "files"} · {formatBytes(phase.total)}
              {phase.manifest.sender ? ` · says it is from “${phase.manifest.sender.label}”` : ""}
            </P>
          ) : null}
          <Progress fraction={phase.total ? phase.done / phase.total : 0} label="Decrypting and verifying" />
        </>
      ) : null}
      {phase.name === "done" ? (
        <>
          <Title eyebrow="Received">{phase.files.length === 1 ? "Your file is here" : `${phase.files.length} files are here`}</Title>
          {phase.sender ? (
            phase.sender.verified ? (
              <P>
                From <B>{phase.sender.display}</B>, a paired contact — the signature matches their verified device list. Every file was verified against the sender's manifest.
              </P>
            ) : (
              <P>
                From {phase.sender.display}. Sealed cannot confirm who that is: anyone can type a name. Every file was verified against the manifest the sender's device signed.
              </P>
            )
          ) : null}
          <ReceivedFiles files={phase.files} />
          <Disclosure title="Report this transfer">
            <ReportForm transferId={phase.handle.transferId} claimToken={phase.handle.claimToken} />
          </Disclosure>
          <Button title="Done" tone="ghost" onPress={() => router.replace("/")} />
        </>
      ) : null}
      {phase.name === "ended" ? (
        <>
          <Title eyebrow="Receive">{phase.title}</Title>
          <Notice tone="danger">{phase.detail}</Notice>
          <Button title="Scan another code" onPress={() => router.replace("/receive")} />
        </>
      ) : null}
    </Screen>
  );
}
