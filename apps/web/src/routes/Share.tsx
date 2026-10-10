/**
 * Share — Direct and Room (spec §3.3–3.4, §6.1–6.2, ADR-0004).
 *
 * The code appears as soon as the transfer exists; encryption and upload continue in the background. Each claim
 * shows the claiming device's label, key protection and the six-digit check code. Approving wraps the content key
 * to that device and requires a passkey assertion bound to exactly this approval.
 *
 * Room approval modes on the web. The relay accepts an approval only with a WebAuthn assertion whose challenge
 * names that claim and the hash of its wrap, so a web sender cannot approve several devices with one prompt.
 *   - Approve each: one button per device.
 *   - Approve in batches: "Approve all waiting" walks the waiting devices in order, one passkey prompt each.
 *   - Auto-approve: devices are queued as they arrive and approved in order while this page stays open, one
 *     passkey prompt each; the queue is visible and can be paused. Native clients with hardware-gated keys
 *     approve without prompts (device UV); browser keys cannot.
 */
import { Limits, RelayError, startShare, type ClaimStatus, type ClaimSummary, type ShareSession } from "@sealed/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { FilePicker } from "../components/FilePicker";
import { QrCode } from "../components/QrCode";
import { CheckCode, Notice, PageTitle, Progress, ProtectionBadge, errorMessage } from "../components/ui";
import { formatBytes } from "../lib/bytes";
import { useOnUnmount } from "../lib/hooks";
import { codeOrigin } from "../lib/config";
import { toEnvelopeInputs, totalSize } from "../lib/files";
import { selectionSource, useSelection } from "../lib/selection";
import { openSenderEvents } from "../lib/sender-events";
import { useSession } from "../lib/session";
import { describeWebAuthnError, userVerification } from "../lib/webauthn";

type Approval = "each" | "batch" | "auto";

interface ClaimView extends ClaimSummary {
  sas: string;
  busy?: boolean;
  error?: string;
}

const RELAY_TIMEOUT_MS = 5_000;

