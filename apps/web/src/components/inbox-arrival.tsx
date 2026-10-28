/** Banner for a delivery that arrived while this browser was open. The inbox screen opens it. */
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { getContact } from "../lib/contacts-store";
import { dismissArrival, useInbox } from "../lib/inbox";
import { useSession } from "../lib/session";

export function InboxArrivalBanner() {
  const inbox = useInbox();
  const s = useSession();
  const location = useLocation();
  const arrival = inbox.arrivals[0];
  const [label, setLabel] = useState("Someone");

  useEffect(() => {
    if (!arrival) return;
    if (s.profile.fingerprint && arrival.senderFp === s.profile.fingerprint) {
      setLabel("you, from another device");
      return;
    }
    let cancel = false;
    void getContact(arrival.senderFp).then((c) => {
      if (!cancel) setLabel(c?.displayName ?? "someone you paired with");
    });
    return () => {
      cancel = true;
    };
  }, [arrival, s.profile.fingerprint]);

  if (!arrival || location.pathname === "/inbox") return null;
  const extra = inbox.arrivals.length > 1 ? ` · ${inbox.arrivals.length} new` : "";

  return (
    <div className="arrival" role="status" data-testid="inbox-arrival">
      <div className="grow">
        <strong>From {label}</strong>
        <div className="subtle">In your inbox{extra}</div>
      </div>
      <Link to="/inbox" className="btn small primary">
        Open
      </Link>
      <button type="button" className="btn small ghost" onClick={() => dismissArrival(arrival.id)}>
        Dismiss
      </button>
    </div>
  );
}
