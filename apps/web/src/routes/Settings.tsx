/** Settings, the security explainer (spec §11–12), and the transfer report form (ADR-0015). */
import { RelayError, fromB64url, sha256, toB64url } from "@sealed/core";
import { useState } from "react";
import { Link } from "react-router";
import { Notice, PageTitle, errorMessage } from "../components/ui";
import { buf } from "../lib/bytes";
import { env, validateRelayUrl } from "../lib/config";
import { disablePush, enablePush, pushSupported } from "../lib/push";
import { session, useSession } from "../lib/session";
import { describeWebAuthnError, registerPasskey, webauthnSupported } from "../lib/webauthn";

export function SettingsPage() {
  const s = useSession();
  const [label, setLabel] = useState(s.profile.label);
  const [relay, setRelay] = useState(s.settings.relayUrl ?? "");
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMsg(null);
    fn()
      .then((text) => setMsg({ tone: "ok", text }))
      .catch((e: unknown) => setMsg({ tone: "danger", text: key === "passkey" ? describeWebAuthnError(e) : errorMessage(e) }))
      .finally(() => setBusy(null));
  };

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Settings">This device</PageTitle>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run("label", async () => {
            await session.setLabel(label);
            return "Saved. New shares and claims use this name; your identity's device list keeps the name it was added with.";
          });
        }}
      >
        <label className="field">
          Device name
          <span className="hint">Shown to senders when you scan their code, and on your shares.</span>
          <input type="text" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <button type="submit" className="btn" disabled={busy !== null || !label.trim()}>
          Save name
        </button>
      </form>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run("relay", async () => {
            const url = relay.trim() ? validateRelayUrl(relay) : undefined;
            if (url) {
              const res = await fetch(`${url}/v1/health`).catch(() => null);
              if (!res?.ok) throw new Error("That relay did not answer its health check.");
            }
            await session.setRelayUrl(url);
            return url ? `Using relay ${url}.` : `Using the default relay ${env.relayUrl}.`;
          });
        }}
      >
        <label className="field">
          Relay
          <span className="hint">Default: {env.relayUrl}. Use a self-hosted relay only if your organization runs one; your identity lives on the relay where it was created.</span>
          <input type="url" value={relay} placeholder={env.relayUrl} onChange={(e) => setRelay(e.target.value)} />
        </label>
        <div className="row">
          <button type="submit" className="btn" disabled={busy !== null}>
            Save relay
          </button>
          <span className="subtle mono">now: {s.relayUrl}</span>
        </div>
      </form>

      {s.profile.fingerprint && (
        <section className="stack">
          <h2>Approvals</h2>
          <p className="muted">{s.profile.passkeyRegistered ? "A passkey is registered. You can add another, for example a security key." : "No passkey yet. You need one to approve shares from this browser."}</p>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || !webauthnSupported()}
            onClick={() =>
              run("passkey", async () => {
                await registerPasskey(s.client);
                await session.updateProfile({ passkeyRegistered: true });
                return "Passkey added.";
              })
            }
          >
            Add a passkey
          </button>
        </section>
      )}

      {s.profile.fingerprint && pushSupported() && (
        <section className="stack">
          <h2>Notifications</h2>
          <p className="muted">Get notified when a contact sends you files while Sealed is closed. The notification contains no file names or sender.</p>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              run("push", async () => {
                if (s.settings.pushEnabled) {
                  await disablePush();
                  return "Notifications turned off.";
                }
                await enablePush();
                return "Notifications turned on.";
              })
            }
          >
            {s.settings.pushEnabled ? "Turn off notifications" : "Turn on notifications"}
          </button>
        </section>
      )}

      <section className="stack">
        <h2>Trusted Sealed clients</h2>
        <p className="muted">
          Codes made by this site are always accepted{s.settings.trustedCodeOrigins?.length ? ", and so are codes from the addresses below" : ""}. Add another by scanning a code it made.
        </p>
        {(s.settings.trustedCodeOrigins ?? []).length > 0 && (
          <ul className="list" aria-label="Trusted origins">
            {(s.settings.trustedCodeOrigins ?? []).map((o) => (
              <li key={o}>
                <span className="grow mono">{o}</span>
                <button type="button" className="btn small ghost" aria-label={`Stop trusting ${o}`} onClick={() => void session.untrustOrigin(o)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav className="row">
        {s.profile.fingerprint && (
          <Link to="/devices" className="btn ghost">
            Devices and paper keys
          </Link>
        )}
        <Link to="/security" className="btn ghost">
          What the relay can see
        </Link>
      </nav>

      <section className="stack">
        <h2>Report a transfer</h2>
        <p className="muted">If someone sent you something harmful, report the transfer. Sealed acts on the sender's account; it cannot read the files.</p>
        <ReportForm />
      </section>
    </div>
  );
}

/**
 * Report form (spec §9.2 /v1/reports, ADR-0015). From a claim page it authenticates with the claim token;
 * otherwise with this device's signature (paired deliveries). Evidence is an optional SHA-256 of a received
 * file, computed locally; the file itself never leaves the device.
 */
export function ReportForm({ transferId, claimToken }: { transferId?: string; claimToken?: string }) {
  const s = useSession();
  const [id, setId] = useState(transferId ?? "");
  const [reason, setReason] = useState<"malware" | "harassment" | "illegal" | "spam" | "other">("malware");
  const [details, setDetails] = useState("");
  const [evidence, setEvidence] = useState<string | null>(null);
  const [state, setState] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const canSign = Boolean(s.profile.fingerprint);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setState(null);
        void (async () => {
          try {
            const raw = id.trim();
            const match = raw.match(/\/c\/([A-Za-z0-9_-]{22})/);
            const tid = match ? match[1]! : raw;
            if (fromB64url(tid).length !== 16) throw new Error("Enter the transfer id or the share link.");
            await s.client.report({ transfer_id: tid, reason, ...(details.trim() ? { details: details.trim().slice(0, 2000) } : {}), ...(evidence ? { evidence_sha256: evidence } : {}) }, claimToken);
            setState({ tone: "ok", text: "Report sent. Thank you." });
          } catch (err) {
            setState({ tone: "danger", text: err instanceof RelayError && err.status === 401 ? "This browser cannot report that transfer (it did not receive it)." : errorMessage(err) });
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      {!transferId && (
        <label className="field">
          Transfer id or share link
          <input type="text" value={id} onChange={(e) => setId(e.target.value)} className="mono" />
        </label>
      )}
      <label className="field">
        Reason
        <select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
          <option value="malware">Malware</option>
          <option value="harassment">Harassment</option>
          <option value="illegal">Illegal content</option>
          <option value="spam">Spam</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label className="field">
        Details (optional)
        <textarea value={details} maxLength={2000} onChange={(e) => setDetails(e.target.value)} />
      </label>
      <label className="field">
        Attach a file's fingerprint (optional)
        <span className="hint">Choose the received file; only its SHA-256 is sent.</span>
        <input
          type="file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return setEvidence(null);
            void f.arrayBuffer().then((b) => setEvidence(toB64url(sha256(buf(new Uint8Array(b))))));
          }}
        />
      </label>
      {!claimToken && !canSign && <p className="subtle">Reports from this page need a set-up device. To report a code you scanned, use the report link on the receive screen.</p>}
      {state && <Notice tone={state.tone}>{state.text}</Notice>}
      <button type="submit" className="btn danger" disabled={busy || (!claimToken && !canSign) || !id.trim()}>
        {busy ? "Sending…" : "Send report"}
      </button>
    </form>
  );
}

export function SecurityPage() {
  return (
    <article className="stack-lg">
      <PageTitle eyebrow="Security">What the relay can and cannot see</PageTitle>
      <p className="muted">
        Files are encrypted on the sending device before anything is uploaded. The relay stores and forwards ciphertext; it never holds a key that opens your files, and it cannot add itself as a recipient
        without the check codes on both screens disagreeing.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <caption className="visually-hidden">Data the relay sees</caption>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "8px 0", borderBottom: "1px solid var(--line)" }}>Data</th>
            <th style={{ textAlign: "left", padding: "8px 0", borderBottom: "1px solid var(--line)" }}>Relay sees</th>
            <th style={{ textAlign: "left", padding: "8px 0", borderBottom: "1px solid var(--line)" }}>Kept for</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["File contents, names, types, counts", "No", "—"],
            ["Ciphertext size", "Rounded up to a size bucket", "Until the transfer expires"],
            ["Sender account", "Yes", "Account lifetime"],
            ["Receiver (Direct and Room)", "Device public key hash and the device name you typed", "Until the transfer expires"],
            ["Who sends to whom (Paired)", "Delivery events between identity fingerprints", "Mailbox lifetime; only aggregates after"],
            ["IP addresses", "Hashed with a key that rotates daily", "7 days unless tied to an abuse report"],
            ["Timestamps", "Rounded to the hour in logs", "90 days"],
            ["Your contact list", "No — it stays on your devices", "—"],
          ].map(([a, b, c]) => (
            <tr key={a}>
              <td style={{ padding: "10px 12px 10px 0", borderBottom: "1px solid var(--line)", verticalAlign: "top" }}>{a}</td>
              <td style={{ padding: "10px 12px 10px 0", borderBottom: "1px solid var(--line)", verticalAlign: "top" }} className="muted">
                {b}
              </td>
              <td style={{ padding: "10px 0", borderBottom: "1px solid var(--line)", verticalAlign: "top" }} className="subtle">
                {c}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="stack">
        <h2>On this browser</h2>
        <ul className="muted">
          <li>Device keys are WebCrypto keys that page scripts cannot export. They are labeled "browser key" to the people you share with, because a browser cannot keep them in secure hardware.</li>
          <li>Approving a share always asks for your passkey, so someone using this unlocked browser still cannot approve without you.</li>
          <li>Clearing this site's data deletes the device keys. Keep a paper key or another device to recover your identity.</li>
          <li>Received files are held in this browser's private storage only until you save them or leave the page. Saved copies are ordinary files Sealed cannot recall.</li>
          <li>Contacts are stored in this browser, not on the relay.</li>
        </ul>
      </section>
      <section className="stack">
        <h2>Offline modes</h2>
        <p className="muted">
          Secure offline streams are encrypted to the receiving device's key, scanned from its screen, so filming the stream reveals nothing. Broadcasts are open by design: anyone in view can decode them.
          A signature tells you who published a broadcast only if you have paired with them.
        </p>
      </section>
      <Link to="/settings" className="btn ghost">
        Back to settings
      </Link>
    </article>
  );
}
