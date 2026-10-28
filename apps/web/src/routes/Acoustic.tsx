/**
 * Offline acoustic transfer (ADR-0024): Air-gap and Broadcast over the speaker and microphone.
 * Reverse-key scan still uses the camera for strangers; the file then moves as audible tones.
 */
import {
  ACOUSTIC_SIZE_WARN_BYTES,
  AcousticReceiver,
  airgapAcousticReceiverSas,
  createReverseKeyOffer,
  ctEqual,
  compress,
  estimateAcousticSeconds,
  openAcousticEnvelope,
  prepareAirgapAcousticStream,
  prepareBroadcastAcousticStream,
  type AcousticProfileId,
  type AcousticSender,
  type ParsedCode,
} from "@sealed/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { FilePicker } from "../components/FilePicker";
import { QrCode } from "../components/QrCode";
import { ReceivedFiles } from "../components/ReceivedFiles";
import { Scanner } from "../components/Scanner";
import { CheckCode, Notice, PageTitle, Progress, Spinner, Steps, errorMessage } from "../components/ui";
import { captureAcousticReceiver, playAcousticSender } from "../lib/acoustic-audio";
import { formatBytes } from "../lib/bytes";
import { cameraAvailable } from "../lib/camera";
import { acceptedOrigins, codeOrigin } from "../lib/config";
import { cachedChain, listContacts } from "../lib/contacts-store";
import { toEnvelopeInputs, totalSize } from "../lib/files";
import { memoryFiles, type ReceivedFile } from "../lib/received";
import { codeFromLocation, expectCode, friendlyCodeError } from "../lib/routing";
import { useSelection } from "../lib/selection";
import { useSession } from "../lib/session";

