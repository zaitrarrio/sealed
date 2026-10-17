/**
 * Receive offline · Secure (Air-gap, spec §3.6, §6.5), as two turns of "one shows, the other films":
 *
 *   1. Show: this phone shows its key code (public key, nonce, capability tier); the sender films it.
 *   2. Switch: this phone films the sender's screen with the platform QR detector (full frame, any angle).
 *
 * The safety code appears once the first frames are read; files are stored encrypted at rest on completion and
 * kept only after the user confirms the codes matched.
 */
import { createReverseKeyOffer, type Tier } from "@sealed/core";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { CodeCamera } from "../../src/components/CodeCamera";
import { OpticalCapture } from "../../src/components/OpticalCapture";
import { QrCode } from "../../src/components/QrCode";
import { ReceivedFiles } from "../../src/components/ReceivedFiles";
import { Steps } from "../../src/components/Steps";
import { decodePathFor, tierForMeasurement } from "../../src/lib/capability";
import { codeOrigin } from "../../src/lib/config";
import type { DecodeProgress, DecodeSessionOptions } from "../../src/lib/facet-decode";
import { formatBytes } from "../../src/lib/bytes";
import { deleteReceived, storeOpened, type ReceivedFile } from "../../src/lib/received";
import { describeSender, type SenderView } from "../../src/lib/sender-check";
import { nativeFacetAvailable } from "../../src/lib/native-facet";
import { session, useSession } from "../../src/lib/session";
import { useTorchSignal } from "../../src/lib/torch-signal";
import { Button, Card, CheckCode, Disclosure, Notice, P, Progress, Row, Screen, Segmented, Spinner, Title, errorMessage, fonts } from "../../src/ui/kit";

const STEPS = ["You show, they film", "Switch: they show, you film"] as const;

const NOOP = () => undefined;

