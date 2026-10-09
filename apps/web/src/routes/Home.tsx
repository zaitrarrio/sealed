import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router";
import { PageTitle } from "../components/ui";
import { listContacts } from "../lib/contacts-store";
import { useInbox } from "../lib/inbox";
import { useSession } from "../lib/session";

export function HomePage() {
  const s = useSession();
  const inbox = useInbox();
  const [contacts, setContacts] = useState<number | null>(null);

  useEffect(() => {
    void listContacts().then((c) => setContacts(c.length));
  }, []);

  if (!s.profile.fingerprint) return <Navigate to="/welcome" replace />;
  const devices = s.chain ? [...s.chain.devices.values()].filter((d) => d.revokedSeq === undefined).length : 0;

  return (
    <div className="stack-lg">
      <PageTitle eyebrow={s.profile.label}>Show a code. Hand over a file.</PageTitle>
      {!s.active && (
        <div className="notice danger" role="alert">
          This browser is no longer an active device of your identity (it may have been revoked). Sharing is disabled. You can still receive.
        </div>
      )}
      <div className="grid-2">
        <Link to="/share" className="action-tile primary" data-testid="action-share">
          <span className="title">Share</span>
          <span className="desc">Show a code; the person in front of you scans it. Turn on "Let a room join" for a whole room.</span>
        </Link>
        <Link to="/offline" className="action-tile" data-testid="action-offline">
          <span className="title">Share offline</span>
          <span className="desc">Stream files through the screen to a camera. No network needed on either side.</span>
        </Link>
      </div>
      <Link to="/receive" className="btn block" data-testid="action-receive">
        Receive — scan a code
      </Link>
      <nav className="link-tiles" aria-label="More">
        <Link to="/contacts" className="link-tile">
          <strong>Contacts</strong>
          <span className="count">{contacts === null ? "…" : `${contacts} paired`}</span>
        </Link>
        <Link to="/inbox" className="link-tile">
          <strong>Inbox</strong>
          <span className="count">{inbox.items.length + inbox.live.length} waiting</span>
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