function formatDuration(s: number): string {
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

// --------------------------------------------------------------------------------------------- hub

export function AcousticHubPage() {
  const [files] = useSelection();
  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Share offline">Send through the speaker</PageTitle>
      <p className="muted">
        No network is needed. This device plays audible tones; the other listens with its microphone. Sound is slower than the
        screen — prefer the camera for large files.
      </p>
      {files.length > 0 && (
        <p className="subtle">
          Using your selection: {files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(totalSize(files))}
        </p>
      )}
      <div className="grid-2">
        <Link to="/acoustic/send" className="action-tile primary" data-testid="acoustic-airgap-send">
          <span className="title">Secure</span>
          <span className="desc">Scan their key code first. Only that device can open the tones, even if others listen.</span>
        </Link>
        <Link to="/acoustic/broadcast" className="action-tile" data-testid="acoustic-broadcast-send">
          <span className="title">Anyone listening</span>
          <span className="desc">Anyone who can hear this can receive it — including through an open door. Use only for material meant for all of them.</span>
        </Link>
      </div>
      <div className="row">
        <Link to="/acoustic/receive" className="btn">
          Receive over sound
        </Link>
        <Link to="/acoustic/broadcast/receive" className="btn ghost">
          Receive a sound broadcast
        </Link>
        <Link to="/offline" className="btn ghost">
          Use the screen instead
        </Link>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- air-gap sender

export function AcousticSendPage() {
  const s = useSession();
  const location = useLocation();
  const [files, setFiles] = useSelection();
  const [rk, setRk] = useState<Extract<ParsedCode, { kind: "reverse-key" }> | null>(null);
  const [prepared, setPrepared] = useState<{ sender: AcousticSender; sas: string; profile: AcousticProfileId } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [packets, setPackets] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pinnedName, setPinnedName] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  useEffect(() => {
    if (!rk || files.length === 0 || prepared || busy || error) return;
    setBusy(true);
    const signedBy = s.keys && s.active ? s.keys : undefined;
    prepareAirgapAcousticStream({
      files: toEnvelopeInputs(files),
      reverseKey: rk,
      ...(signedBy ? { senderKeys: signedBy } : {}),
      senderLabel: s.profile.label || "Sealed sender",
      profile: 0,
    })
      .then((p) => setPrepared({ sender: p.sender, sas: p.sas, profile: p.profile }))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  }, [rk, files, prepared, busy, error, s.keys, s.active, s.profile.label]);

  const startPlay = useCallback(async () => {
    if (!prepared) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setPlaying(true);
    setPackets(0);
    setError(null);
    try {
      await playAcousticSender(prepared.sender, prepared.profile, {
        signal: ctl.signal,
        onPacket: (n) => setPackets(n),
      });
      setDone(true);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(errorMessage(e));
    } finally {
      setPlaying(false);
    }
  }, [prepared]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const bytes = totalSize(files);
  const eta = estimateAcousticSeconds(bytes, 0);

  if (done && prepared) {
    return (
      <div className="stack-lg" data-testid="acoustic-airgap-done">
        <PageTitle eyebrow="Finished playing">Tones sent</PageTitle>
        <CheckCode value={prepared.sas} label="Safety code — their screen shows the same" testId="acoustic-sender-sas" />
        <p className="subtle">If the safety codes differ, tell them to delete what they received.</p>
        <Link className="btn primary" to="/">
          Done
        </Link>
      </div>
    );
  }

  if (prepared) {
    return (
      <div className="stack-lg">
        <Steps current={2} steps={["They show, you film", "You play, they listen"]} />
        <CheckCode value={prepared.sas} label="Safety code — their screen shows the same" testId="acoustic-sender-sas" />
        <Notice tone="info">Keep the devices close and the room quiet. Do not read the safety code aloud while the tones play.</Notice>
        {playing ? (
          <p className="muted" data-testid="acoustic-playing">
            Playing… {packets} packets
          </p>
        ) : (
          <button type="button" className="btn primary" data-testid="acoustic-play" onClick={() => void startPlay()}>
            Play tones
          </button>
        )}
        {playing && (
          <button type="button" className="btn ghost" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Share offline · Sound · Secure">Send to one device, through the speaker</PageTitle>
      <Steps current={rk ? 2 : 1} steps={["They show, you film", "You play, they listen"]} />
      {error && <Notice tone="danger">{error}</Notice>}
      {(files.length === 0 || !rk) && <FilePicker files={files} onChange={setFiles} disabled={busy} />}
      {bytes > ACOUSTIC_SIZE_WARN_BYTES && (
        <Notice tone="info">
          About {formatBytes(bytes)} over sound takes roughly {formatDuration(eta)}. Prefer{" "}
          <Link to="/offline/send">the screen</Link> for large files.
        </Notice>
      )}
      {!rk && (
        <div className="stack">
          <p className="muted">On their device: Sealed → Receive over sound. Point your camera at the key code it shows.</p>
          {!cameraAvailable() && <Notice tone="danger">This device has no camera to scan their key code. A pinned contact can skip this step in a later release; for now use the screen path or a device with a camera.</Notice>}
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
      {rk && files.length > 0 && busy && <Spinner label="Encrypting…" />}
      {rk && pinnedName && <p className="subtle">Key matches pinned contact {pinnedName}.</p>}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- air-gap receive

export function AcousticReceivePage() {
  const s = useSession();
  const [offer, setOffer] = useState<{ code: string; nonce: Uint8Array } | null>(null);
  const [listening, setListening] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [sas, setSas] = useState<string | null>(null);
  const [files, setFiles] = useState<ReceivedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const receiverRef = useRef<AcousticReceiver | null>(null);

  useEffect(() => {
    if (!s.keys || offer) return;
    setOffer(createReverseKeyOffer(codeOrigin(), s.keys, s.profile.label || "Sealed device", 0));
  }, [s.keys, s.profile.label, offer]);

  const startListen = useCallback(async () => {
    if (!s.keys || !offer) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const receiver = new AcousticReceiver(0);
    receiverRef.current = receiver;
    setListening(true);
    setError(null);
    setFiles(null);
    try {
      await captureAcousticReceiver(receiver, 0, {
        signal: ctl.signal,
        onProgress: () => {
          setFraction(receiver.progress.fraction);
          const next = airgapAcousticReceiverSas(receiver, offer.nonce, s.keys!.agreement.publicKey);
          if (next) setSas(next);
        },
      });
      const opened = await openAcousticEnvelope(receiver, { device: s.keys });
      setFiles(memoryFiles(opened.files));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(errorMessage(e));
    } finally {
      setListening(false);
    }
  }, [s.keys, offer]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (files) {
    return (
      <div className="stack-lg" data-testid="acoustic-airgap-received">
        <PageTitle eyebrow="Received">Files arrived over sound</PageTitle>
        {sas && <CheckCode value={sas} label="Safety code — must match the sender's screen" testId="acoustic-receiver-sas" />}
        <ReceivedFiles files={files} />
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Receive over sound">Listen for a secure transfer</PageTitle>
      <p className="muted">Show this key code to the sender. After they scan it, tap Listen — the microphone stays off until then.</p>
      {offer && (
        <div className="stack" data-testid="acoustic-reverse-key">
          <QrCode text={offer.code} label="Your key code" />
          <p className="subtle">They film this with Sealed → Share offline / sound. It carries only this device's public key.</p>
        </div>
      )}
      {sas && <CheckCode value={sas} label="Safety code — must match the sender's screen" testId="acoustic-receiver-sas" />}
      {listening ? (
        <>
          <Progress fraction={fraction} label="Listening…" />
          <button type="button" className="btn ghost" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        </>
      ) : (
        <button type="button" className="btn primary" data-testid="acoustic-listen" disabled={!offer || !s.keys} onClick={() => void startListen()}>
          Listen
        </button>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <Link to="/offline/receive" className="btn ghost">
        Use the camera instead
      </Link>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- broadcast

export function AcousticBroadcastSendPage() {
  const s = useSession();
  const [files, setFiles] = useSelection();
  const [prepared, setPrepared] = useState<{ sender: AcousticSender; profile: AcousticProfileId } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [warned, setWarned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const bytes = totalSize(files);

  const prepare = useCallback(async () => {
    if (files.length === 0) return;
    setError(null);
    try {
      const publisher =
        s.keys && s.active && s.chain
          ? { signing: s.keys.signing, fingerprint: s.chain.fingerprint, label: s.profile.label || "Sealed" }
          : undefined;
      const p = await prepareBroadcastAcousticStream({
        files: toEnvelopeInputs(files),
        ...(publisher ? { publisher } : {}),
        profile: 0,
      });
      setPrepared({ sender: p.sender, profile: p.profile });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [files, s.keys, s.active, s.chain, s.profile.label]);

  const startPlay = useCallback(async () => {
    if (!prepared) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setPlaying(true);
    try {
      // Looping sender never finishes — play until abort.
      await playAcousticSender(prepared.sender, prepared.profile, { signal: ctl.signal });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(errorMessage(e));
    } finally {
      setPlaying(false);
    }
  }, [prepared]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!warned) {
    return (
      <div className="stack-lg">
        <PageTitle eyebrow="Anyone listening">Open broadcast over sound</PageTitle>
        <Notice tone="info">
          Anyone who can hear these tones can receive the files — including people in the next room. Sound travels further than a
          screen. Continue only for material meant for everyone present.
        </Notice>
        <FilePicker files={files} onChange={setFiles} />
        {bytes > ACOUSTIC_SIZE_WARN_BYTES && (
          <Notice tone="info">
            Large for sound (~{formatDuration(estimateAcousticSeconds(bytes, 0))}). Prefer <Link to="/broadcast">the screen</Link>.
          </Notice>
        )}
        <button type="button" className="btn primary" data-testid="acoustic-broadcast-warn-ok" disabled={files.length === 0} onClick={() => setWarned(true)}>
          I understand — continue
        </button>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Anyone listening">Broadcasting over sound</PageTitle>
      {!prepared ? (
        <button type="button" className="btn primary" data-testid="acoustic-broadcast-prepare" onClick={() => void prepare()}>
          Prepare stream
        </button>
      ) : playing ? (
        <button type="button" className="btn" data-testid="acoustic-broadcast-stop" onClick={() => abortRef.current?.abort()}>
          Stop
        </button>
      ) : (
        <button type="button" className="btn primary" data-testid="acoustic-broadcast-play" onClick={() => void startPlay()}>
          Play tones
        </button>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

export function AcousticBroadcastReceivePage() {
  const [listening, setListening] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [files, setFiles] = useState<ReceivedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startListen = useCallback(async () => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const receiver = new AcousticReceiver(0);
    setListening(true);
    setError(null);
    try {
      await captureAcousticReceiver(receiver, 0, {
        signal: ctl.signal,
        onProgress: () => setFraction(receiver.progress.fraction),
      });
      const opened = await openAcousticEnvelope(receiver, {});
      setFiles(memoryFiles(opened.files));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(errorMessage(e));
    } finally {
      setListening(false);
    }
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (files) {
    return (
      <div className="stack-lg" data-testid="acoustic-broadcast-received">
        <PageTitle eyebrow="Received">Broadcast arrived over sound</PageTitle>
        <ReceivedFiles files={files} />
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Receive a sound broadcast">Listen for an open stream</PageTitle>
      <p className="muted">The microphone turns on only while you listen. Anyone nearby who is also listening can receive the same files.</p>
      {listening ? (
        <>
          <Progress fraction={fraction} label="Listening…" />
          <button type="button" className="btn ghost" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        </>
      ) : (
        <button type="button" className="btn primary" data-testid="acoustic-broadcast-listen" onClick={() => void startListen()}>
          Listen
        </button>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
