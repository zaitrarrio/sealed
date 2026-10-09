/**
 * Devices (spec §6.3.4–6.3.5): this identity's verified device list, adding a device (scan its new-device code,
 * compare the check code, append add_device, then show this device's pairing code for it to join), revoking
 * devices, and paper keys.
 */
import { activeDevices, addDeviceCheckCode, compress, createPairingOffer, ctEqual, toB64url, type ParsedCode } from "@sealed/core";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { PaperKeyCard } from "../components/PaperKeyCard";
import { QrCode } from "../components/QrCode";
import { Scanner } from "../components/Scanner";
import { CheckCode, Notice, PageTitle, ProtectionBadge, Spinner, errorMessage } from "../components/ui";
import { acceptedOrigins, codeOrigin } from "../lib/config";
import { approveScannedDevice, revokeOwnDevice } from "../lib/identity";
import { codeFromLocation, expectCode, friendlyCodeError } from "../lib/routing";
import { session, useSession } from "../lib/session";

export function DevicesPage() {
  const s = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [paper, setPaper] = useState(false);
  const [poolCount, setPoolCount] = useState<number | null>(null);

  useEffect(() => {
    if (!s.profile.fingerprint) return;
    void session.refreshOwnChain().catch((e: unknown) => setError(errorMessage(e)));
    if (s.active) void session.prekeyCount().then(setPoolCount, () => undefined);
  }, [s.profile.fingerprint, s.active]);

  if (!s.profile.fingerprint) return <Navigate to="/welcome" replace />;
  if (!s.chain || !s.keys) return <Spinner label="Loading devices…" />;

  const mine = compress(s.keys.signing.publicKey);
  const devices = [...s.chain.devices.values()].sort((a, b) => a.addedSeq - b.addedSeq);
  const paperKeys = [...s.chain.paperKeys.values()];

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Identity">Devices</PageTitle>
      <p className="muted">
        Your identity is the signed list below. Contacts verify every change against what they pinned when you paired. Fingerprint <span className="mono">{s.profile.fingerprint.slice(0, 16)}</span>.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      <ul className="list" aria-label="Devices">
        {devices.map((d) => {
          const id = toB64url(compress(d.signingPublicKey));
          const self = ctEqual(compress(d.signingPublicKey), mine);
          const revoked = d.revokedSeq !== undefined;
          return (
            <li key={id} data-testid="device-row">
              <div className="grow stack" style={{ gap: 4 }}>
                <div className="row">
                  <strong style={revoked ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>{d.label}</strong>
                  {self && <span className="badge">this browser</span>}
                  <ProtectionBadge protection={d.protection} />
                  {revoked && <span className="badge bad">revoked</span>}
                </div>
                {self && poolCount !== null && <span className="subtle">{poolCount} one-time prekeys on the relay</span>}
              </div>
              {!revoked && !self && (
                <button
                  type="button"
                  className="btn small danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!window.confirm(`Revoke ${d.label}? It will stop receiving files immediately. Files already on it stay there.`)) return;
                    setBusy(id);
                    setError(null);
                    revokeOwnDevice(d.signingPublicKey, "revoked by owner")
                      .catch((e: unknown) => setError(errorMessage(e)))
                      .finally(() => setBusy(null));
                  }}
                >
                  {busy === id ? "Revoking…" : "Revoke"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="row">
        <Link to="/devices/add" className="btn primary" data-testid="add-device">
          Add a device
        </Link>
        <Link to="/pair" className="btn ghost">
          Show my pairing code
        </Link>
      </div>
      <section className="stack">
        <h2>Paper keys</h2>
        <p className="muted">{paperKeys.filter((p) => !p.revoked).length === 0 ? "No paper key. Without one, losing every device means losing this identity." : `${paperKeys.filter((p) => !p.revoked).length} active paper key(s).`}</p>
        {paper ? <PaperKeyCard onDone={() => setPaper(false)} skipLabel="Cancel" /> : (
          <button type="button" className="btn" onClick={() => setPaper(true)}>
            Create a paper key
          </button>
        )}
      </section>
    </div>
  );
}

/**
 * Existing-device side of adding a device: scan the new device's code (or arrive via /d#code from a camera),
 * show the check code, append the link, then show this device's pairing code so the new device can join.
 */
export function AddDevicePage() {
  const s = useSession();
  const location = useLocation();
  const [code, setCode] = useState<Extract<ParsedCode, { kind: "add-device" }> | null>(null);
  const [phase, setPhase] = useState<"scan" | "confirm" | "added">("scan");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const landing = useMemo(() => codeFromLocation(window.location.origin, location.pathname, location.hash), [location.pathname, location.hash]);
  useEffect(() => {
    if (!landing) return;
    try {
      setCode(expectCode(landing, "add-device", acceptedOrigins()));
      setPhase("confirm");
      window.history.replaceState(window.history.state, "", location.pathname);
    } catch (e) {
      setError(friendlyCodeError(e));
    }
  }, [landing, location.pathname]);

  const pairing = useMemo(() => (phase === "added" && s.chain ? createPairingOffer(codeOrigin(), s.chain, s.profile.label) : null), [phase, s.chain, s.profile.label]);

  if (!s.profile.fingerprint) {
    return (
      <div className="stack-lg">
        <PageTitle eyebrow="Add a device">This browser has no identity yet</PageTitle>
        <p className="muted">That code adds a new device to an identity. Open it on a device that already uses Sealed.</p>
        <Link to="/welcome" className="btn">
          Set up this browser
        </Link>
      </div>
    );
  }
  if (!s.chain) return <Spinner label="Loading your identity…" />;
  const alreadyIn = code ? activeDevices(s.chain).some((d) => ctEqual(compress(d.signingPublicKey), compress(code.signingPublicKey))) : false;

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Devices">Add a device</PageTitle>
      {error && <Notice tone="danger">{error}</Notice>}
      {phase === "scan" && (
        <div className="stack">
          <p className="muted">On the new device, choose "Add this browser to my identity" (or the app's "Add to my identity"), then scan the code it shows.</p>
          <Scanner
            label="Scan the new device's code"
            onCode={(text) => {
              try {
                setCode(expectCode(text, "add-device", acceptedOrigins()));
                setPhase("confirm");
                return null;
              } catch (e) {
                return friendlyCodeError(e);
              }
            }}
          />
        </div>
      )}
      {phase === "confirm" && code && (
        <div className="stack-lg">
          <div className="card stack">
            <div className="row">
              <strong>{code.label}</strong>
              <ProtectionBadge protection={code.protection} />
            </div>
            <CheckCode value={addDeviceCheckCode(code)} testId="add-device-confirm-sas" />
            <p className="muted">The new device shows a check code. Approve only if the digits match.</p>
          </div>
          {alreadyIn && <Notice>This device is already part of your identity.</Notice>}
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || alreadyIn}
              data-testid="approve-device"
              onClick={() => {
                setBusy(true);
                setError(null);
                approveScannedDevice(code)
                  .then(() => setPhase("added"))
                  .catch((e: unknown) => setError(errorMessage(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Adding…" : "The codes match — add it"}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setCode(null);
                setPhase("scan");
              }}
            >
              They do not match
            </button>
          </div>
        </div>
      )}
      {phase === "added" && pairing && (
        <div className="stack-lg" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <Notice tone="ok">Added {code?.label}. Finish on the new device by scanning this code.</Notice>
          <QrCode text={pairing.code} label="This device's pairing code" testId="join-pairing-code" />
          <details style={{ width: "100%" }}>
            <summary className="subtle">Copy as text</summary>
            <input type="text" readOnly value={pairing.code} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label="Pairing code" data-testid="join-pairing-link" />
          </details>
          <Link to="/devices" className="btn">
            Done
          </Link>
        </div>
      )}
    </div>
  );
}
