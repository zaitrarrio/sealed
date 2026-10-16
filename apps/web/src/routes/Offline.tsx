/**
 * Share offline (spec §3.6–3.7, §6.5–6.6). Air-gap (secure): the receiver shows a reverse key code, the sender's
 * camera scans it, both show the Air-gap check code, and the sender's screen streams Facet frames that only the
 * receiver's device key can open. Broadcast (open): the sender loops the stream and anyone in view can decode it.
 */
import { compress, ctEqual, createReverseKeyOffer, describeQrStream, fromB64url, prepareAirgapStream, prepareBroadcastStream, qrStreamSetting, type FacetSender, type QrStreamSetting, type ParsedCode, type Tier } from "@sealed/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { FacetStream } from "../components/FacetStream";
import { FilePicker } from "../components/FilePicker";
import { OpticalCapture, type CaptureResult, type CaptureUpdate } from "../components/OpticalCapture";
import { QrCode } from "../components/QrCode";
import { ReceivedFiles } from "../components/ReceivedFiles";
import { Scanner } from "../components/Scanner";
import { TorchBeacon } from "../components/TorchBeacon";
import { TorchWatcher } from "../components/TorchWatcher";
import { useLiveRate } from "../lib/rate-adapt";
import { useTorchSignal } from "../lib/torch-signal";
import { CheckCode, Notice, PageTitle, Progress, Spinner, Steps, errorMessage } from "../components/ui";
import { formatBytes } from "../lib/bytes";
import { cameraAvailable } from "../lib/camera";
import { acceptedOrigins, codeOrigin } from "../lib/config";
import { kvGet } from "../lib/idb";
import { cachedChain, listContacts } from "../lib/contacts-store";
import { toEnvelopeInputs, totalSize } from "../lib/files";
import { memoryFiles, type ReceivedFile } from "../lib/received";
import { codeFromLocation, expectCode, friendlyCodeError } from "../lib/routing";
import { useSelection } from "../lib/selection";
import { useSession } from "../lib/session";
import type { StoredDeviceKeys } from "../lib/webcrypto-keys";

/** Above this, an optical transfer takes long enough that the UI warns before starting. */
const LARGE_OPTICAL_BYTES = 2 * 1024 * 1024;

/** Streaming time at the saved QR setting, assuming 30 % of codes are missed. */
function etaSeconds(bytes: number, qr: QrStreamSetting): number {
  return Math.ceil(bytes / (qr.symbolSize * qr.codesPerScreen * (60 / qr.holdRefreshes60) * 0.7));
}

