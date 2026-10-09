/** Contacts: pinned identities with presence, notices about device changes, and hard blocks on forks. */
import { activeDevices } from "@sealed/core";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Notice, PageTitle, Spinner, errorMessage } from "../components/ui";
import { cachedChain, listContacts, removeContact, saveContact, type ContactRecord } from "../lib/contacts-store";
import { watchContacts } from "../lib/inbox";
import { ContactBlocked, refreshContact } from "../lib/paired";
import { useSession } from "../lib/session";

export function ContactsPage() {
  const s = useSession();
  const location = useLocation();
  const paired = (location.state as { paired?: string } | null)?.paired;
  const [contacts, setContacts] = useState<ContactRecord[] | null>(null);
  const [online, setOnline] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const list = await listContacts();
    setContacts(list);
    void watchContacts();
    // Refresh chains in the background; forks become persistent blocks.
    for (const c of list) {
      if (c.blocked) continue;
      void refreshContact(c)
        .then(({ record }) => setContacts((prev) => prev?.map((p) => (p.id === record.id ? record : p)) ?? prev))
        .catch(async (e: unknown) => {
          if (e instanceof ContactBlocked) setContacts(await listContacts());
        });
    }
  };

  useEffect(() => {
    void load().catch((e: unknown) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.presence]);

  useEffect(() => {
    if (!s.presence) return;
    const p = s.presence;
    setOnline(new Map(p.online));
    return p.on((f) => {
      if (f.type === "presence") setOnline(new Map(p.online));
    });
  }, [s.presence]);

  if (!s.profile.fingerprint) return <Navigate to="/welcome" replace />;

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Paired">Contacts</PageTitle>
      {paired && <Notice tone="ok">Paired with {paired}.</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <Link to="/pair" className="btn primary" data-testid="pair-new">
        Pair with someone
      </Link>
      {contacts === null ? (
        <Spinner label="Loading contacts…" />
      ) : contacts.length === 0 ? (
        <div className="card sunken">
          <p className="muted" style={{ margin: 0 }}>
            No contacts yet. Pair in person once, then send files to each other from anywhere.
          </p>
        </div>
      ) : (
        <ul className="list" aria-label="Contacts">
          {contacts.map((c) => {
            const chain = cachedChain(c);
            const devices = chain ? activeDevices(chain).length : 0;
            const on = online.get(c.id) ?? 0;
            return (
              <li key={c.id} data-testid="contact-row">
                <div className="grow stack" style={{ gap: 4 }}>
                  <div className="row">
                    <span className={`dot${on > 0 ? " on" : ""}`} aria-hidden="true" />
                    <strong>{c.displayName}</strong>
                    <span className="subtle">
                      {devices} {devices === 1 ? "device" : "devices"}
                      {on > 0 ? ` · ${on} online` : ""}
                    </span>
                  </div>
                  {c.blocked && <span className="badge bad">Blocked: identity changed unexpectedly</span>}
                  {c.notice && (
                    <span className="subtle">
                      {c.notice}{" "}
                      <button
                        type="button"
                        className="btn small ghost"
                        onClick={() => {
                          const { notice: _n, ...rest } = c;
                          void saveContact(rest).then(load);
                        }}
                      >
                        Dismiss
                      </button>
                    </span>
                  )}
                  <span className="subtle mono">{c.id.slice(0, 16)}</span>
                </div>
                <div className="row">
                  {c.blocked ? (
                    <span className="subtle">Pair again in person to unblock.</span>
                  ) : (
                    <Link to={`/contacts/${c.id}/send`} className="btn small primary" data-testid="send-to-contact">
                      Send files
                    </Link>
                  )}
                  <button
                    type="button"
                    className="btn small ghost"
                    onClick={() => {
                      if (window.confirm(`Remove ${c.displayName}? You will need to pair in person again to send to each other.`)) void removeContact(c.id).then(load);
                    }}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
