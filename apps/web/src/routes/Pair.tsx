/**
 * Pairing ceremony (spec §3.5, §6.3.3, ADR-0006). Each side shows its pairing code and scans the other's. The
 * scanned identity's chain is fetched and verified against the fingerprint and head in the code; both screens
 * then show the pairing check code, and each user confirms on their own device before the contact is saved.
 *
 * A phone camera that scans a pairing code opens /p#<code>; that code is pre-loaded as "scanned" and this
 * device's own code is shown for the other side to scan.
 */
import { contactFromPeer, createPairingOffer, ctEqual, pairingCheckCode, verifyScannedPairingCode, type PairingOffer, type ScannedPeer } from "@sealed/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { QrCode } from "../components/QrCode";
import { Scanner } from "../components/Scanner";
import { CheckCode, Notice, PageTitle, Spinner, errorMessage } from "../components/ui";
import { acceptedOrigins, codeOrigin } from "../lib/config";
import { getContact, recordFromContact, saveContact } from "../lib/contacts-store";
import { watchContacts } from "../lib/inbox";
import { codeFromLocation, expectCode, friendlyCodeError } from "../lib/routing";
import { session, useSession } from "../lib/session";

export function PairPage() {
  const s = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [peer, setPeer] = useState<ScannedPeer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [view, setView] = useState<"show" | "scan">("show");

  // Our own code, with a fresh nonce for this ceremony, from the freshly verified chain head. Created once per
  // ceremony: the nonce must not change between showing the code and computing the check code.
  const creatingOffer = useRef(false);
  useEffect(() => {
    if (!s.chain || offer || creatingOffer.current) return;
    creatingOffer.current = true;
    const fallback = s.chain;
    void session
      .refreshOwnChain()
      .catch(() => fallback)
      .then((chain) => setOffer(createPairingOffer(codeOrigin(), chain, s.profile.label)))
      .finally(() => {
        creatingOffer.current = false;
      });
  }, [s.chain, s.profile.label, offer]);

  const accept = async (text: string): Promise<string | null> => {
    let code;
    try {
      code = expectCode(text, "pair", acceptedOrigins());
    } catch (e) {
      return friendlyCodeError(e);
    }
    if (s.chain && ctEqual(code.fingerprint, s.chain.fingerprint)) return "That is your own pairing code. Scan the other person's code.";
    setChecking(true);
    try {
      const p = await verifyScannedPairingCode(s.client, code);
      setPeer(p);
      setName(p.label);
      return null;
    } catch (e) {
      return `This pairing code could not be verified: ${errorMessage(e)}`;
    } finally {
      setChecking(false);
    }
  };

  // Opened directly from a camera app: /p#<code>.
  const landing = useMemo(() => codeFromLocation(window.location.origin, location.pathname, location.hash), [location.pathname, location.hash]);
  useEffect(() => {
    if (!landing || !s.chain || peer) return;
    window.history.replaceState(window.history.state, "", location.pathname);
    void accept(landing).then((err) => err && setError(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing, s.chain]);

  if (!s.profile.fingerprint) return <Navigate to="/welcome" replace />;
  if (!s.chain) return <Spinner label="Loading your identity…" />;

  const sas = offer && peer ? pairingCheckCode(offer.nonce, s.chain, peer) : null;

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Pair">Pair with someone in person</PageTitle>
      <p className="muted">
        Show each other your codes and scan them. After pairing you can send files to each other from anywhere. Pairing only works face to face: that is what makes it trustworthy.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      {!peer && (
        <div className="stack">
          <div className="radio-row" role="tablist" aria-label="Pairing step">
            <button type="button" role="tab" aria-selected={view === "show"} className={`btn small${view === "show" ? " primary" : ""}`} onClick={() => setView("show")}>
              My code
            </button>
            <button type="button" role="tab" aria-selected={view === "scan"} className={`btn small${view === "scan" ? " primary" : ""}`} onClick={() => setView("scan")} data-testid="pair-scan-tab">
              Scan theirs
            </button>
          </div>
          {view === "show" &&
            (offer ? (
              <div className="stack" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <QrCode text={offer.code} label="Your pairing code" testId="pairing-code" />
                <p className="subtle">Let them scan this, then scan theirs.</p>
                <details style={{ width: "100%" }}>
                  <summary className="subtle">Copy as text</summary>
                  <input type="text" readOnly value={offer.code} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label="Pairing code" data-testid="pairing-link" />
                </details>
              </div>
            ) : (
              <Spinner label="Preparing your code…" />
            ))}
          {view === "scan" && <Scanner label="Scan their pairing code" onCode={accept} />}
          {checking && <Spinner label="Verifying their identity…" />}
        </div>
      )}
      {peer && sas && offer && (
        <div className="stack-lg">
          <div className="card stack">
            <p>
              Verified <strong>{peer.label}</strong>'s identity ({[...peer.chain.devices.values()].filter((d) => d.revokedSeq === undefined).length} active devices).
            </p>
            <CheckCode value={sas} label="Pairing check code" testId="pair-sas" />
            <p className="muted">Compare with their screen. Both of you must see the same six digits. If they differ, stop: someone is in the middle.</p>
            <p className="muted">Make sure they have scanned your code too, so they can confirm on their side.</p>
            <details>
              <summary className="subtle">Show my code again</summary>
              <div style={{ marginTop: 12 }}>
                <QrCode text={offer.code} label="Your pairing code" small />
              </div>
            </details>
          </div>
          <label className="field">
            Save as
            <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="contact-name" />
          </label>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={saving || !name.trim()}
              data-testid="confirm-pair"
              onClick={() => {
                setSaving(true);
                setError(null);
                void (async () => {
                  try {
                    const contact = contactFromPeer(peer, name.trim());
                    // Cache exactly the links that were verified against the scanned code, not a second fetch.
                    const links = peer.links;
                    const existing = await getContact(recordFromContact(contact, links).id);
                    await saveContact({ ...recordFromContact(contact, links), ...(existing ? { pairedAt: existing.pairedAt } : {}) });
                    await watchContacts();
                    navigate("/contacts", { replace: true, state: { paired: name.trim() } });
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setSaving(false);
                  }
                })();
              }}
            >
              The codes match — save contact
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setPeer(null);
                setOffer(null);
              }}
            >
              They do not match
            </button>
          </div>
        </div>
      )}
      <Link to="/contacts" className="btn ghost">
        Back to contacts
      </Link>
    </div>
  );
}