export default function ReceiveOffline() {
  const s = useSession();
  const [tier, setTier] = useState<Tier>(() => tierForMeasurement(s.settings.opticalMeasurement, nativeFacetAvailable()));
  const [offer, setOffer] = useState<{ code: string; nonce: Uint8Array; tier: Tier } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [update, setUpdate] = useState<DecodeProgress | null>(null);
  const [result, setResult] = useState<{ files: ReceivedFile[]; sender: SenderView | null; sas: string | null; kept: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastUpdate = useRef<DecodeProgress | null>(null);
  // Torch back-channel: only the QR path keeps the camera's object output running while the torch plays.
  const signal = useTorchSignal(decodePathFor(tier) === "codes");

  // One offer per tier choice: the nonce shown in the code must be the one kept for the safety code.
  useEffect(() => {
    if (!s.keys || capturing) return;
    const o = createReverseKeyOffer(codeOrigin(), s.keys, s.profile.label || "Sealed receiver", tier);
    setOffer({ ...o, tier });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.keys, tier]);

  const options = useMemo<DecodeSessionOptions | null>(() => (offer && s.keys ? { mode: "airgap", airgap: { device: s.keys, nonce: offer.nonce } } : null), [offer, s.keys]);

  const rememberPixelSpeed = () => {
    const m = lastUpdate.current?.measurement;
    if (decodePathFor(tier) === "pixels" && m && m.decodeMsPerFrame > 0) void session.updateSettings({ opticalMeasurement: { captureFps: m.captureFps, decodeMsPerFrame: m.decodeMsPerFrame, at: Date.now() } });
  };

  if (result) {
    const n = result.files.length;
    return (
      <Screen>
        <Title eyebrow="Received offline">{n === 1 ? "Your file is here" : `${n} files are here`}</Title>
        {signal.busy ? (
          <Row>
            <View style={{ width: 64, height: 48, borderRadius: 8, overflow: "hidden" }}>
              <CodeCamera onCode={NOOP} torch={signal.torch} label="Telling the sender it arrived" />
            </View>
            <P tone="subtle">Telling their phone it arrived (torch).</P>
          </Row>
        ) : null}
        {result.sender ? (
          <P>{result.sender.verified ? `From ${result.sender.display}, a paired contact (signature matches their verified devices).` : `From ${result.sender.display}. Sealed cannot confirm who that is.`}</P>
        ) : null}
        {!result.kept && result.sas ? (
          <Card>
            <CheckCode value={result.sas} label="Safety code — does it match the sender's screen?" testID="airgap-receiver-sas" />
            <P tone="subtle">If it does not match, the stream was not from the person in front of you. Delete the files.</P>
            <Row>
              <Button title="It matches — keep" tone="primary" onPress={() => setResult({ ...result, kept: true })} />
              <Button title="It does not match — delete" tone="danger" onPress={() => void Promise.all(result.files.map((f) => deleteReceived(f.id))).then(() => router.replace("/"))} />
            </Row>
          </Card>
        ) : (
          <>
            <ReceivedFiles files={result.files} />
            <Button title="Done" tone="ghost" onPress={() => router.replace("/")} />
          </>
        )}
      </Screen>
    );
  }

  return (
    <Screen>
      <Title eyebrow="Receive offline">{capturing ? "Film their screen" : "Show this to the sender"}</Title>
      <Steps current={capturing ? 2 : 1} steps={STEPS} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!capturing ? (
        <View style={{ gap: 16 }}>
          {offer ? <QrCode text={offer.code} label="Offline key code" testID="reverse-key-code" /> : <Spinner label="Preparing…" />}
          <P>They film this with Sealed → Share offline. It carries only this phone's public key; nothing secret.</P>
          <Button title="They have it — switch to my camera" tone="primary" disabled={!offer} onPress={() => setCapturing(true)} testID="start-capture" />
          <Disclosure title="Advanced: stream type">
            <Segmented
              label="Stream type"
              value={String(tier) as "0" | "1" | "2" | "3"}
              onChange={(v) => setTier(Number(v) as Tier)}
              options={[
                ["0", "T0 QR"],
                ["1", "T1 grid"],
                ["2", "T2"],
                ["3", "T3"],
              ]}
            />
            <P tone="subtle">{nativeFacetAvailable() ? "T0 is read by the phone's own QR detector. Grid tiers are decoded by Sealed's native decoder on this phone; the Benchmark measures how fast." : "T0 is read by the phone's own QR detector and works on every phone. Grid tiers carry more per frame but this build decodes them in JavaScript (slow); measure them with the Benchmark first."}</P>
          </Disclosure>
        </View>
      ) : null}
      {capturing && options ? (
        <View style={{ gap: 12 }}>
          <OpticalCapture
            decode={decodePathFor(tier)}
            options={options}
            overlay={<LiveStatus update={update} signal={signal.last} />}
            torch={signal.torch}
            keepAlive={signal.busy}
            onProgress={(u) => {
              lastUpdate.current = u;
              setUpdate(u);
              signal.report(u.progress);
            }}
            onComplete={(r) => {
              rememberPixelSpeed();
              signal.done();
              if (!s.keys) return;
              const keys = s.keys;
              const sas = lastUpdate.current?.sas ?? null;
              void (async () => {
                const sender = await describeSender(r.sender, s.chain).catch(() => null);
                const files = await storeOpened(keys.agreement, r.files, sender?.display);
                setResult({ files, sender, sas, kept: false });
              })().catch((e: unknown) => setError(errorMessage(e)));
            }}
            onError={(m) => {
              rememberPixelSpeed();
              setError(m);
            }}
          />
          {update?.sas ? (
            <Card>
              <CheckCode value={update.sas} label="Safety code — must match the sender's screen" />
              <P tone="subtle">If it does not match, stop: you are not receiving from the person in front of you.</P>
            </Card>
          ) : (
            <P tone="subtle">Point the camera at their screen. The code can be anywhere in view; closer is faster.</P>
          )}
          {update?.files ? <P tone="subtle">{update.files.map((f) => `${f.path} (${formatBytes(f.size)})`).join(", ")}</P> : null}
          {update ? <Progress fraction={update.progress.fraction} label="Received" /> : null}
          <Button
            title="Back to my key code"
            tone="ghost"
            onPress={() => {
              rememberPixelSpeed();
              signal.stop();
              setCapturing(false);
              setUpdate(null);
            }}
          />
        </View>
      ) : null}
    </Screen>
  );
}

function LiveStatus({ update, signal }: { update: DecodeProgress | null; signal: string | null }) {
  const p = update?.progress;
  const loss = p?.recentLoss !== null && p?.recentLoss !== undefined ? ` · missing ${Math.round(p.recentLoss * 100)}%` : "";
  const text = !p
    ? "Looking for their stream…"
    : p.framesDecoded === 0
      ? `Reading… ${p.framesSeen} codes seen, none from Sealed yet`
      : `${Math.round(p.fraction * 100)}% · ${p.framesDecoded} frames · ${update.measurement.captureFps.toFixed(0)}/s${loss}${signal ? ` · torch: ${signal}` : ""}`;
  return <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: "#F4EDE4" }}>{text}</Text>;
}
