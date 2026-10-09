/**
 * Inbox (spec §6.4.2–6.4.3): stored deliveries from pinned contacts (and copies from this identity's other
 * devices), plus live transfers received over WebRTC. Opening a delivery verifies the sender against the pinned
 * chain, unwraps with the matching prekey (deleting one-time prekeys after use), decrypts and verifies, and
 * stores the files encrypted at rest on this phone.
 */
import type { MailboxItem, Manifest } from "@sealed/core";
import { Redirect } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { ReceivedFiles } from "../src/components/ReceivedFiles";
import { formatBytes } from "../src/lib/bytes";
import { getContact } from "../src/lib/contacts-store";
import { useOnUnmount } from "../src/lib/hooks";
import { dismissLive, refreshInbox, removeInboxItem, useInbox } from "../src/lib/inbox";
import { openInboxItem } from "../src/lib/paired";
import { ReceiveSink, type ReceivedFile } from "../src/lib/received";
import { useSession } from "../src/lib/session";
import { B, Badge, Button, Card, Notice, P, Progress, Row, Screen, Spinner, Title, errorMessage } from "../src/ui/kit";

interface Opened {
  manifest: Manifest | null;
  done: number;
  total: number;
  files?: ReceivedFile[];
  error?: string;
}

export default function Inbox() {
  const s = useSession();
  const inbox = useInbox();
  const [names, setNames] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const [sinks] = useState(() => new Map<string, ReceiveSink>());
  const completed = useRef(new Set<string>());
  useOnUnmount(() => {
    // Only unfinished receives are discarded; completed ones are already stored.
    for (const [id, sink] of sinks) if (!completed.current.has(id)) void sink.discard();
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

  if (!s.profile.fingerprint) return <Redirect href="/welcome" />;

  const open = (item: MailboxItem) => {
    if (!s.keys) return;
    const sink = new ReceiveSink(s.keys.agreement, names[item.sender_fp]);
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
      .then((m) => {
        completed.current.add(item.transfer_id);
        setOpened((o) => ({ ...o, [item.transfer_id]: { manifest: m, done: 1, total: 1, files: [...sink.files] } }));
      })
      .catch((e: unknown) => {
        void sink.discard();
        setOpened((o) => ({ ...o, [item.transfer_id]: { manifest, done: 0, total: 0, error: errorMessage(e) } }));
      });
  };

  const empty = inbox.items.length === 0 && inbox.live.length === 0 && Object.keys(opened).length === 0;

  return (
    <Screen>
      <Title eyebrow="Paired">Inbox</Title>
      {inbox.error ? <Notice tone="danger">{`Could not load the inbox: ${inbox.error}`}</Notice> : null}
      <Row between>
        <P tone="subtle">{s.presence?.status === "open" ? "Connected — new deliveries appear here automatically." : "Reconnecting…"}</P>
        <Button small title={inbox.loading ? "Refreshing…" : "Refresh"} onPress={() => void refreshInbox()} disabled={inbox.loading} />
      </Row>

      {inbox.live.map((l) => (
        <Card key={l.id}>
          <Row between>
            <B>{`Direct from ${l.senderLabel}`}</B>
            <Badge>{l.status === "done" ? "received" : l.status === "failed" ? "interrupted" : "live"}</Badge>
          </Row>
          {l.status === "failed" ? <Notice tone="danger">{`The direct connection ended: ${l.error}. If the sender's app switched to stored delivery, the files appear below.`}</Notice> : null}
          {l.status === "connecting" || l.status === "receiving" ? <Progress fraction={l.totalBytes ? l.bytesDone / l.totalBytes : 0} label={l.status === "connecting" ? "Connecting" : "Receiving directly"} /> : null}
          {l.status === "done" && inbox.liveFiles[l.id] ? <ReceivedFiles files={inbox.liveFiles[l.id]!} /> : null}
          {l.status === "done" || l.status === "failed" ? <Button small tone="ghost" title="Dismiss" onPress={() => dismissLive(l.id)} /> : null}
        </Card>
      ))}

      {inbox.items.map((item) => {
        const o = opened[item.transfer_id];
        return (
          <Card key={item.transfer_id}>
            <B>{`From ${names[item.sender_fp] ?? "…"}`}</B>
            <P tone="subtle">
              {new Date(item.created_at * 1000).toLocaleString()} · expires {new Date(item.expires_at * 1000).toLocaleDateString()}
            </P>
            {!o ? <Button title="Open" tone="primary" onPress={() => open(item)} testID="open-inbox-item" /> : null}
            {o && !o.files && !o.error ? <Progress fraction={o.total ? o.done / o.total : 0} label={o.manifest ? `${o.manifest.files.length} files · ${formatBytes(o.total)}` : "Verifying sender and unwrapping"} /> : null}
            {o?.error ? <Notice tone="danger">{o.error}</Notice> : null}
          </Card>
        );
      })}

      {Object.entries(opened)
        .filter(([id, o]) => o.files && !inbox.items.some((i) => i.transfer_id === id))
        .map(([id, o]) => (
          <Card key={id}>
            <Row between>
              <B>{o.manifest?.sender?.label ? `From ${o.manifest.sender.label}` : "Received"}</B>
              <Badge tone="ok">verified</Badge>
            </Row>
            <ReceivedFiles files={o.files!} />
          </Card>
        ))}

      {Object.entries(opened).map(([id, o]) => (o.files && inbox.items.some((i) => i.transfer_id === id) ? <AckOnOpen key={id} id={id} /> : null))}

      {inbox.loading && inbox.items.length === 0 ? <Spinner label="Loading…" /> : null}
      {empty && !inbox.loading ? (
        <Card tone="sunken">
          <P>Nothing waiting. Files your contacts send appear here.</P>
        </Card>
      ) : null}
      <View />
    </Screen>
  );
}

/** Once an item is opened (and acknowledged by receivePaired), drop it from the pending list. */
function AckOnOpen({ id }: { id: string }) {
  useEffect(() => {
    removeInboxItem(id);
  }, [id]);
  return null;
}

