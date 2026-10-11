import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router";
import { PageTitle } from "../components/ui";
import { listContacts } from "../lib/contacts-store";
import { useInbox } from "../lib/inbox";
import { useSession } from "../lib/session";

/**
 * Unified home (spec §3.2): two primary actions — Send and Receive. Mode selection (Direct / Room /
 * offline) happens inside Send; jargon stays out of the landing page.
 */
export function HomePage() {
  const s = useSession();
  const inbox = useInbox();
  const [contacts, setContacts] = useState<number | null>(null);

  useEffect(() => {
    void listContacts().then((c) => setContacts(c.length));
  }, []);

  if (!s.profile.fingerprint) return <Navigate to="/welcome" replace />;
  const devices = s.chain ? [...s.chain.devices.values()].filter((d) => d.revokedSeq === undefined).length : 0;
  const pending = inbox.items.length + inbox.live.filter((l) => l.status !== "failed").length;

  return (
    <div className="stack-lg">
      <PageTitle eyebrow={s.profile.label}>Send a file. Receive with a scan.</PageTitle>
      {!s.active && (
        <div className="notice danger" role="alert">
          This browser is no longer an active device of your identity (it may have been revoked). Sending is disabled. You can still receive.
        </div>
      )}
      <div className="grid-2">
        <Link to="/share" className="action-tile primary" data-testid="action-share">
          <span className="title">Send</span>
          <span className="desc">Drop files and show a code. The person next to you scans it — or turn on “Allow multiple people” for a room.</span>
        </Link>
        <Link to="/receive" className="action-tile" data-testid="action-receive">
          <span className="title">Receive</span>
          <span className="desc">Point your camera at a Sealed code, or open a link someone sent you.</span>
        </Link>
      </div>
      <details className="card stack">
        <summary className="subtle">More ways to send</summary>
        <Link to="/offline" className="btn ghost block" data-testid="action-offline">
          No network — stream through the screen
        </Link>
        <Link to="/contacts" className="btn ghost block">
          Send to a paired contact
        </Link>
      </details>
      <nav className="link-tiles" aria-label="More">
        <Link to="/contacts" className="link-tile">
          <strong>Contacts</strong>
          <span className="count">{contacts === null ? "…" : `${contacts} paired`}</span>
        </Link>
        <Link to="/inbox" className="link-tile">
          <strong>Inbox</strong>
          <span className="count">{pending} waiting</span>
        </Link>
        <Link to="/devices" className="link-tile">
          <strong>Devices</strong>
          <span className="count">{devices} active</span>
        </Link>
        <Link to="/settings" className="link-tile">
          <strong>Settings</strong>
          <span className="count">relay, security</span>
        </Link>
      </nav>
    </div>
  );
}
