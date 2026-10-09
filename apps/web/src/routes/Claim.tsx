/**
 * Claim landing (spec §3.3 steps 3–6, §6.1.2–6.1.4). Reached by scanning in-app or by a phone's camera app
 * opening https://<origin>/c/<transfer>#<claim secret>. The secret is read from the fragment, which browsers
 * never send to a server. No account is needed: this browser's device keys are created silently if missing.
 */
import { RelayError, claimTransfer, downloadTransfer, fromB64url, waitForApproval, type ClaimHandle, type Manifest } from "@sealed/core";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { ReceivedFiles } from "../components/ReceivedFiles";
import { CheckCode, Notice, PageTitle, Progress, Spinner, errorMessage } from "../components/ui";
import { formatBytes } from "../lib/bytes";
import { useOnUnmount, useUnmountSignal } from "../lib/hooks";
import { ReceiveSink, type ReceivedFile } from "../lib/received";
import { useSession } from "../lib/session";
import { ReportForm } from "./Settings";

type Phase =
  | { name: "claiming" }
  | { name: "waiting"; handle: ClaimHandle }
  | { name: "downloading"; handle: ClaimHandle; manifest: Manifest | null; done: number; total: number }
  | { name: "done"; handle: ClaimHandle; manifest: Manifest; files: ReceivedFile[] }
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

export function ClaimPage() {
  const s = useSession();
  const { transferId = "" } = useParams();
  const location = useLocation();
  const [phase, setPhase] = useState<Phase>({ name: "claiming" });
  const sinkRef = useRef<ReceiveSink | null>(null);
  const started = useRef(false);
  const signal = useUnmountSignal();
  useOnUnmount(() => void sinkRef.current?.discard());

  useEffect(() => {
    if (started.current || !s.keys) return;
    const secret = location.hash.replace(/^#/, "");
    let transferBytes: Uint8Array;
    let claimSecret: Uint8Array;
    try {
      transferBytes = fromB64url(transferId);
      claimSecret = fromB64url(secret);
      if (transferBytes.length !== 16 || claimSecret.length !== 16) throw new Error("malformed");
    } catch {
      setPhase({ name: "ended", title: "This code is incomplete", detail: "The link is missing its secret part. Scan the code again rather than typing the link." });
      return;
    }
    started.current = true;
    // Remove the secret from the address bar and history once read.
    window.history.replaceState(window.history.state, "", `/c/${transferId}`);
    const keys = s.keys;
    const client = s.client;
    const ctl = { signal };
    void (async () => {
      let handle: ClaimHandle;
      try {
        handle = await claimTransfer({ client, transferId: transferBytes, claimSecret, device: keys, label: s.profile.label });
      } catch (e) {
        setPhase({ name: "ended", ...claimError(e) });
        return;
      }
      setPhase({ name: "waiting", handle });
      let outcome: Awaited<ReturnType<typeof waitForApproval>>;
      try {
        outcome = await waitForApproval(client, handle, ctl.signal);
      } catch (e) {
        if (!ctl.signal.aborted) setPhase({ name: "ended", handle, ...claimError(e) });
        return;
      }
      if (outcome !== "approved") {
        setPhase({ name: "ended", handle, ...endedFor(outcome) });
        return;
      }
      const sink = new ReceiveSink();
      sinkRef.current = sink;
      let manifest: Manifest | null = null;
      setPhase({ name: "downloading", handle, manifest: null, done: 0, total: 0 });
      try {
        const m = await downloadTransfer({
          client,
          transferId: handle.transferId,
          auth: { claimToken: handle.claimToken, claimId: handle.claimId },
          device: keys,
          sink,
          signal: ctl.signal,
          onManifest: (mm) => {
            manifest = mm;
            setPhase({ name: "downloading", handle, manifest: mm, done: 0, total: mm.files.reduce((a, f) => a + f.size, 0) });
          },
          onProgress: (p) => setPhase({ name: "downloading", handle, manifest, done: p.bytesDone, total: p.totalBytes }),
        });
        setPhase({ name: "done", handle, manifest: m, files: [...sink.files] });
      } catch (e) {
        if (ctl.signal.aborted) return;
        if (e instanceof RelayError && (e.code === "revoked" || e.status === 410)) setPhase({ name: "ended", handle, ...endedFor("revoked") });
        else setPhase({ name: "ended", handle, title: "The download failed", detail: `${errorMessage(e)}. Nothing partial was kept.` });
        void sink.discard();
      }
    })();
  }, [s.keys, s.client, s.profile.label, transferId, location.hash, signal]);

  return (
    <div className="main narrow" style={{ padding: 0 }}>
      {phase.name === "claiming" && (
        <div className="stack-lg">
          <PageTitle eyebrow="Receive">Connecting…</PageTitle>
          <Spinner label="Asking the sender for these files" />
        </div>
      )}
      {phase.name === "waiting" && (
        <div className="stack-lg" data-testid="claim-waiting">
          <PageTitle eyebrow="Receive">Check this code with the sender</PageTitle>
          <CheckCode value={phase.handle.sas} label="Check code" testId="receiver-sas" />
          <p className="muted">
            The sender's screen shows <strong>{s.profile.label}</strong> and a check code. If both codes match, they approve and the files arrive here. If they do not match, tell the sender to deny.
          </p>
          <Spinner label="Waiting for approval" />
        </div>
      )}
      {phase.name === "downloading" && (
        <div className="stack-lg">
          <PageTitle eyebrow="Approved">Receiving</PageTitle>
          <CheckCode value={phase.handle.sas} small />
          {phase.manifest && (
            <p className="muted">
              {phase.manifest.files.length} {phase.manifest.files.length === 1 ? "file" : "files"} · {formatBytes(phase.total)}
              {phase.manifest.sender ? ` from ${phase.manifest.sender.label}` : ""}
            </p>
          )}
          <Progress fraction={phase.total ? phase.done / phase.total : 0} label="Decrypting and verifying" />
        </div>
      )}
      {phase.name === "done" && (
        <div className="stack-lg" data-testid="claim-done">
          <PageTitle eyebrow="Received">
            {phase.files.length === 1 ? "Your file is here" : `${phase.files.length} files are here`}
          </PageTitle>
          {phase.manifest.sender && (
            <p className="muted">
              From <strong>{phase.manifest.sender.label}</strong>
              {phase.manifest.signature ? ", signed by the sender's device." : "."} Every file was verified against the sender's manifest.
            </p>
          )}
          <ReceivedFiles files={phase.files} />
          <details>
            <summary className="subtle">Report this transfer</summary>
            <ReportForm transferId={phase.handle.transferId} claimToken={phase.handle.claimToken} />
          </details>
          <Link to="/" className="btn ghost">
            Done
          </Link>
        </div>
      )}
      {phase.name === "ended" && (
        <div className="stack-lg" data-testid="claim-ended">
          <PageTitle eyebrow="Receive">{phase.title}</PageTitle>
          <Notice tone="danger">{phase.detail}</Notice>
          <Link to="/receive" className="btn">
            Scan another code
          </Link>
        </div>
      )}
    </div>
  );
}