function formatDuration(s: number): string {
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

// --------------------------------------------------------------------------------------------- hub

export function OfflineHubPage() {
  const [files] = useSelection();
  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Share offline">Send through the screen</PageTitle>
      <p className="muted">No network is needed on either device. The file streams as colored frames from this screen to the other device's camera.</p>
      {files.length > 0 && (
        <p className="subtle">
          Using your selection: {files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(totalSize(files))}
        </p>
      )}
      <div className="grid-2">
        <Link to="/offline/send" className="action-tile primary" data-testid="airgap-send">
          <span className="title">Secure</span>
          <span className="desc">Scan the receiver's key code first. Only that device can open the stream, even if others film it.</span>
        </Link>
        <Link to="/broadcast" className="action-tile" data-testid="broadcast-send">
          <span className="title">Anyone watching</span>
          <span className="desc">Loop the file for everyone in view. Use only for material meant for all of them.</span>
        </Link>
      </div>
      <div className="row">
        <Link to="/offline/receive" className="btn">
          Receive offline
        </Link>
        <Link to="/bench" className="btn ghost" data-testid="open-bench">
          Benchmark
        </Link>
        <Link to="/broadcast/receive" className="btn ghost">
          Receive a broadcast
        </Link>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- air-gap sender

export function SendOfflinePage() {
  const s = useSession();
  const location = useLocation();
  const [files, setFiles] = useSelection();
  const [rk, setRk] = useState<Extract<ParsedCode, { kind: "reverse-key" }> | null>(null);
  const [prepared, setPrepared] = useState<{ sender: FacetSender; sas: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinnedName, setPinnedName] = useState<string | null>(null);

  const landing = useMemo(() => codeFromLocation(window.location.origin, location.pathname, location.hash), [location.pathname, location.hash]);
  useEffect(() => {
    if (!landing) return;
    try {
      setRk(expectCode(landing, "reverse-key", acceptedOrigins()));
      window.history.replaceState(window.history.state, "", location.pathname);
    } catch (e) {
      setError(friendlyCodeError(e));
    }
  }, [landing, location.pathname]);

  // A receiver whose key belongs to a pinned contact device is named in the UI (it still uses the scanned key).
  useEffect(() => {
    if (!rk) return;
    void (async () => {
      for (const c of await listContacts()) {
        const chain = cachedChain(c);
        if (!chain) continue;
        for (const d of chain.devices.values()) {
          if (d.revokedSeq === undefined && ctEqual(compress(d.agreementPublicKey), compress(rk.receiverPublicKey))) {
            setPinnedName(`${c.displayName} (${d.label})`);
            return;
          }
        }
      }
    })();
  }, [rk]);

  const qrStream = useMemo(() => qrStreamSetting(s.settings.qrStream), [s.settings.qrStream]);
  const onDelivered = useCallback(() => setConfirmed(false), []);
  const live = useLiveRate(prepared?.sender ?? null, qrStream, onDelivered);

  // Turn 2 starts by itself: as soon as there is a key and files, encrypt and start streaming.
  useEffect(() => {
    if (!rk || files.length === 0 || prepared || busy || error) return;
    setBusy(true);
    const signedBy = s.keys && s.active ? s.keys : undefined;
    prepareAirgapStream({ files: toEnvelopeInputs(files), reverseKey: rk, ...(signedBy ? { senderKeys: signedBy } : {}), senderLabel: s.profile.label || "Sealed sender", qr: qrStream })
      .then((p) => {
        setPrepared({ sender: p.sender, sas: p.sas });
        setConfirmed(true);
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  }, [rk, files, prepared, busy, error, s.keys, s.active, s.profile.label, qrStream]);

  const bytes = totalSize(files);

  if (prepared && live.delivered && !confirmed) {
    return (
      <div className="stack-lg" data-testid="airgap-delivered">
        <PageTitle eyebrow="Delivered">Their device has the files</PageTitle>
        <CheckCode value={prepared.sas} label="Safety code — their screen shows the same" testId="airgap-sender-sas" />
        <p className="subtle">Their device signalled that everything arrived. If the safety codes differ, tell them to delete what they received.</p>
        <Link className="btn primary" to="/">
          Done
        </Link>
      </div>
    );
  }

  if (prepared && confirmed) {
    return (
      <div className="stack-lg">
        <Steps current={2} steps={["They show, you film", "Switch: you show, they film"]} />
        <CheckCode value={prepared.sas} label="Safety code — their screen shows the same" testId="airgap-sender-sas" />
        <FacetStream sender={prepared.sender} codesPerScreen={live.rate.codesPerScreen} caption={describeQrStream({ ...qrStream, ...live.rate })} onStop={() => setConfirmed(false)} />
        <TorchWatcher onMessage={live.onMessage} />
        <p className="subtle">
          {live.last && live.last !== "done" ? `Their device asked for ${live.last} · ` : ""}
          This device stops by itself when theirs flashes that the files arrived.
        </p>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Share offline · Secure">Send to one device, through the screen</PageTitle>
      <Steps current={rk ? 2 : 1} steps={["They show, you film", "Switch: you show, they film"]} />
      {error && (
        <div className="stack">
          <Notice tone="danger">{error}</Notice>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setError(null);
              setPrepared(null);
            }}
          >
            Try again
          </button>
        </div>
      )}
      {(files.length === 0 || !rk) && <FilePicker files={files} onChange={setFiles} disabled={busy} />}
      {!rk && (
        <div className="stack">
          <p className="muted">On their device: Sealed → Receive offline. Point your camera at the code it shows; anywhere in view is fine.</p>
          {!cameraAvailable() && <Notice tone="danger">This device has no usable camera, so Secure offline sharing is unavailable. Use "Anyone watching" only for material meant for everyone in view.</Notice>}
          <Scanner
            label="Film their key code"
            onCode={(text) => {
              try {
                setRk(expectCode(text, "reverse-key", acceptedOrigins()));
                setError(null);
                return null;
              } catch (e) {
                return friendlyCodeError(e);
              }
            }}
          />
        </div>
      )}
      {rk && (
        <div className="card stack">
          <strong>Got their key: {pinnedName ?? rk.label}</strong>
          {files.length === 0 && <p className="muted" style={{ margin: 0 }}>Choose the files to send; streaming starts as soon as you do.</p>}
          {bytes > 0 && (
            <p className="subtle" style={{ margin: 0 }}>
              About {formatDuration(etaSeconds(bytes, qrStream))} of streaming at {describeQrStream(qrStream)}
              {bytes > LARGE_OPTICAL_BYTES ? ". That is long for an offline transfer; share online if a network is allowed." : "."}
            </p>
          )}
          {busy && <Spinner label="Encrypting for their device…" />}
          {prepared && !confirmed && (
            <div className="row">
              <CheckCode value={prepared.sas} label="Safety code" />
              <button type="button" className="btn primary" onClick={() => setConfirmed(true)} data-testid="start-stream">
                Stream again
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setPrepared(null);
                  setRk(null);
                }}
              >
                Different receiver
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- air-gap receiver

export function ReceiveOfflinePage() {
  const s = useSession();
  const [offer, setOffer] = useState<{ code: string; nonce: Uint8Array; tier: Tier } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [update, setUpdate] = useState<CaptureUpdate | null>(null);
  const [result, setResult] = useState<{ files: ReceivedFile[]; sender: CaptureResult["sender"] } | null>(null);
  const signal = useTorchSignal();
  const [error, setError] = useState<string | null>(null);
  const [stored, setStored] = useState<StoredDeviceKeys | null>(null);

  useEffect(() => {
    void kvGet<StoredDeviceKeys>("device-keys").then((k) => setStored(k ?? null));
  }, [s.keys]);

  // T0: QR frames, which this browser reads with its QR detector (or its own decoder) and every sender can make.
  // The colour-grid tiers need a faster pixel decoder than the browser has (ADR-0018).
  const makeOffer = () => {
    if (!s.keys) return;
    const tier: Tier = 0;
    const o = createReverseKeyOffer(codeOrigin(), s.keys, s.profile.label || "Sealed receiver", tier);
    setOffer({ ...o, tier });
  };

  // One offer per visit: the nonce shown in the code must be the one kept for the check code.
  const offered = useRef(false);
  useEffect(() => {
    if (!s.keys || offered.current) return;
    offered.current = true;
    makeOffer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.keys]);

  if (result) {
    return (
      <div className="stack-lg" data-testid="airgap-done">
        <PageTitle eyebrow="Received offline">{result.files.length === 1 ? "Your file is here" : `${result.files.length} files are here`}</PageTitle>
        <TorchBeacon on={signal.torch} active={signal.busy} />
        {signal.busy && <p className="subtle">Telling the sender it arrived (torch).</p>}
        {result.sender && <p className="muted">The sender calls themselves “{result.sender.label}”. Sealed cannot confirm that name; the check code is what tells you the stream came from the person in front of you.</p>}
        <ReceivedFiles files={result.files} />
        <Link to="/" className="btn ghost">
          Done
        </Link>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Receive offline">{capturing ? "Film their screen" : "Show this to the sender"}</PageTitle>
      <Steps current={capturing ? 2 : 1} steps={["You show, they film", "Switch: they show, you film"]} />
      {error && <Notice tone="danger">{error}</Notice>}
      {!capturing && (
        <div className="stack-lg" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          {offer ? <QrCode text={offer.code} label="Offline key code" testId="reverse-key-code" /> : <Spinner label="Preparing…" />}
          <p className="muted">They film this with Sealed → Share offline. It carries only this device's public key; nothing secret.</p>
          <button type="button" className="btn primary block" disabled={!offer || !stored} onClick={() => setCapturing(true)} data-testid="start-capture">
            They have it — switch to my camera
          </button>
        </div>
      )}
      {capturing && offer && stored && (
        <div className="stack">
          <OpticalCapture
            init={{ type: "init", mode: "airgap", ...(offer.tier === 0 ? { tiers: [0] } : {}), airgap: { agreementPrivate: stored.agreementPrivate, agreementPublic: stored.agreementPublic, signingPrivate: stored.signingPrivate, signingPublic: stored.signingPublic, nonce: offer.nonce } }}
            torch={signal.torch}
            onProgress={(u) => {
              setUpdate(u);
              signal.report(u.progress);
            }}
            onComplete={(r) => {
              signal.done();
              setResult({
                files: memoryFiles(r.files.map((f) => ({ entry: { path: f.path, size: f.size, mediaType: f.mediaType, sha256: new Uint8Array(32), ...(f.mtime !== undefined ? { mtime: f.mtime } : {}) }, data: f.data }))),
                sender: r.sender,
              });
            }}
            onError={setError}
          />
          <CaptureStatus update={update} />
          {update?.sas && (
            <div className="card stack">
              <CheckCode value={update.sas} label="Check code — must match the sender's screen" testId="airgap-receiver-sas" />
              <p className="subtle">If it does not match, stop: you are not receiving from the person in front of you.</p>
            </div>
          )}
          <button type="button" className="btn ghost" onClick={() => setCapturing(false)}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

function CaptureStatus({ update }: { update: CaptureUpdate | null }) {
  if (!update) return <p className="subtle">Looking for the stream…</p>;
  const p = update.progress;
  return (
    <div className="stack">
      <Progress fraction={p.fraction} label={p.blockCount ? `Block ${Math.min(p.blocksComplete + 1, p.blockCount)} of ${p.blockCount}` : "Coverage"} />
      <p className="subtle mono">
        {p.tier !== null ? `T${p.tier} · ` : ""}
        {p.framesDecoded} frames read of {p.framesSeen} · {update.measurement.captureFps.toFixed(0)} fps
        {p.calibrated ? " · calibrated" : ""}
      </p>
      {update.files && (
        <ul className="list" aria-label="Incoming files">
          {update.files.map((f) => (
            <li key={f.path}>
              <span className="grow truncate">{f.path}</span>
              <span className="subtle mono">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- broadcast

export function BroadcastSendPage() {
  const s = useSession();
  const [files, setFiles] = useSelection();
  const [sign, setSign] = useState(Boolean(s.active));
  const [acknowledged, setAcknowledged] = useState(false);
  const [sender, setSender] = useState<FacetSender | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qrStream = useMemo(() => qrStreamSetting(s.settings.qrStream), [s.settings.qrStream]);

  if (sender) return <FacetStream sender={sender} codesPerScreen={qrStream.codesPerScreen} caption={`broadcast · ${describeQrStream(qrStream)}`} onStop={() => setSender(null)} />;

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Share offline · Anyone watching">Broadcast to everyone in view</PageTitle>
      <div className="card danger stack" role="note">
        <strong>Anyone who can see this screen can receive these files.</strong>
        <p style={{ margin: 0 }}>The stream loops and is not encrypted to anyone. Cameras across the room, recordings and reflections all work. Use it only for material meant for everyone present.</p>
      </div>
      <FilePicker files={files} onChange={setFiles} disabled={busy} />
      <label className="toggle">
        <input type="checkbox" checked={sign} disabled={!s.active} onChange={(e) => setSign(e.target.checked)} />
        <span>
          Sign as me <span className="subtle">— receivers who paired with you see "Signed by" your name</span>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} data-testid="broadcast-ack" />
        <span>I understand anyone in view can receive these files</span>
      </label>
      {error && <Notice tone="danger">{error}</Notice>}
      <button
        type="button"
        className="btn primary block"
        disabled={busy || !acknowledged || files.length === 0}
        data-testid="start-broadcast"
        onClick={() => {
          setBusy(true);
          setError(null);
          const publisher = sign && s.keys && s.chain ? { signing: s.keys.signing, fingerprint: s.chain.fingerprint, label: s.profile.label } : undefined;
          prepareBroadcastStream({ files: toEnvelopeInputs(files), ...(publisher ? { publisher } : {}), tier: 0, qr: qrStream })
            .then((r) => setSender(r.sender))
            .catch((e: unknown) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Preparing…" : "Start broadcast"}
      </button>
    </div>
  );
}

interface PublisherView {
  verified: "pinned" | "self" | "signature-only" | "invalid" | "unsigned";
  name?: string;
}

export function BroadcastReceivePage() {
  const s = useSession();
  const [capturing, setCapturing] = useState(true);
  const [update, setUpdate] = useState<CaptureUpdate | null>(null);
  const [result, setResult] = useState<{ files: ReceivedFile[]; publisher: PublisherView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(0);

  const classify = async (r: CaptureResult): Promise<PublisherView> => {
    const p = r.publisher;
    if (!p) return { verified: "unsigned" };
    if (!p.signatureValid) return { verified: "invalid" };
    const fp = p.fingerprint;
    if (s.chain && ctEqual(fp, s.chain.fingerprint)) {
      const own = [...s.chain.devices.values()].some((d) => d.revokedSeq === undefined && ctEqual(compress(d.signingPublicKey), compress(p.signingKey)));
      return own ? { verified: "self", name: "you" } : { verified: "invalid" };
    }
    for (const c of await listContacts()) {
      if (!ctEqual(fromB64url(c.id), fp) || c.blocked) continue;
      const chain = cachedChain(c);
      const signer = chain && [...chain.devices.values()].some((d) => d.revokedSeq === undefined && ctEqual(compress(d.signingPublicKey), compress(p.signingKey)));
      if (signer) return { verified: "pinned", name: c.displayName };
    }
    return { verified: "signature-only" };
  };

  if (result) {
    const v = result.publisher;
    return (
      <div className="stack-lg" data-testid="broadcast-done">
        <PageTitle eyebrow="Broadcast received">{result.files.length === 1 ? "Your file is here" : `${result.files.length} files are here`}</PageTitle>
        {v.verified === "pinned" || v.verified === "self" ? (
          <Notice tone="ok">Signed by {v.name}</Notice>
        ) : v.verified === "signature-only" ? (
          <Notice>Signature present, publisher not verified. You have not paired with this publisher.</Notice>
        ) : v.verified === "invalid" ? (
          <Notice tone="danger">The broadcast carries a signature that does not verify. Treat these files as unsigned and untrusted.</Notice>
        ) : (
          <Notice>Unsigned broadcast. Anyone could have produced it.</Notice>
        )}
        <ReceivedFiles files={result.files} />
        <Link to="/" className="btn ghost">
          Done
        </Link>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Receive a broadcast">Point your camera at the screen</PageTitle>
      <p className="muted">You can start at any moment; the stream repeats. Keep the whole pattern in view until the progress reaches 100%.</p>
      {error && <Notice tone="danger">{error}</Notice>}
      {capturing ? (
        <>
          <OpticalCapture
            key={key.current}
            init={{ type: "init", mode: "broadcast", tiers: [0] }}
            onProgress={setUpdate}
            onComplete={(r) => {
              void classify(r).then((publisher) =>
                setResult({
                  files: memoryFiles(r.files.map((f) => ({ entry: { path: f.path, size: f.size, mediaType: f.mediaType, sha256: new Uint8Array(32), ...(f.mtime !== undefined ? { mtime: f.mtime } : {}) }, data: f.data }))),
                  publisher,
                }),
              );
            }}
            onError={setError}
          />
          <CaptureStatus update={update} />
          <button type="button" className="btn ghost" onClick={() => setCapturing(false)}>
            Stop
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => {
            key.current++;
            setUpdate(null);
            setCapturing(true);
          }}
        >
          Start camera
        </button>
      )}
    </div>
  );
}
