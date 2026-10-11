/**
 * Share — Direct and Room (spec §3.3–3.4, §6.1–6.2, ADR-0004).
 *
 * The code appears as soon as the transfer exists; encryption and upload continue in the background. Each claim
 * shows the claiming device's label, key protection and the six-digit check code. Approving wraps the content key
 * to that device. On a phone the approval request is signed by the hardware-gated device key, which the relay
 * accepts as user verification (UV evidence {kind:"device"}):
 *   - Approve each: Face ID / fingerprint for every approval.
 *   - Approve in batches: one prompt, then every waiting device.
 *   - Auto-approve: devices are approved as they join while this screen stays open, inside the key's
 *     authenticated window (one prompt when the room opens and whenever the window lapses).
 */
import { Limits, RelayError, startShare, type ClaimStatus, type ClaimSummary, type ShareSession, type UvEvidence } from "@sealed/core";
import * as Clipboard from "expo-clipboard";
import { Redirect, router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { FilePicker } from "../src/components/FilePicker";
import { QrCode } from "../src/components/QrCode";
import { formatBytes } from "../src/lib/bytes";
import { codeOrigin } from "../src/lib/config";
import { toEnvelopeInputs, totalSize } from "../src/lib/files";
import { confirmUser } from "../src/lib/native-keys";
import { selectionSource, useSelection } from "../src/lib/selection";
import { openSenderEvents } from "../src/lib/sender-events";
import { useSession } from "../src/lib/session";
import { transferSessions } from "../src/lib/transfer-session-store";
import { Badge, B, Button, Card, CheckCode, Field, ListRow, Notice, P, Progress, ProtectionBadge, Row, Screen, Segmented, Stack, Title, Toggle, errorMessage } from "../src/ui/kit";

type Approval = "each" | "batch" | "auto";

interface ClaimView extends ClaimSummary {
  sas: string;
  busy?: boolean;
  error?: string;
}

const RELAY_TIMEOUT_MS = 5_000;

export default function Share() {
  const s = useSession();
  const [files, setFiles] = useSelection();
  const [room, setRoom] = useState(false);
  const [windowMin, setWindowMin] = useState(String(Limits.roomDefaultWindowSeconds / 60));
  const [cap, setCap] = useState(String(Limits.roomDefaultCap));
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
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const approving = useRef(false);
  // Transfers live in transferSessions so navigating away does not cancel an in-flight share.
  useEffect(() => {
    const active = transferSessions.current;
    if (!share && active) setShare(active.session);
  }, [share]);

  useEffect(() => {
    if ([...claims.values()].some((c) => c.status === "approved" || c.status === "downloaded")) {
      transferSessions.markApproved();
    }
  }, [claims]);

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

  /** UV for one approval: optionally prompt first, then sign the request with the hardware key. */
  const deviceUv = (prompt: string | null) => async (): Promise<UvEvidence> => {
    if (!s.keys?.hardware) throw new Error("This phone has no secure hardware key, so it cannot approve. Use Share offline instead.");
    if (prompt) await confirmUser(prompt);
    return { kind: "device" };
  };

  const approveOne = async (c: ClaimView, prompt: string | null): Promise<boolean> => {
    if (!share) return false;
    patchClaim(c.claim_id, { busy: true, error: undefined as unknown as string });
    try {
      await share.approve(c, deviceUv(prompt));
      patchClaim(c.claim_id, { busy: false, status: "approved" });
      transferSessions.markApproved();
      return true;
    } catch (e) {
      patchClaim(c.claim_id, { busy: false, error: errorMessage(e) });
      return false;
    }
  };

  /** Approves `queue` in order. `promptEach` asks before every approval; otherwise once up front. */
  const approveQueue = async (queue: ClaimView[], promptEach: boolean, upFront: string | null) => {
    if (approving.current || queue.length === 0) return;
    approving.current = true;
    try {
      if (!promptEach && upFront) {
        try {
          await confirmUser(upFront);
        } catch (e) {
          for (const c of queue) patchClaim(c.claim_id, { error: errorMessage(e) });
          return;
        }
      }
      for (const c of queue) {
        const ok = await approveOne(c, promptEach ? `Approve ${c.label}` : null);
        if (!ok) break;
      }
    } finally {
      approving.current = false;
    }
  };

  // Auto-approve: process waiting claims in arrival order while the screen is open and not paused.
  useEffect(() => {
    if (!share || mode !== "room" || approval !== "auto" || autoPaused || approving.current) return;
    const queue = waiting.filter((c) => !c.busy && !c.error);
    if (queue.length > 0) void approveQueue(queue, false, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share, mode, approval, autoPaused, waiting.length]);

  if (!s.profile.fingerprint) return <Redirect href="/welcome" />;

  const begin = async (asRoom: boolean, capOverride?: number): Promise<void> => {
    if (!s.keys || files.length === 0) return;
    const roomCap = capOverride ?? clampInt(cap, 2, 5000, Limits.roomDefaultCap);
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
        ...(asRoom ? { room: { windowSeconds: clampInt(windowMin, 1, 60, 10) * 60, cap: roomCap, approval } } : {}),
        sender: { keys: s.keys, label: s.profile.label, fingerprint: s.chain!.fingerprint },
        source: selectionSource(files),
        onProgress: (p) => setUpload((u) => ({ ...u, done: p.bytesProcessed, total: p.totalBytes, finished: p.phase === "done" })),
        signal: ctl.signal,
      });
      const shareSession = await Promise.race([started, timeout]);
      transferSessions.adopt(shareSession, ctl);
      setShare(shareSession);
      setMode(asRoom ? "room" : "direct");
      shareSession.uploaded.then(
        () => setUpload((u) => ({ ...u, done: u.total, finished: true })),
        (e: unknown) => {
          if (!ctl.signal.aborted) setUpload((u) => ({ ...u, error: errorMessage(e) }));
        },
      );
      // Auto-approve opens the key's authenticated window once, up front.
      if (asRoom && approval === "auto") void confirmUser("Auto-approve devices joining your room").catch(() => setAutoPaused(true));
    } catch (e) {
      // A share that lost the race may still start later: stop its upload and cancel it, so nothing is left behind.
      if (started) {
        ctl.abort();
        void started.then((sh) => sh.cancel()).catch(() => undefined);
      }
      const limit = e instanceof RelayError && e.status === 403 ? /room cap exceeds your plan limit of (\d+)/.exec(e.message) : null;
      if (asRoom && limit && capOverride === undefined) {
        const allowed = Number(limit[1]);
        setCap(String(allowed));
        setCapNote(`Your account can admit up to ${allowed} devices per room for now, so the room is capped at ${allowed}.`);
        setStarting(false);
        return begin(true, allowed);
      }
      const offline = !(e instanceof RelayError);
      setStartError({ message: offline ? "Sealed could not reach the relay." : e.message, offline });
    } finally {
      clearTimeout(timer);
      setStarting(false);
    }
  };

  const stop = async () => {
    setShare(null);
    setClaims(new Map());
    await transferSessions.cancel();
  };

  if (!share) {
    return (
      <Screen>
        <Title eyebrow="Send">Choose files</Title>
        {!s.active ? <Notice tone="danger">This phone is not an active device of your identity, so it cannot send.</Notice> : null}
        {s.keys && !s.keys.hardware ? <Notice tone="danger">This phone has no secure hardware key, so it cannot approve receivers. Offline send works without approval.</Notice> : null}
        <FilePicker files={files} onChange={setFiles} disabled={starting} />
        <Stack>
          <Toggle
            label="Allow multiple people"
            detail="Keep the code on screen so many people can scan it. Each device gets its own copy, encrypted to it."
            value={room}
            onChange={setRoom}
            testID="room-toggle"
          />
          {room ? (
            <Stack>
              <Row wrap={false}>
                <View style={{ flex: 1 }}>
                  <Field label="Window (minutes)" keyboardType="number-pad" value={windowMin} onChangeText={setWindowMin} />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Up to this many devices" keyboardType="number-pad" value={cap} onChangeText={setCap} />
                </View>
              </Row>
              <Segmented
                label="Approval"
                value={approval}
                onChange={setApproval}
                options={[
                  ["each", "Approve each"],
                  ["batch", "In batches"],
                  ["auto", "Auto-approve"],
                ]}
              />
              {approval === "auto" ? <P tone="subtle">Auto-approve unlocks your key once and approves each device as it joins, while this screen is open.</P> : null}
            </Stack>
          ) : null}
        </Stack>
        {startError ? (
          <Card tone="danger">
            <P tone="danger">{startError.message}</P>
            {startError.offline ? (
              <Row>
                <Button title="Send offline instead" tone="primary" onPress={() => router.push("/offline/send")} />
                <P tone="subtle">Your selection is kept.</P>
              </Row>
            ) : null}
          </Card>
        ) : null}
        <Button
          title={starting ? "Preparing code…" : `Show code${files.length ? ` for ${files.length} ${files.length === 1 ? "file" : "files"} · ${formatBytes(totalSize(files))}` : ""}`}
          tone="primary"
          busy={starting}
          disabled={files.length === 0 || !s.active}
          onPress={() => void begin(room)}
          testID="start-share"
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title eyebrow={mode === "room" ? "Room" : "Direct"}>{mode === "room" ? "Anyone here can scan this" : "Have them scan this code"}</Title>
      <QrCode text={share.code} label="Share code. Scan it with the receiving device's camera." testID="share-code" />
      <P tone="subtle" style={{ textAlign: "center" }}>
        Works with any camera app. The code only lets a device ask — nothing is sent until you approve.
      </P>
      <Button
        small
        tone="ghost"
        title={copied ? "Link copied" : "Copy link instead"}
        onPress={() => void Clipboard.setStringAsync(share.code).then(() => setCopied(true))}
      />
      {upload.error ? (
        <Notice tone="danger">{`Upload failed: ${upload.error}`}</Notice>
      ) : (
        <Progress fraction={upload.finished ? 1 : upload.total ? upload.done / upload.total : 0} label={upload.finished ? "Encrypted and uploaded" : "Encrypting and uploading"} />
      )}
      {expired ? <Notice tone="danger">This share has expired. Start a new one to share again.</Notice> : null}
      {capNote && mode === "room" ? <Notice>{capNote}</Notice> : null}
      {!socketOpen && !expired ? <P tone="subtle">Connecting to the relay…</P> : null}
      {mode === "room" && approval === "batch" && waiting.length > 0 ? (
        <Button
          title={`Approve all waiting (${waiting.length})`}
          tone="primary"
          onPress={() => void approveQueue(waiting.filter((c) => !c.busy), false, `Approve ${waiting.length} devices`)}
          testID="approve-all"
        />
      ) : null}
      {mode === "room" && approval === "auto" ? (
        <Row between>
          <P tone="subtle">{autoPaused ? "Auto-approve paused" : `Auto-approving · ${waiting.length} in queue`}</P>
          <Button small title={autoPaused ? "Resume" : "Pause"} onPress={() => setAutoPaused((p) => !p)} />
        </Row>
      ) : null}
      {list.length === 0 ? (
        <Card tone="sunken">
          <P>Waiting for a scan…</P>
        </Card>
      ) : (
        <View>
          {list.map((c) => (
            <ClaimRow
              key={c.claim_id}
              c={c}
              room={mode === "room"}
              onApprove={() => void approveQueue([c], true, null)}
              onDeny={() => void share.deny(c.claim_id).then(() => patchClaim(c.claim_id, { status: "denied" }), (e: unknown) => patchClaim(c.claim_id, { error: errorMessage(e) }))}
              onRevoke={() => void share.revoke(c.claim_id).then(() => patchClaim(c.claim_id, { status: "revoked" }), (e: unknown) => patchClaim(c.claim_id, { error: errorMessage(e) }))}
            />
          ))}
        </View>
      )}
      <Row>
        {mode === "direct" ? (
          <Button
            title="Allow multiple people instead"
            onPress={() => {
              void stop().then(() => {
                setRoom(true);
                void begin(true);
              });
            }}
          />
        ) : null}
        <Button title="Stop sharing" tone="ghost" onPress={() => void stop()} testID="stop-share" />
      </Row>
      <P tone="subtle">Approved copies already decrypted on a device cannot be recalled; revoking stops downloads that have not finished.</P>
    </Screen>
  );
}

function clampInt(v: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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
    <ListRow testID="claim-row">
      <Row>
        <B>{c.label}</B>
        <ProtectionBadge protection={c.key_protection} />
      </Row>
      <P tone="subtle">{statusText(c.status)}</P>
      {c.status === "pending" ? (
        <CheckCode value={c.sas} label="Matches their screen?" testID="sender-sas" />
      ) : (
        <P tone="subtle" mono>{`Check code ${c.sas}`}</P>
      )}
      {c.error ? <Badge tone="bad">{c.error}</Badge> : null}
      {c.status === "pending" ? (
        <Row>
          <Button title={c.busy ? "Approving…" : "Approve"} tone="primary" busy={c.busy ?? false} onPress={onApprove} testID="approve" />
          <Button title="Deny" tone="ghost" disabled={c.busy ?? false} onPress={onDeny} testID="deny" />
        </Row>
      ) : null}
      {c.status === "approved" || (room && c.status === "downloaded") ? <Button small tone="danger" title="Revoke" onPress={onRevoke} /> : null}
    </ListRow>
  );
}
