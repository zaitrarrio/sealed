import { useEffect, useState } from "react";
import { Link } from "react-router";
import { PageTitle } from "../components/ui";
import { listContacts } from "../lib/contacts-store";
import { useInbox } from "../lib/inbox";
import { useSession } from "../lib/session";

/**
 * Home: one Send and one Receive. The file moves by light, with no relay and no code to scan.
 * Scanning a code and the other transports stay behind the secondary disclosure.
 */
export function HomePage() {
  const s = useSession();
  const inbox = useInbox();
  const [contacts, setContacts] = useState<number | null>(null);

  useEffect(() => {
    void listContacts().then((c) => setContacts(c.length));
  }, []);

  const devices = s.chain ? [...s.chain.devices.values()].filter((d) => d.revokedSeq === undefined).length : 0;
  const pending = inbox.items.length + inbox.live.filter((l) => l.status !== "failed").length;

  return (
    <div className="stack-lg">
      <PageTitle eyebrow={s.profile.label || "Sealed"}>Send a file. It shows up in their inbox.</PageTitle>
      <div className="grid-2">
        <Link to="/send" className="action-tile primary" data-testid="action-share">
          <span className="title">Send</span>
          <span className="desc">Drop the files and tap Send. Their camera reads your screen. No server.</span>
        </Link>
        <Link to="/inbox" state={{ listen: true }} className="action-tile" data-testid="action-receive">
          <span className="title">Receive</span>
          <span className="desc">{pending > 0 ? `${pending} already waiting. New files show up here.` : "Tap once and point your camera at their screen."}</span>
        </Link>
      </div>
      <details className="card stack">
        <summary className="subtle">In the room, or with no network</summary>
        <Link to="/share" className="btn ghost block">
          Show a code to scan
        </Link>
        <Link to="/receive" className="btn ghost block">
          Scan a code
        </Link>
        <Link to="/offline" className="btn ghost block" data-testid="action-offline">
          No network — stream through the screen
        </Link>
        <Link to="/pair" className="btn ghost block">
          Pair with someone
        </Link>
      </details>
      <nav className="link-tiles" aria-label="More">
        <Link to="/contacts" className="link-tile">
          <strong>Contacts</strong>
          <span className="count">{contacts === null ? "…" : `${contacts} paired`}</span>
        </Link>
        <Link to="/devices" className="link-tile">
          <strong>Devices</strong>
          <span className="count">{devices} active</span>
        </Link>
        <Link to="/settings" className="link-tile">
          <strong>Settings</strong>
          <span className="count">security</span>
        </Link>
      </nav>
    </div>
  );
}
