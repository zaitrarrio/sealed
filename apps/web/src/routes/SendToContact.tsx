/**
 * Send to a paired contact (spec §3.5, §6.4). Refreshes and verifies the contact's chain first (a fork blocks
 * sending). If a device of the contact is online, the transfer runs live over WebRTC; after 15 s without
 * progress or on failure it switches to stored delivery through the mailbox without user action.
 */
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { FilePicker } from "../components/FilePicker";
import { Notice, PageTitle, Progress, errorMessage } from "../components/ui";
import { getContact, type ContactRecord } from "../lib/contacts-store";
import { toEnvelopeInputs } from "../lib/files";
import { ContactBlocked, sendToPairedContact, type SendProgress } from "../lib/paired";
import { selectionSource, useSelection } from "../lib/selection";
import { useSession } from "../lib/session";

export function SendToContactPage() {
  const s = useSession();
  const { fp = "" } = useParams();
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

  if (!s.profile.fingerprint) return <Navigate to="/welcome" replace />;
  if (contact === null) return <Navigate to="/contacts" replace />;
  if (contact === undefined) return null;

  const online = s.presence?.online.get(fp) ?? 0;

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Send to contact">To {contact.displayName}</PageTitle>
      {contact.blocked && <Notice tone="danger">{contact.blocked.reason}</Notice>}
      {!result && <FilePicker files={files} onChange={setFiles} disabled={busy} />}
      {!result && !contact.blocked && (
        <>
          <p className="subtle">
            {online > 0
              ? `${contact.displayName} has a device online — files go directly to it when possible.`
              : `${contact.displayName} is offline — files wait encrypted in their inbox for up to 30 days.`}
          </p>
          <button
            type="button"
            className="btn primary block"
            disabled={busy || files.length === 0 || !s.active}
            data-testid="send-contact"
            onClick={() => {
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
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </>
      )}
      {progress && !result && (
        <Progress
          fraction={progress.total ? progress.bytes / progress.total : 0}
          label={progress.phase === "connecting" ? "Connecting directly…" : progress.route === "live" ? "Sending directly" : "Encrypting and uploading to their inbox"}
        />
      )}
      {notes.map((n, i) => (
        <Notice key={i}>{n}</Notice>
      ))}
      {error && <Notice tone="danger">{error.message}</Notice>}
      {result && (
        <div className="stack" data-testid="send-contact-done">
          <Notice tone="ok">
            {result.route === "live" ? `Delivered directly to ${contact.displayName}'s device.` : `Delivered to ${contact.displayName}'s inbox. Their devices are notified; it stays for up to 30 days.`}
          </Notice>
          <div className="row">
            <button type="button" className="btn" onClick={() => setResult(null)}>
              Send more
            </button>
            <Link to="/contacts" className="btn ghost">
              Contacts
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
