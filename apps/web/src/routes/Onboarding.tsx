/**
 * Onboarding (spec §6.3, ADR-0005/0006): create an identity on this browser, join an existing identity as an
 * added device, or restore with a paper key. Then register a passkey (approvals need user verification on the
 * web), optionally create a paper key, and upload prekeys.
 */
import { addDeviceCheckCode, activeDevices, compress, ctEqual, parseCode, toB64url, type ChainState } from "@sealed/core";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { QrCode } from "../components/QrCode";
import { Scanner } from "../components/Scanner";
import { CheckCode, Notice, PageTitle, Spinner, errorMessage } from "../components/ui";
import { PaperKeyCard } from "../components/PaperKeyCard";
import { acceptedOrigins, codeOrigin } from "../lib/config";
import { createNewIdentity, joinScannedIdentity, makeAddDeviceOffer, previewPaperKeyChain, restoreWithPaperKey } from "../lib/identity";
import { expectCode, friendlyCodeError } from "../lib/routing";
import { session, useSession } from "../lib/session";
import { describeWebAuthnError, registerPasskey, webauthnSupported } from "../lib/webauthn";

type Step = { name: "choose" | "create" | "join" | "restore" | "passkey" | "paper" | "finish" };

export function OnboardingPage() {
  const s = useSession();
  const [step, setStep] = useState<Step>(() => (s.profile.fingerprint ? { name: s.profile.passkeyRegistered ? "finish" : "passkey" } : { name: "choose" }));
  const [label, setLabel] = useState(s.profile.label);

  const saveLabel = async () => {
    await session.setLabel(label);
  };

  return (
    <div className="main narrow" style={{ padding: 0 }}>
      {step.name === "choose" && (
        <div className="stack-lg">
          <PageTitle eyebrow="Welcome">Set up Sealed on this browser</PageTitle>
          <p className="muted">
            Sealed keeps a key pair for this browser. Its private half cannot be read out by any page script, and it never leaves this browser. To share, this browser joins an identity: a signed list of
            your devices that your contacts verify in person.
          </p>
          <label className="field">
            Name for this device
            <span className="hint">Shown to people you share with and in your device list.</span>
            <input type="text" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} data-testid="device-label" />
          </label>
          <div className="stack">
            <button
              type="button"
              className="btn primary block"
              data-testid="create-identity"
              disabled={!label.trim()}
              onClick={() => void saveLabel().then(() => setStep({ name: "create" }))}
            >
              Create my identity
            </button>
            <button type="button" className="btn block" disabled={!label.trim()} onClick={() => void saveLabel().then(() => setStep({ name: "join" }))}>
              Add this browser to my identity
            </button>
            <button type="button" className="btn ghost block" disabled={!label.trim()} onClick={() => void saveLabel().then(() => setStep({ name: "restore" }))}>
              Restore with a paper key
            </button>
          </div>
          <p className="subtle">
            Only receiving? You do not need to set anything up. <Link to="/receive">Scan a code</Link>.
          </p>
        </div>
      )}
      {step.name === "create" && <CreateStep onDone={() => setStep({ name: "passkey" })} onBack={() => setStep({ name: "choose" })} />}
      {step.name === "join" && <JoinStep onDone={() => setStep({ name: "passkey" })} onBack={() => setStep({ name: "choose" })} />}
      {step.name === "restore" && <RestoreStep onDone={() => setStep({ name: "passkey" })} onBack={() => setStep({ name: "choose" })} />}
      {step.name === "passkey" && <PasskeyStep onDone={() => setStep({ name: s.profile.paperKeyCreatedAt ? "finish" : "paper" })} />}
      {step.name === "paper" && <PaperStep onDone={() => setStep({ name: "finish" })} />}
      {step.name === "finish" && <FinishStep />}
    </div>
  );
}

function CreateStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const s = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Step 1 of 3">Create your identity</PageTitle>
      <p className="muted">
        This browser, <strong>{s.profile.label}</strong>, becomes the first device of a new identity. Its fingerprint is what your contacts pin when you pair.
      </p>
      <Notice>
        Web keys are labeled "browser key" to the people you share with. Clearing this site's data deletes them; keep a paper key or a second device so you can recover.
      </Notice>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="row">
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          data-testid="confirm-create"
          onClick={() => {
            setBusy(true);
            setError(null);
            createNewIdentity(s.profile.label)
              .then(onDone)
              .catch((e: unknown) => setError(`Could not create the identity: ${errorMessage(e)}`))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Creating…" : "Create identity"}
        </button>
        <button type="button" className="btn ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
      </div>
    </div>
  );
}

function JoinStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const s = useSession();
  const [offer, setOffer] = useState<{ code: string; sas: string } | null>(null);
  const [phase, setPhase] = useState<"show" | "scan">("show");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void makeAddDeviceOffer(codeOrigin(), s.profile.label)
      .then((o) => {
        if (cancelled) return;
        const parsed = parseCode(o.code);
        if (parsed.kind !== "add-device") throw new Error("unexpected code");
        setOffer({ code: o.code, sas: addDeviceCheckCode(parsed) });
      })
      .catch((e: unknown) => setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [s.profile.label]);

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Step 1 of 3">Add this browser to your identity</PageTitle>
      {error && <Notice tone="danger">{error}</Notice>}
      {phase === "show" && (
        <div className="stack-lg">
          <p className="muted">On a device that already has Sealed, open Devices, choose "Add a device" and scan this code. Both screens will show the same check code.</p>
          {offer ? (
            <div className="stack" style={{ alignItems: "center", display: "flex", flexDirection: "column" }}>
              <QrCode text={offer.code} label="New-device code" testId="add-device-code" />
              <CheckCode value={offer.sas} testId="add-device-sas" />
            </div>
          ) : (
            <Spinner label="Preparing code…" />
          )}
          <div className="row">
            <button type="button" className="btn primary" onClick={() => setPhase("scan")} disabled={!offer} data-testid="join-approved">
              I approved it on my other device
            </button>
            <button type="button" className="btn ghost" onClick={onBack}>
              Back
            </button>
          </div>
        </div>
      )}
      {phase === "scan" && (
        <div className="stack">
          <p className="muted">Now show your pairing code on the other device (Devices → "Show my pairing code") and scan it here.</p>
          <Scanner
            label="Scan the other device's pairing code"
            onCode={async (text) => {
              let code;
              try {
                code = expectCode(text, "pair", acceptedOrigins());
              } catch (e) {
                return friendlyCodeError(e);
              }
              try {
                await joinScannedIdentity(code);
                onDone();
                return null;
              } catch (e) {
                return errorMessage(e);
              }
            }}
          />
          <button type="button" className="btn ghost" onClick={() => setPhase("show")}>
            Show my code again
          </button>
        </div>
      )}
    </div>
  );
}

function RestoreStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const s = useSession();
  const [text, setText] = useState("");
  const [chain, setChain] = useState<ChainState | null>(null);
  const [revoke, setRevoke] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Recovery">Restore with a paper key</PageTitle>
      <p className="muted">Type the paper key exactly as printed. It adds this browser to your identity and can revoke devices you no longer have.</p>
      <label className="field">
        Paper key
        <textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      {!chain && (
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={busy || text.trim().length < 20}
            onClick={() => {
              setBusy(true);
              setError(null);
              previewPaperKeyChain(text)
                .then((c) => {
                  setChain(c);
                  setRevoke(new Set());
                })
                .catch((e: unknown) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            Check paper key
          </button>
          <button type="button" className="btn ghost" onClick={onBack}>
            Back
          </button>
        </div>
      )}
      {chain && (
        <fieldset className="stack">
          <legend>Devices on this identity — select the ones you lost</legend>
          {activeDevices(chain).map((d) => {
            const id = toB64url(compress(d.signingPublicKey));
            return (
              <label key={id} className="toggle">
                <input
                  type="checkbox"
                  checked={revoke.has(id)}
                  onChange={(e) => {
                    const next = new Set(revoke);
                    if (e.target.checked) next.add(id);
                    else next.delete(id);
                    setRevoke(next);
                  }}
                />
                <span>
                  {d.label} <span className="subtle">({d.protection})</span>
                </span>
              </label>
            );
          })}
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              restoreWithPaperKey(text, s.profile.label, (state) =>
                activeDevices(state)
                  .filter((d) => revoke.has(toB64url(compress(d.signingPublicKey))) && !ctEqual(compress(d.signingPublicKey), compress(s.keys!.signing.publicKey)))
                  .map((d) => d.signingPublicKey),
              )
                .then(onDone)
                .catch((e: unknown) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Restoring…" : revoke.size ? `Restore and revoke ${revoke.size}` : "Restore"}
          </button>
        </fieldset>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

function PasskeyStep({ onDone }: { onDone: () => void }) {
  const s = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Step 2 of 3">Add a passkey</PageTitle>
      <p className="muted">
        Each time someone scans your code, you approve with this passkey (fingerprint, face or device PIN). A browser key alone cannot prove you are present, so Sealed asks the relay to require a passkey for
        every approval.
      </p>
      {!webauthnSupported() && <Notice tone="danger">This browser does not support passkeys, so it cannot approve shares. You can still receive and use Share offline.</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="row">
        <button
          type="button"
          className="btn primary"
          data-testid="register-passkey"
          disabled={busy || !webauthnSupported()}
          onClick={() => {
            setBusy(true);
            setError(null);
            registerPasskey(s.client)
              .then(() => session.updateProfile({ passkeyRegistered: true }))
              .then(() => session.maintainPrekeys())
              .then(onDone)
              .catch((e: unknown) => setError(describeWebAuthnError(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Waiting for passkey…" : "Create passkey"}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy}
          onClick={() => {
            void session
              .maintainPrekeys()
              .catch(() => undefined)
              .then(onDone);
          }}
        >
          Later
        </button>
      </div>
    </div>
  );
}

function PaperStep({ onDone }: { onDone: () => void }) {
  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Step 3 of 3">Make a paper key</PageTitle>
      <p className="muted">
        If you lose every device, a paper key is the only way back into your identity. Sealed has no password reset and cannot recover it for you. Print it or write it down and keep it somewhere safe.
      </p>
      <PaperKeyCard onDone={onDone} skipLabel="Skip for now" />
    </div>
  );
}

function FinishStep() {
  const navigate = useNavigate();
  const s = useSession();
  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Ready">You are set up</PageTitle>
      <p className="muted">
        <strong>{s.profile.label}</strong> is an active device of your identity.
      </p>
      {!s.profile.passkeyRegistered && <Notice>No passkey yet. You can add one in Settings; it is required to approve shares.</Notice>}
      <button type="button" className="btn primary" onClick={() => navigate("/", { replace: true })} data-testid="finish-onboarding">
        Start sharing
      </button>
    </div>
  );
}