export function SharePage() {
  const s = useSession();
  const navigate = useNavigate();
  const [files, setFiles] = useSelection();
  const [room, setRoom] = useState(false);
  const [windowMin, setWindowMin] = useState(Limits.roomDefaultWindowSeconds / 60);
  const [cap, setCap] = useState<number>(Limits.roomDefaultCap);
  const [approval, setApproval] = useState<Approval>("each");
  const [share, setShare] = useState<ShareSession | null>(null);
  const [mode, setMode] = useState<"direct" | "room">("direct");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ message: string; offline: boolean } | null>(null);
  const [upload, setUpload] = useState<{ done: number; total: number; finished: boolean; error?: string }>({ done: 0, total: 0, finished: false });
  const [claims, setClaims] = useState<Map<string, ClaimView>>(new Map());
  const [socketOpen, setSocketOpen] = useState(false);
  const [expired, setExpired] = useState(false);
  const [autoPaused, setAutoPaused] = useState(false);
  const [capNote, setCapNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const approving = useRef(false);
  const shareRef = useRef<ShareSession | null>(null);
  shareRef.current = share;
  const anyApproved = useRef(false);
  anyApproved.current = [...claims.values()].some((c) => c.status === "approved" || c.status === "downloaded");

  // On leaving the page: if nobody was approved, stop the upload and cancel the transfer (its ciphertext is
  // deleted). Once a device is approved the upload keeps running and the transfer lives until its TTL, so the
  // receiver can finish downloading.
  useOnUnmount(() => {
    const sh = shareRef.current;
    if (!sh || anyApproved.current) return;
    abort.current?.abort();
    void sh.cancel().catch(() => undefined);
  });

  useEffect(() => {
    if (!share) return;
    return openSenderEvents(
      share.eventsUrl,
      (ev) => {
        if (ev.type === "claim") {
          setClaims((prev) => {
            const next = new Map(prev);
            const existing = prev.get(ev.claim.claim_id);
            next.set(ev.claim.claim_id, { ...ev.claim, sas: share.sasFor(ev.claim), ...(existing?.busy ? { busy: true } : {}) });
            return next;
          });
        } else if (ev.type === "claim_update") {
          setClaims((prev) => {
            const c = prev.get(ev.claim_id);
            if (!c) return prev;
            const next = new Map(prev);
            next.set(ev.claim_id, { ...c, status: ev.status });
            return next;
          });
        } else if (ev.type === "uploaded") {
          setUpload((u) => ({ ...u, finished: true }));
        } else if (ev.type === "expired") {
          setExpired(true);
        }
      },
      setSocketOpen,
    );
  }, [share]);

  const list = useMemo(() => [...claims.values()].sort((a, b) => a.created_at - b.created_at), [claims]);
  const waiting = list.filter((c) => c.status === "pending");

  const patchClaim = (id: string, patch: Partial<ClaimView>) =>
    setClaims((prev) => {
      const c = prev.get(id);
      if (!c) return prev;
      const next = new Map(prev);
      next.set(id, { ...c, ...patch });
      return next;
    });

  const approveOne = async (c: ClaimView): Promise<boolean> => {
    if (!share) return false;
    patchClaim(c.claim_id, { busy: true, error: undefined as unknown as string });
    try {
      await share.approve(c, (action) => userVerification(s.client, action));
      patchClaim(c.claim_id, { busy: false, status: "approved" });
      return true;
    } catch (e) {
      const msg = e instanceof RelayError ? e.message : describeWebAuthnError(e);
      patchClaim(c.claim_id, { busy: false, error: msg });
      return false;
    }
  };

  const approveQueue = async (queue: ClaimView[]) => {
    if (approving.current) return;
    approving.current = true;
    try {
      for (const c of queue) {
        const ok = await approveOne(c);
        if (!ok) break;
      }
    } finally {
      approving.current = false;
    }
  };

  // Auto-approve: process waiting claims in arrival order while the page is open and not paused.
  useEffect(() => {
    if (!share || mode !== "room" || approval !== "auto" || autoPaused || approving.current) return;
    const queue = waiting.filter((c) => !c.busy && !c.error);
    if (queue.length > 0) void approveQueue(queue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share, mode, approval, autoPaused, waiting.length]);

  if (!s.profile.fingerprint) return <Navigate to="/welcome" replace />;

  const begin = async (asRoom: boolean, capOverride?: number): Promise<void> => {
    if (!s.keys || files.length === 0) return;
    const roomCap = capOverride ?? cap;
    setStarting(true);
    setStartError(null);
    setClaims(new Map());
    setExpired(false);
    const total = totalSize(files);
    setUpload({ done: 0, total, finished: false });
    const ctl = new AbortController();
    abort.current = ctl;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), RELAY_TIMEOUT_MS);
    });
    let started: Promise<ShareSession> | null = null;
    try {
      started = startShare({
        client: s.client,
        origin: codeOrigin(),
        files: toEnvelopeInputs(files),
        mode: asRoom ? "room" : "direct",
        ...(asRoom ? { room: { windowSeconds: Math.round(windowMin * 60), cap: roomCap, approval } } : {}),
        sender: { keys: s.keys, label: s.profile.label, fingerprint: s.chain!.fingerprint },
        source: selectionSource(files),
        onProgress: (p) => setUpload((u) => ({ ...u, done: p.bytesProcessed, total: p.totalBytes, finished: p.phase === "done" })),
        signal: ctl.signal,
      });
      const session = await Promise.race([started, timeout]);
      setShare(session);
      setMode(asRoom ? "room" : "direct");
      session.uploaded.then(
        () => setUpload((u) => ({ ...u, done: u.total, finished: true })),
        (e: unknown) => {
          if (!ctl.signal.aborted) setUpload((u) => ({ ...u, error: errorMessage(e) }));
        },
      );
    } catch (e) {
      // A share that lost the race may still start later: stop its upload and cancel it, so nothing is left behind.
      if (started) {
        ctl.abort();
        void started.then((sh) => sh.cancel()).catch(() => undefined);
      }
      // New accounts have a lower room cap (ADR-0015); the relay names the limit. Retry once at that cap.
      const limit = e instanceof RelayError && e.status === 403 ? /room cap exceeds your plan limit of (\d+)/.exec(e.message) : null;
      if (asRoom && limit && capOverride === undefined) {
        const allowed = Number(limit[1]);
        setCap(allowed);
        setCapNote(`Your account can admit up to ${allowed} devices per room for now, so the room is capped at ${allowed}.`);
        setStarting(false);
        return begin(true, allowed);
      }
      const offline = !(e instanceof RelayError);
      setStartError({
        message: offline ? "Sealed could not reach the relay." : e.message,
        offline,
      });
    } finally {
      clearTimeout(timer);
      setStarting(false);
    }
  };

  const stop = async () => {
    abort.current?.abort();
    const sh = share;
    setShare(null);
    setClaims(new Map());
    if (sh) await sh.cancel().catch(() => undefined);
  };

  if (!share) {
    return (
      <div className="stack-lg">
        <PageTitle eyebrow="Share">Choose what to hand over</PageTitle>
        {!s.active && <Notice tone="danger">This browser is not an active device of your identity, so it cannot share.</Notice>}
        <FilePicker files={files} onChange={setFiles} disabled={starting} />
        <fieldset className="stack">
          <legend>Who can receive</legend>
          <label className="toggle">
            <input type="checkbox" checked={room} onChange={(e) => setRoom(e.target.checked)} data-testid="room-toggle" />
            <span>
              <strong>Let a room join</strong>
              <br />
              <span className="subtle">Keep the code on screen so many people can scan it. Each device gets its own copy, encrypted to it.</span>
            </span>
          </label>
          {room && (
            <div className="stack">
              <div className="grid-2">
                <label className="field">
                  Window (minutes)
                  <input type="number" min={1} max={60} value={windowMin} onChange={(e) => setWindowMin(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} />
                </label>
                <label className="field">
                  Up to this many devices
                  <input type="number" min={2} max={5000} value={cap} onChange={(e) => setCap(Math.max(2, Math.min(5000, Number(e.target.value) || 2)))} />
                </label>
              </div>
              <div className="radio-row" role="radiogroup" aria-label="Approval">
                {(
                  [
                    ["each", "Approve each"],
                    ["batch", "Approve in batches"],
                    ["auto", "Auto-approve"],
                  ] as const
                ).map(([v, l]) => (
                  <label key={v}>
                    <input type="radio" name="approval" value={v} checked={approval === v} onChange={() => setApproval(v)} />
                    {l}
                  </label>
                ))}
              </div>
              {approval === "auto" && <p className="subtle">Auto-approve asks for your passkey once per device as each one joins, while this page is open.</p>}
            </div>
          )}
        </fieldset>
        {!s.profile.passkeyRegistered && (
          <Notice>
            You have not added a passkey, so you will not be able to approve receivers. <Link to="/settings">Add one in Settings</Link>.
          </Notice>
        )}
        {startError && (
          <div className="card danger stack" role="alert">
            <p>{startError.message}</p>
            {startError.offline && (
              <div className="row">
                <button type="button" className="btn primary" onClick={() => navigate("/offline")}>
                  Share offline instead
                </button>
                <span className="subtle">Your selection is kept.</span>
              </div>
            )}
          </div>
        )}
        <button type="button" className="btn primary block" disabled={files.length === 0 || starting || !s.active} onClick={() => void begin(room)} data-testid="start-share">
          {starting ? "Preparing code…" : `Show code${files.length ? ` for ${files.length} ${files.length === 1 ? "file" : "files"} · ${formatBytes(totalSize(files))}` : ""}`}
        </button>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <PageTitle eyebrow={mode === "room" ? "Room" : "Direct"}>{mode === "room" ? "Anyone here can scan this" : "Have them scan this code"}</PageTitle>
      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="stack" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <QrCode text={share.code} label="Share code. Scan it with the receiving device's camera." testId="share-code" />
          <p className="subtle" style={{ textAlign: "center" }}>
            Works with any camera app. The code only lets a device ask — nothing is sent until you approve.
          </p>
          <details style={{ width: "100%" }}>
            <summary className="subtle">Copy link instead</summary>
            <input type="text" readOnly value={share.code} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label="Share link" data-testid="share-link" />
          </details>
        </div>
        <div className="stack">
          {upload.error ? (
            <Notice tone="danger">Upload failed: {upload.error}</Notice>
          ) : (
            <Progress fraction={upload.finished ? 1 : upload.total ? upload.done / upload.total : 0} label={upload.finished ? "Encrypted and uploaded" : "Encrypting and uploading"} />
          )}
          {expired && <Notice tone="danger">This share has expired. Start a new one to share again.</Notice>}
          {capNote && mode === "room" && <Notice>{capNote}</Notice>}
          {!socketOpen && !expired && <p className="subtle">Connecting to the relay…</p>}
          {mode === "room" && approval === "batch" && waiting.length > 0 && (
            <button type="button" className="btn primary" onClick={() => void approveQueue(waiting.filter((c) => !c.busy))} data-testid="approve-all">
              Approve all waiting ({waiting.length}) — one passkey prompt each
            </button>
          )}
          {mode === "room" && approval === "auto" && (
            <div className="row between">
              <span className="subtle">{autoPaused ? "Auto-approve paused" : `Auto-approving · ${waiting.length} in queue`}</span>
              <button type="button" className="btn small" onClick={() => setAutoPaused((p) => !p)}>
                {autoPaused ? "Resume" : "Pause"}
              </button>
            </div>
          )}
          {list.length === 0 ? (
            <div className="card sunken">
              <p className="muted" style={{ margin: 0 }}>
                Waiting for a scan…
              </p>
            </div>
          ) : (
            <ul className="list" aria-label={mode === "room" ? "Joined devices" : "Requests"} aria-live="polite">
              {list.map((c) => (
                <ClaimRow
                  key={c.claim_id}
                  c={c}
                  room={mode === "room"}
                  onApprove={() => void approveQueue([c])}
                  onDeny={() => void share.deny(c.claim_id).then(() => patchClaim(c.claim_id, { status: "denied" }), (e: unknown) => patchClaim(c.claim_id, { error: errorMessage(e) }))}
                  onRevoke={() => void share.revoke(c.claim_id).then(() => patchClaim(c.claim_id, { status: "revoked" }), (e: unknown) => patchClaim(c.claim_id, { error: errorMessage(e) }))}
                />
              ))}
            </ul>
          )}
          <div className="row">
            {mode === "direct" && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void stop().then(() => {
                    setRoom(true);
                    void begin(true);
                  });
                }}
              >
                Let a room join instead
              </button>
            )}
            <button type="button" className="btn ghost" onClick={() => void stop()} data-testid="stop-share">
              Stop sharing
            </button>
          </div>
          <p className="subtle">Approved copies already decrypted on a device cannot be recalled; revoking stops downloads that have not finished.</p>
        </div>
      </div>
    </div>
  );
}

