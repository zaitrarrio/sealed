/**
 * Share offline (spec §3.6–3.7, §6.5–6.6). Air-gap (secure): the receiver shows a reverse key code, the sender's
 * camera scans it, both show the Air-gap check code, and the sender's screen streams Facet frames that only the
 * receiver's device key can open. Broadcast (open): the sender loops the stream and anyone in view can decode it.
 */
import { TIERS, compress, ctEqual, createReverseKeyOffer, fromB64url, prepareAirgapStream, prepareBroadcastStream, type FacetSender, type ParsedCode, type Tier } from "@sealed/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { FacetStream } from "../components/FacetStream";
import { FilePicker } from "../components/FilePicker";
import { OpticalCapture, type CaptureResult, type CaptureUpdate } from "../components/OpticalCapture";
import { QrCode } from "../components/QrCode";
import { ReceivedFiles } from "../components/ReceivedFiles";
import { Scanner } from "../components/Scanner";
import { CheckCode, Notice, PageTitle, Progress, Spinner, errorMessage } from "../components/ui";
import { formatBytes } from "../lib/bytes";
import { cameraAvailable, openCamera, stopStream } from "../lib/camera";
import { probeCamera, tierForProbe } from "../lib/capability";
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
const LARGE_OPTICAL_BYTES = 20 * 1024 * 1024;

