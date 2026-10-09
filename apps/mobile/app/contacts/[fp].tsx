/**
 * Send to a paired contact (spec §3.5, §6.4). Refreshes and verifies the contact's chain first (a fork blocks
 * sending). If a device of the contact is online, the transfer runs live over WebRTC; after 15 s without
 * progress or on failure it switches to stored delivery through the mailbox without user action.
 */
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { FilePicker } from "../../src/components/FilePicker";
import { getContact, type ContactRecord } from "../../src/lib/contacts-store";
import { toEnvelopeInputs } from "../../src/lib/files";
import { ContactBlocked, sendToPairedContact, type SendProgress } from "../../src/lib/paired";
import { selectionSource, useSelection } from "../../src/lib/selection";
import { useSession } from "../../src/lib/session";
import { Button, Notice, P, Progress, Row, Screen, Stack, Title, errorMessage } from "../../src/ui/kit";

export default function SendToContact() {
  const s = useSession();
  const { fp = "" } = useLocalSearchParams<{ fp: string }>();
  const [contact, setContact] = useState<ContactRecord | null | undefined>(undefined);
  const [files, setFiles] = useSelection();
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [result, setResult] = useState<{ route: "live" | "stored" } | null>(null);
  const [error, setError] = useState<{ message: string; blocked: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getContact(fp).then((c) => setContact(c ?? null));
  }, [fp]);

  if (!s.profile.fingerprint) return <Redirect href="/welcome" />;
  if (contact === null) return <Redirect href="/contacts" />;
  if (contact === undefined) return null;

  const online = s.presence?.online.get(fp) ?? 0;

  return (
    <Screen>
      <Title eyebrow="Send to contact">{`To ${contact.displayName}`}</Title>
      {contact.blocked ? <Notice tone="danger">{contact.blocked.reason}</Notice> : null}
      {!result ? <FilePicker files={files} onChange={setFiles} disabled={busy} /> : null}
      {!result && !contact.blocked ? (
        <Stack>
          <P tone="subtle">
            {online > 0
              ? `${contact.displayName} has a device online — files go directly to it when possible.`
              : `${contact.displayName} is offline — files wait encrypted in their inbox for up to 30 days.`}
          </P>
          <Button
            title={busy ? "Sending…" : "Send"}
            tone="primary"
            busy={busy}
            disabled={files.length === 0 || !s.active}
            testID="send-contact"
            onPress={() => {
              setBusy(true);
              setError(null);
              setNotes([]);
              const picked = files;
              sendToPairedContact(fp, () => toEnvelopeInputs(picked), {
                source: selectionSource(picked),
                onProgress: (p) => {
                  setProgress(p);
                  if (p.note) setNotes((n) => [...n, p.note!]);
                },
              })
                .then((r) => {
                  setResult({ route: r.route });
                  setFiles([]);
                })
                .catch((e: unknown) => setError({ message: errorMessage(e), blocked: e instanceof ContactBlocked }))
                .finally(() => setBusy(false));
            }}
          />
        </Stack>
      ) : null}
      {progress && !result ? (
        <Progress
          fraction={progress.total ? progress.bytes / progress.total : 0}
          label={progress.phase === "connecting" ? "Connecting directly…" : progress.route === "live" ? "Sending directly" : "Encrypting and uploading to their inbox"}
        />
      ) : null}
      {notes.map((n, i) => (
        <Notice key={i}>{n}</Notice>
      ))}
      {error ? <Notice tone="danger">{error.message}</Notice> : null}
      {result ? (
        <Stack>
          <Notice tone="ok">
            {result.route === "live" ? `Delivered directly to ${contact.displayName}'s device.` : `Delivered to ${contact.displayName}'s inbox. Their devices are notified; it stays for up to 30 days.`}
          </Notice>
          <Row>
            <Button title="Send more" onPress={() => setResult(null)} />
            <Button title="Contacts" tone="ghost" onPress={() => router.back()} />
          </Row>
        </Stack>
      ) : null}
    </Screen>
  );
}
