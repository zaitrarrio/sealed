/**
 * Inbox (spec §6.4.2–6.4.3): stored deliveries from pinned contacts (and copies from this identity's other
 * devices), plus live transfers received over WebRTC. Opening a delivery verifies the sender against the pinned
 * chain, unwraps with the matching prekey (deleting one-time prekeys after use), decrypts and verifies.
 */
import type { MailboxItem, Manifest } from "@sealed/core";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { DirectReceive } from "../components/direct-receive";
import { ReceivedFiles } from "../components/ReceivedFiles";
import { Notice, PageTitle, Progress, Spinner, errorMessage } from "../components/ui";
import { formatBytes } from "../lib/bytes";
import { getContact } from "../lib/contacts-store";
import { useOnUnmount } from "../lib/hooks";
import { claimArrival, dismissLive, refreshInbox, removeInboxItem, useInbox } from "../lib/inbox";
import { openInboxItem } from "../lib/paired";
import { ReceiveSink, type ReceivedFile } from "../lib/received";
import { useSession } from "../lib/session";

interface Opened {
  manifest: Manifest | null;
  done: number;
  total: number;
  files?: ReceivedFile[];
  error?: string;
}

export function InboxPage() {
  const s = useSession();
  const location = useLocation();
  const listenNow = Boolean((location.state as { listen?: boolean } | null)?.listen);
  const inbox = useInbox();
  const [names, setNames] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const [sinks] = useState(() => new Map<string, ReceiveSink>());
  useOnUnmount(() => {
    for (const sink of sinks.values()) void sink.discard();
  });

  useEffect(() => {
    void refreshInbox();
  }, []);

  useEffect(() => {
    void (async () => {
      const out: Record<string, string> = {};
      for (const i of inbox.items) {
        if (out[i.sender_fp]) continue;
        if (i.sender_fp === s.profile.fingerprint) out[i.sender_fp] = "You, from another device";
        else out[i.sender_fp] = (await getContact(i.sender_fp))?.displayName ?? "Unknown sender";
      }
      setNames(out);
    })();
  }, [inbox.items, s.profile.fingerprint]);

  const openRef = useRef<(item: MailboxItem) => void>(() => undefined);
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const arrival of inbox.arrivals) {
      const item = inbox.items.find((i) => i.transfer_id === arrival.id);
      if (!item) continue;
      timers.push(
        setTimeout(() => {
          if (claimArrival(item.transfer_id)) openRef.current(item);
        }, 0),
      );
    }
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [inbox.arrivals, inbox.items]);

  const open = (item: MailboxItem) => {
    const sink = new ReceiveSink();
    sinks.set(item.transfer_id, sink);
    let manifest: Manifest | null = null;
    setOpened((o) => ({ ...o, [item.transfer_id]: { manifest: null, done: 0, total: 0 } }));
    openInboxItem(
      item,
      sink,
      (done, total) => setOpened((o) => ({ ...o, [item.transfer_id]: { manifest, done, total } })),
      (m) => {
        manifest = m;
        setOpened((o) => ({ ...o, [item.transfer_id]: { manifest: m, done: 0, total: m.files.reduce((a, f) => a + f.size, 0) } }));
      },
    )
      .then((m) => setOpened((o) => ({ ...o, [item.transfer_id]: { manifest: m, done: 1, total: 1, files: [...sink.files] } })))
      .catch((e: unknown) => {
        void sink.discard();
        setOpened((o) => ({ ...o, [item.transfer_id]: { manifest, done: 0, total: 0, error: errorMessage(e) } }));
      });
  };
  openRef.current = open;

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Inbox">Files sent to you</PageTitle>
      <DirectReceive autoStart={listenNow} />
      {inbox.error && !/fetch|network|Failed to fetch/i.test(inbox.error) && <Notice tone="danger">Could not load saved deliveries: {inbox.error}</Notice>}
      <div className="row between">
        <span className="subtle">{s.presence?.status === "open" ? "Connected — new deliveries appear here automatically." : "No server. Point the camera at their screen and the file shows up here."}</span>
        {s.presence?.status === "open" && (
          <button type="button" className="btn small" onClick={() => void refreshInbox()} disabled={inbox.loading}>
            {inbox.loading ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>

      {inbox.live.map((l) => (
        <div key={l.id} className="card stack" data-testid="live-item">
          <div className="row between">
            <strong>Direct from {l.senderLabel}</strong>
            <span className="badge">{l.status === "done" ? "received" : l.status === "failed" ? "interrupted" : "live"}</span>
          </div>
          {l.status === "failed" && <Notice tone="danger">The direct connection ended: {l.error}. If the sender's app switched to stored delivery, the files appear below.</Notice>}
          {(l.status === "connecting" || l.status === "receiving") && <Progress fraction={l.totalBytes ? l.bytesDone / l.totalBytes : 0} label={l.status === "connecting" ? "Connecting" : "Receiving directly"} />}
          {l.status === "done" && inbox.liveFiles[l.id] && <ReceivedFiles files={inbox.liveFiles[l.id]!} />}
          {(l.status === "done" || l.status === "failed") && (
            <button type="button" className="btn small ghost" onClick={() => dismissLive(l.id)}>
              Dismiss
            </button>
          )}
        </div>
      ))}

      {inbox.items.map((item) => {
        const o = opened[item.transfer_id];
        return (
          <div key={item.transfer_id} className="card stack" data-testid="inbox-item">
            <div className="row between">
              <strong>From {names[item.sender_fp] ?? "…"}</strong>
              <span className="subtle">
                {new Date(item.created_at * 1000).toLocaleString()} · expires {new Date(item.expires_at * 1000).toLocaleDateString()}
              </span>
            </div>
            {!o && !inbox.arrivals.some((a) => a.id === item.transfer_id) && (
              <button type="button" className="btn primary" onClick={() => open(item)} data-testid="open-inbox-item">
                Open
              </button>
            )}
            {!o && inbox.arrivals.some((a) => a.id === item.transfer_id) && <Progress fraction={0} label="Opening" />}
            {o && !o.files && !o.error && <Progress fraction={o.total ? o.done / o.total : 0} label={o.manifest ? `${o.manifest.files.length} files · ${formatBytes(o.total)}` : "Verifying sender and unwrapping"} />}
            {o?.error && <Notice tone="danger">{o.error}</Notice>}
          </div>
        );
      })}

      {Object.entries(opened)
        .filter(([id, o]) => o.files && !inbox.items.some((i) => i.transfer_id === id))
        .map(([id, o]) => (
          <div key={id} className="card stack" data-testid="inbox-opened">
            <div className="row between">
              <strong>{o.manifest?.sender?.label ? `From ${o.manifest.sender.label}` : "Received"}</strong>
              <span className="badge hw">verified</span>
            </div>
            <ReceivedFiles files={o.files!} />
          </div>
        ))}

      {Object.entries(opened).map(([id, o]) => (o.files && inbox.items.some((i) => i.transfer_id === id) ? <AckOnOpen key={id} id={id} /> : null))}

      {inbox.loading && inbox.items.length === 0 && s.presence?.status === "open" && <Spinner label="Loading…" />}
    </div>
  );
}

/** Once an item is opened (and acknowledged by receivePaired), drop it from the pending list. */
function AckOnOpen({ id }: { id: string }) {
  useEffect(() => {
    removeInboxItem(id);
  }, [id]);
  return null;
}
