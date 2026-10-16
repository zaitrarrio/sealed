/**
 * Optical benchmark. One phone shows a looping test stream; the other films it and reports, live, how far the
 * pipeline got: codes read, valid Sealed frames, completion, throughput, and a byte-for-byte check. Nothing to
 * pair or type: the stream names its own seed and size, so the filming phone knows what to expect.
 *
 * T0 (QR) is read by the platform detector, as real offline transfers are. The colour-grid tiers use the
 * JavaScript pixel decoder, which is why they are marked experimental.
 */
import { BENCHMARK_SIZES, BenchmarkMeter, DEFAULT_QR_STREAM, QR_HOLDS, QR_PROFILES, describeQrStream, formatBenchmarkReport, isDefaultQrStream, qrStreamSetting, type QrStreamSetting, prepareBenchmarkStream, type BenchmarkReport, type BenchmarkStream, type RgbaImage, type Tier } from "@sealed/core";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Share, Text, View } from "react-native";
import { CodeCamera } from "../src/components/CodeCamera";
import type { LockResult } from "../src/lib/camera-lock";
import { FacetStream } from "../src/components/FacetStream";
import { PixelCamera } from "../src/components/PixelCamera";
import { formatBytes } from "../src/lib/bytes";
import { session, useSession } from "../src/lib/session";
import { Button, Card, Notice, P, Progress, Row, Screen, Segmented, Stack, Title, errorMessage, fonts } from "../src/ui/kit";

type Role = "show" | "film";
type TierChoice = "0" | "1" | "2" | "3";

function deviceLine(): string {
  return `${Device.manufacturer ?? ""} ${Device.modelName ?? "phone"} · ${Platform.OS} ${Device.osVersion ?? ""}`.replace(/\s+/g, " ").trim();
}

export default function Bench() {
  const [role, setRole] = useState<Role>("film");
  return (
    <Screen>
      <Title eyebrow="Benchmark">Measure an offline transfer</Title>
      <P>One phone shows a test stream, the other films it. Then switch roles to measure the other direction.</P>
      <Segmented
        label="Role"
        value={role}
        onChange={setRole}
        options={[
          ["film", "Film"],
          ["show", "Show"],
        ]}
      />
      {role === "show" ? <ShowStream /> : <FilmStream />}
    </Screen>
  );
}

