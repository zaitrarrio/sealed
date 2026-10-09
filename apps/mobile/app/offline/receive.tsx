/**
 * Receive offline · Secure (Air-gap, spec §3.6, §6.5). Shows this phone's reverse key code (public key, nonce,
 * capability tier), then reads the sender's stream with the camera. The check code appears once the first
 * frames are read; the files are stored encrypted at rest on completion.
 */
import { createReverseKeyOffer, type Tier } from "@sealed/core";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { CaptureStatus } from "../../src/components/CaptureStatus";
import { OpticalCapture } from "../../src/components/OpticalCapture";
import { QrCode } from "../../src/components/QrCode";
import { ReceivedFiles } from "../../src/components/ReceivedFiles";
import { tierForMeasurement } from "../../src/lib/capability";
import { codeOrigin } from "../../src/lib/config";
import type { DecodeProgress, DecodeResult, DecodeSessionOptions } from "../../src/lib/facet-decode";
import { storeOpened, type ReceivedFile } from "../../src/lib/received";
import { session, useSession } from "../../src/lib/session";
import { Button, Card, CheckCode, Notice, P, Screen, Segmented, Spinner, Title, errorMessage } from "../../src/ui/kit";

export default function ReceiveOffline() {
  const s = useSession();
  const [tier, setTier] = useState<Tier>(() => tierForMeasurement(s.settings.opticalMeasurement));
  const [offer, setOffer] = useState<{ code: string; nonce: Uint8Array; tier: Tier } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [update, setUpdate] = useState<DecodeProgress | null>(null);
  const [result, setResult] = useState<{ files: ReceivedFile[]; sender: DecodeResult["sender"] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastUpdate = useRef<DecodeProgress | null>(null);

  // One offer per tier choice: the nonce shown in the code must be the one kept for the check code.
  useEffect(() => {
    if (!s.keys || capturing) return;
    const o = createReverseKeyOffer(codeOrigin(), s.keys, s.profile.label || "Sealed receiver", tier);
    setOffer({ ...o, tier });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.keys, tier]);

  const options = useMemo<DecodeSessionOptions | null>(() => (offer && s.keys ? { mode: "airgap", airgap: { device: s.keys, nonce: offer.nonce } } : null), [offer, s.keys]);

  const remember = () => {
    const m = lastUpdate.current?.measurement;
    if (m && m.decodeMsPerFrame > 0) void session.updateSettings({ opticalMeasurement: { captureFps: m.captureFps, decodeMsPerFrame: m.decodeMsPerFrame, at: Date.now() } });
  };

  if (result) {
    return (
      <Screen>
        <Title eyebrow="Received offline">{result.files.length === 1 ? "Your file is here" : `${result.files.length} files are here`}</Title>
        {result.sender ? <P>{`From ${result.sender.label}, signed by the sender's device.`}</P> : null}
        <ReceivedFiles files={result.files} />
        <Button title="Done" tone="ghost" onPress={() => router.replace("/")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title eyebrow="Receive offline">Show this to the sender</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!capturing ? (
        <View style={{ gap: 16 }}>
          {offer ? <QrCode text={offer.code} label="Offline key code" testID="reverse-key-code" /> : <Spinner label="Preparing…" />}
          <P>The sender scans this with their camera. It carries only this phone's public key; nothing secret.</P>
          <Segmented
            label="Capability"
            value={String(tier) as "0" | "1" | "2" | "3"}
            onChange={(v) => setTier(Number(v) as Tier)}
            options={[
              ["0", "T0 (QR)"],
              ["1", "T1"],
              ["2", "T2"],
              ["3", "T3"],
            ]}
          />
          <P tone="subtle">
            {s.settings.opticalMeasurement
              ? `Chosen from the last receive (${s.settings.opticalMeasurement.decodeMsPerFrame.toFixed(0)} ms per frame). Lower it if receiving stalls.`
              : "T1 until this phone has measured a receive. Lower it if receiving stalls."}
          </P>
          <Button title="They scanned it — point my camera at their screen" tone="primary" disabled={!offer} onPress={() => setCapturing(true)} testID="start-capture" />
        </View>
      ) : null}
      {capturing && options ? (
        <View style={{ gap: 12 }}>
          <OpticalCapture
            options={options}
            onProgress={(u) => {
              lastUpdate.current = u;
              setUpdate(u);
            }}
            onComplete={(r) => {
              remember();
              if (!s.keys) return;
              storeOpened(s.keys.agreement, r.files, r.sender?.label)
                .then((files) => setResult({ files, sender: r.sender }))
                .catch((e: unknown) => setError(errorMessage(e)));
            }}
            onError={(m) => {
              remember();
              setError(m);
            }}
          />
          <CaptureStatus update={update} />
          {update?.sas ? (
            <Card>
              <CheckCode value={update.sas} label="Check code — must match the sender's screen" testID="airgap-receiver-sas" />
              <P tone="subtle">If it does not match, stop: you are not receiving from the person in front of you.</P>
            </Card>
          ) : null}
          <Button
            title="Stop"
            tone="ghost"
            onPress={() => {
              remember();
              setCapturing(false);
            }}
          />
        </View>
      ) : null}
    </Screen>
  );
}