function statusText(s: ClaimStatus): string {
  switch (s) {
    case "pending":
      return "wants these files";
    case "approved":
      return "approved — downloading";
    case "downloaded":
      return "received";
    case "denied":
      return "denied";
    case "expired":
      return "request expired";
    case "revoked":
      return "revoked";
  }
}

function ClaimRow({ c, room, onApprove, onDeny, onRevoke }: { c: ClaimView; room: boolean; onApprove: () => void; onDeny: () => void; onRevoke: () => void }) {
  return (
    <li data-testid="claim-row" data-claim-status={c.status}>
      <div className="grow stack" style={{ gap: 4 }}>
        <div className="row">
          <strong>{c.label}</strong>
          <ProtectionBadge protection={c.key_protection} />
        </div>
        <span className="subtle">{statusText(c.status)}</span>
        {c.status === "pending" ? <CheckCode value={c.sas} label="Matches their screen?" testId="sender-sas" /> : <span className="mono subtle">Check code {c.sas}</span>}
        {c.error && <span className="badge bad">{c.error}</span>}
      </div>
      {c.status === "pending" && (
        <div className="row">
          <button type="button" className="btn primary" disabled={c.busy} onClick={onApprove} data-testid="approve">
            {c.busy ? "Approving…" : "Approve"}
          </button>
          <button type="button" className="btn ghost" disabled={c.busy} onClick={onDeny} data-testid="deny">
            Deny
          </button>
        </div>
      )}
      {(c.status === "approved" || (room && c.status === "downloaded")) && (
        <button type="button" className="btn small danger" onClick={onRevoke}>
          Revoke
        </button>
      )}
    </li>
  );
}