function ShowStream() {
  const s = useSession();
  const saved = qrStreamSetting(s.settings.qrStream);
  const [size, setSize] = useState<string>(String(BENCHMARK_SIZES[1]));
  const [tier, setTier] = useState<TierChoice>("0");
  const [qrSize, setQrSize] = useState<string>(String(saved.symbolSize));
  const [codes, setCodes] = useState<"1" | "2" | "4">(String(saved.codesPerScreen) as "1" | "2" | "4");
  const [hold, setHold] = useState<string>(String(saved.holdRefreshes60));
  const [stream, setStream] = useState<BenchmarkStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = qrStreamSetting({ symbolSize: Number(qrSize), codesPerScreen: Number(codes), holdRefreshes60: Number(hold) });
  const isSaved = chosen.symbolSize === saved.symbolSize && chosen.codesPerScreen === saved.codesPerScreen && chosen.holdRefreshes60 === saved.holdRefreshes60;

  if (stream) {
    const fps = 60 / stream.qr.holdRefreshes60;
    const profile = stream.tier === 0 ? `QR ${stream.qr.symbolSize} B × ${codes} at ${fps}/s` : `T${stream.tier}`;
    return (
      <View style={{ gap: 12 }}>
        <FacetStream sender={stream.sender} codesPerScreen={stream.tier === 0 ? Number(codes) : 1} caption={`bench ${profile} · ${formatBytes(stream.size)}`} onStop={() => setStream(null)} reduceMotion={s.settings.reduceMotion ?? false} />
        <P tone="subtle">The stream repeats until you stop it. The filming phone can start at any time.</P>
      </View>
    );
  }
  const nominal = (Number(qrSize) * Number(codes) * (60 / Number(hold))) / 1024;
  return (
    <Stack>
      <Segmented label="Payload size" value={size} onChange={setSize} options={BENCHMARK_SIZES.map((b) => [String(b), formatBytes(b)] as const)} />
      <Segmented
        label="Stream type"
        value={tier}
        onChange={setTier}
        options={[
          ["0", "QR"],
          ["1", "T1 grid"],
          ["2", "T2"],
          ["3", "T3"],
        ]}
      />
      {tier === "0" ? (
        <>
          <P tone="subtle">QR size (bytes per code)</P>
          <Segmented label="QR size" value={qrSize} onChange={setQrSize} options={QR_PROFILES.map((p) => [String(p.symbolSize), `v${p.qrVersion} · ${p.symbolSize}`] as const)} />
          <P tone="subtle">Codes on screen</P>
          <Segmented
            label="Codes on screen"
            value={codes}
            onChange={setCodes}
            options={[
              ["1", "1"],
              ["2", "2"],
              ["4", "4"],
            ]}
          />
          <P tone="subtle">Frames per second (on a 60 Hz screen)</P>
          <Segmented label="Frames per second" value={hold} onChange={setHold} options={QR_HOLDS.map((h) => [String(h), `${60 / h}/s`] as const)} />
          <P tone="subtle">{`Sends at most ${nominal.toFixed(0)} KB/s; the filming phone shows how much it actually reads.`}</P>
          <P tone="subtle">{`Your offline transfers use ${describeQrStream(saved)}${isDefaultQrStream(saved) ? " (the default)" : ""}.`}</P>
        </>
      ) : (
        <Notice>Grid tiers are experimental: the filming phone decodes them in JavaScript, about two frames a second at best.</Notice>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        title={busy ? "Preparing…" : "Show test stream"}
        tone="primary"
        busy={busy}
        testID="bench-show"
        onPress={() => {
          setBusy(true);
          setError(null);
          prepareBenchmarkStream({ size: Number(size), tier: Number(tier) as Tier, ...(tier === "0" ? { qr: { symbolSize: Number(qrSize), holdRefreshes60: Number(hold) } } : {}) })
            .then(setStream)
            .catch((e: unknown) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      />
      {tier === "0" ? <UseForTransfers chosen={chosen} isSaved={isSaved} /> : null}
    </Stack>
  );
}

/**
 * Saves the shown setting for this phone's offline sends. The sender decides how codes are drawn, so the choice
 * lives on the showing side: once the other phone reports "verified" at a good speed, keep it.
 */
function UseForTransfers({ chosen, isSaved }: { chosen: QrStreamSetting; isSaved: boolean }) {
  if (isSaved) {
    return (
      <Row>
        <P tone="subtle">Your offline transfers already use this setting.</P>
        {!isDefaultQrStream(chosen) ? <Button small tone="ghost" title="Back to default" onPress={() => void session.updateSettings({ qrStream: { ...DEFAULT_QR_STREAM } })} /> : null}
      </Row>
    );
  }
  return (
    <Card>
      <P>After a test: if the other phone reached “verified” quickly, keep this setting for when this phone sends offline.</P>
      <Button title={`Use ${describeQrStream(chosen)} for my offline transfers`} testID="bench-use" onPress={() => void session.updateSettings({ qrStream: chosen })} />
    </Card>
  );
}

function FilmStream() {
  const [path, setPath] = useState<"codes" | "pixels">("codes");
  const [run, setRun] = useState(0);
  const [running, setRunning] = useState(false);
  const meter = useRef(new BenchmarkMeter());
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [copied, setCopied] = useState(false);
  const [lock, setLock] = useState<LockResult | null>(null);
  const [cameraFps, setCameraFps] = useState<number | null>(null);

  // Live numbers four times a second while running.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      const r = meter.current.report();
      setReport(r);
      if (r.stage === "verified" || r.stage === "failed") setRunning(false);
    }, 250);
    return () => clearInterval(t);
  }, [running, run]);

  // Pixel-path runs teach the capability check how fast this phone decodes grid frames.
  useEffect(() => {
    if (running || path !== "pixels" || !report?.decodeMsPerFrame) return;
    void session.updateSettings({ opticalMeasurement: { captureFps: report.inputsPerSecond, decodeMsPerFrame: report.decodeMsPerFrame, at: Date.now() } });
  }, [running, path, report]);

  const start = () => {
    meter.current = new BenchmarkMeter();
    setReport(meter.current.report());
    setCopied(false);
    setRun((n) => n + 1);
    setRunning(true);
  };

  const onCode = useCallback((text: string) => meter.current.pushCode(text), []);
  const onImage = useCallback(async (image: RgbaImage) => meter.current.pushImage(image), []);

  const lockLine = lock ? `locked ${lock.locked.join(", ") || "nothing"}${lock.bias !== undefined ? ` · bias ${lock.bias}` : ""}${lock.exposure ? ` · 1/${Math.round(1 / lock.exposure.durationS)} s ISO ${lock.exposure.iso}` : ""}` : "auto focus/exposure";
  const cameraLine = cameraFps ? `camera ${cameraFps} fps (reads cleanly up to ${Math.floor(cameraFps / 2)} frames/s)` : "camera fps unknown";
  const full = report ? { ...report, device: `${deviceLine()} · ${cameraLine} · ${lockLine}` } : null;
  const overlay = report ? <LiveNumbers r={report} lock={`${cameraLine} · ${lockLine}`} /> : null;

  return (
    <Stack>
      <Segmented
        label="Decoder"
        value={path}
        onChange={(v) => {
          setPath(v);
          setRunning(false);
        }}
        options={[
          ["codes", "QR (system detector)"],
          ["pixels", "Grid (JavaScript)"],
        ]}
      />
      {!running ? <Button title={report ? "Film again" : "Start filming"} tone="primary" onPress={start} testID="bench-film" /> : null}
      {running ? (
        path === "codes" ? (
          <CodeCamera key={run} onCode={onCode} onLock={setLock} onCameraFps={setCameraFps} overlay={overlay} label="Camera view of the test stream" />
        ) : (
          <PixelCamera key={run} onImage={onImage} overlay={overlay} label="Camera view of the test stream" />
        )
      ) : null}
      {running ? <Button title="Stop" tone="ghost" onPress={() => setRunning(false)} /> : null}
      {full ? (
        <Card>
          <P tone={full.stage === "failed" ? "danger" : full.stage === "verified" ? "ok" : "default"}>{full.verdict}</P>
          <Progress fraction={full.fraction} label={`${full.symbolsReceived}/${full.symbolsNeeded || "?"} symbols`} />
          <Text selectable style={{ fontFamily: fonts.mono, fontSize: 12, color: "#CFC4B8", lineHeight: 18 }}>
            {formatBenchmarkReport(full)}
          </Text>
          <Row>
            <Button small title={copied ? "Copied" : "Copy report"} onPress={() => void Clipboard.setStringAsync(`${formatBenchmarkReport(full)}\n\n${JSON.stringify(full)}`).then(() => setCopied(true))} />
            <Button small tone="ghost" title="Share" onPress={() => void Share.share({ message: formatBenchmarkReport(full) })} />
          </Row>
        </Card>
      ) : null}
    </Stack>
  );
}

function LiveNumbers({ r, lock }: { r: BenchmarkReport; lock: string }) {
  return (
    <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: "#F4EDE4" }}>
      {`${r.inputs} read · ${r.validFrames} valid · ${Math.round(r.fraction * 100)}% · ${(r.goodputBytesPerSecond / 1024).toFixed(1)} KB/s · ${(r.elapsedMs / 1000).toFixed(0)} s\n${lock}`}
    </Text>
  );
}