function etaSeconds(bytes: number, tier: Tier): number {
  const t = TIERS[tier];
  return Math.ceil(bytes / (t.symbolSize * t.dataFps * 0.85));
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

  const prepare = async () => {
    if (!rk || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const signedBy = s.keys && s.active ? s.keys : undefined;
      const p = await prepareAirgapStream({ files: toEnvelopeInputs(files), reverseKey: rk, ...(signedBy ? { senderKeys: signedBy } : {}), senderLabel: s.profile.label || "Sealed sender" });
      setPrepared({ sender: p.sender, sas: p.sas });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (prepared && confirmed) {
    return <FacetStream sender={prepared.sender} caption={`check ${prepared.sas}`} onStop={() => setConfirmed(false)} />;
  }

  const tier = (rk ? Math.min(rk.tier, 3) : 1) as Tier;
  const bytes = totalSize(files);

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Share offline · Secure">Send to one device, through light</PageTitle>
      {error && <Notice tone="danger">{error}</Notice>}
      {!rk && (
        <div className="stack">
          <p className="muted">On the receiving device, open Sealed and choose "Receive offline". Scan the key code it shows.</p>
          {!cameraAvailable() && <Notice tone="danger">This device has no usable camera, so Secure offline sharing is unavailable. Use "Anyone watching" only for material meant for everyone in view.</Notice>}
          <Scanner
            label="Scan the receiver's key code"
            onCode={(text) => {
              try {
                setRk(expectCode(text, "reverse-key", acceptedOrigins()));
                return null;
              } catch (e) {
                return friendlyCodeError(e);
              }
            }}
          />
        </div>
      )}
      {rk && !prepared && (
        <div className="stack-lg">
          <div className="card stack">
            <strong>Receiver: {pinnedName ?? rk.label}</strong>
            <span className="subtle">
              Capability T{rk.tier}
              {pinnedName ? " · a device of a paired contact" : ""}
            </span>
          </div>
          <FilePicker files={files} onChange={setFiles} disabled={busy} />
          {bytes > 0 && (
            <p className={bytes > LARGE_OPTICAL_BYTES ? "notice" : "subtle"}>
              About {formatDuration(etaSeconds(bytes, tier))} of streaming at T{tier}
              {bytes > LARGE_OPTICAL_BYTES ? ". That is long for an optical transfer; consider sharing online if a network is allowed." : "."}
            </p>
          )}
          <button type="button" className="btn primary block" disabled={busy || files.length === 0} onClick={() => void prepare()} data-testid="prepare-airgap">
            {busy ? "Encrypting…" : "Encrypt for this receiver"}
          </button>
        </div>
      )}
      {prepared && !confirmed && (
        <div className="stack-lg">
          <CheckCode value={prepared.sas} label="Check code" testId="airgap-sender-sas" />
          <p className="muted">Start the stream. The receiver's screen shows a check code as soon as it reads the first frames. Continue only if it matches; if not, stop: the key code was not theirs.</p>
          <div className="row">
            <button type="button" className="btn primary" onClick={() => setConfirmed(true)} data-testid="start-stream">
              Start streaming
            </button>
            <button type="button" className="btn ghost" onClick={() => setPrepared(null)}>
              Back
            </button>
          </div>
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
  const [error, setError] = useState<string | null>(null);
  const [stored, setStored] = useState<StoredDeviceKeys | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    void kvGet<StoredDeviceKeys>("device-keys").then((k) => setStored(k ?? null));
  }, [s.keys]);

  const makeOffer = async (measure: boolean) => {
    if (!s.keys) return;
    let tier: Tier = 1;
    if (measure && cameraAvailable()) {
      setProbing(true);
      let stream: MediaStream | null = null;
      try {
        stream = await openCamera({ width: 1920, height: 1080, frameRate: 60 });
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        tier = tierForProbe(await probeCamera(video, stream));
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        stopStream(stream);
        setProbing(false);
      }
    }
    const o = createReverseKeyOffer(codeOrigin(), s.keys, s.profile.label || "Sealed receiver", tier);
    setOffer({ ...o, tier });
  };

  // One offer per visit: the nonce shown in the code must be the one kept for the check code.
  const offered = useRef(false);
  useEffect(() => {
    if (!s.keys || offered.current) return;
    offered.current = true;
    void makeOffer(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.keys]);

  if (result) {
    return (
      <div className="stack-lg" data-testid="airgap-done">
        <PageTitle eyebrow="Received offline">{result.files.length === 1 ? "Your file is here" : `${result.files.length} files are here`}</PageTitle>
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
      <PageTitle eyebrow="Receive offline">Show this to the sender</PageTitle>
      {error && <Notice tone="danger">{error}</Notice>}
      {!capturing && (
        <div className="stack-lg" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          {offer ? <QrCode text={offer.code} label="Offline key code" testId="reverse-key-code" /> : <Spinner label="Preparing…" />}
          <p className="muted">The sender scans this with their camera. It carries only this device's public key; nothing secret.</p>
          {offer && (
            <p className="subtle">
              Reporting capability T{offer.tier}.{" "}
              <button type="button" className="btn small ghost" disabled={probing} onClick={() => void makeOffer(true)}>
                {probing ? "Measuring camera…" : "Measure camera"}
              </button>
            </p>
          )}
          <button type="button" className="btn primary block" disabled={!offer || !stored} onClick={() => setCapturing(true)} data-testid="start-capture">
            They scanned it — point my camera at their screen
          </button>
        </div>
      )}
      {capturing && offer && stored && (
        <div className="stack">
          <OpticalCapture
            init={{ type: "init", mode: "airgap", airgap: { agreementPrivate: stored.agreementPrivate, agreementPublic: stored.agreementPublic, signingPrivate: stored.signingPrivate, signingPublic: stored.signingPublic, nonce: offer.nonce } }}
            onProgress={setUpdate}
            onComplete={(r) =>
              setResult({
                files: memoryFiles(r.files.map((f) => ({ entry: { path: f.path, size: f.size, mediaType: f.mediaType, sha256: new Uint8Array(32), ...(f.mtime !== undefined ? { mtime: f.mtime } : {}) }, data: f.data }))),
                sender: r.sender,
              })
            }
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

  if (sender) return <FacetStream sender={sender} caption="broadcast" onStop={() => setSender(null)} />;

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
          prepareBroadcastStream({ files: toEnvelopeInputs(files), ...(publisher ? { publisher } : {}), tier: 1, interleaveCompatible: true })
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
            init={{ type: "init", mode: "broadcast" }}
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
