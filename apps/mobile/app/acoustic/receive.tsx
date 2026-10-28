/** Acoustic Air-gap receive: show reverse key, then listen. */
import {
  AcousticReceiver,
  airgapAcousticReceiverSas,
  createReverseKeyOffer,
  openAcousticEnvelope,
} from "@sealed/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { QrCode } from "../../src/components/QrCode";
import { ReceivedFiles } from "../../src/components/ReceivedFiles";
import { captureAcousticReceiver } from "../../src/lib/acoustic-audio";
import { codeOrigin } from "../../src/lib/config";
import { storeOpened, type ReceivedFile } from "../../src/lib/received";
import { useSession } from "../../src/lib/session";
import { Button, CheckCode, Notice, P, Progress, Screen, Title, errorMessage } from "../../src/ui/kit";

export default function AcousticReceive() {
  const s = useSession();
  const [offer, setOffer] = useState<{ code: string; nonce: Uint8Array } | null>(null);
  const [listening, setListening] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [sas, setSas] = useState<string | null>(null);
  const [files, setFiles] = useState<ReceivedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    setListening(true);
    setError(null);
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
      const stored = await storeOpened(s.keys.agreement, opened.files);
      setFiles(stored);
    } catch (e) {
      if ((e as Error).message !== "aborted") setError(errorMessage(e));
    } finally {
      setListening(false);
    }
  }, [s.keys, offer]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (files) {
    return (
      <Screen>
        <Title eyebrow="Received">Files arrived over sound</Title>
        {sas ? <CheckCode value={sas} label="Safety code — must match the sender's screen" testID="acoustic-receiver-sas" /> : null}
        <ReceivedFiles files={files} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title eyebrow="Receive over sound">Listen for a secure transfer</Title>
      <P tone="muted">Show this key code to the sender. After they scan it, tap Listen — the microphone stays off until then.</P>
      {offer ? <QrCode text={offer.code} label="Your key code" testID="acoustic-reverse-key" /> : null}
      {sas ? <CheckCode value={sas} label="Safety code — must match the sender's screen" testID="acoustic-receiver-sas" /> : null}
      {listening ? (
        <>
          <Progress fraction={fraction} label="Listening…" />
          <Button title="Stop" tone="ghost" onPress={() => abortRef.current?.abort()} />
        </>
      ) : (
        <Button title="Listen" testID="acoustic-listen" disabled={!offer || !s.keys} onPress={() => void startListen()} />
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Screen>
  );
}
