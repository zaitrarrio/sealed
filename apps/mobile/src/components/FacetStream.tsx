/**
 * Full-screen Facet stream (spec §7.3, §10.3), drawn with Skia. Frames advance by counting presented display
 * refreshes (requestAnimationFrame callbacks), never by timers; holds scale with the measured refresh rate, so a
 * 120 Hz panel doubles every hold. The screen is kept awake and at full brightness while streaming (restored
 * afterwards). With Reduce Motion on, the stream waits behind a flashing-content confirmation.
 *
 * Frames are rendered at a bounded pixel size and scaled up with nearest-neighbour sampling, which keeps
 * per-frame JS work small and cell edges sharp.
 */
import { AlphaType, Canvas, ColorType, FilterMode, Image, MipmapMode, Skia, type SkImage } from "@shopify/react-native-skia";
import type { FacetFrame, FacetSender } from "@sealed/core";
import { FACET_BACKGROUND } from "@sealed/core";
import { color } from "@sealed/tokens";
import * as Brightness from "expo-brightness";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, PixelRatio, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useAppActive } from "../lib/app-state";
import { FrameScheduler, streamSizePx } from "../lib/frame-scheduler";
import { Button, Card, H2, P, Row, fonts } from "../ui/kit";

/** Upper bound on rendered frame pixels per side (scaled to the display by Skia). */
const MAX_RENDER_PX = 768;

function toSkImage(rgba: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }): SkImage | null {
  const bytes = rgba.data instanceof Uint8Array ? rgba.data : new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength);
  const data = Skia.Data.fromBytes(bytes);
  return Skia.Image.MakeImage({ width: rgba.width, height: rgba.height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }, data, rgba.width * 4);
}

export function FacetStream({ sender, onStop, caption, reduceMotion }: { sender: FacetSender; onStop: () => void; caption?: string; reduceMotion?: boolean }) {
  const [confirmed, setConfirmed] = useState<boolean | null>(reduceMotion ? false : null);
  useEffect(() => {
    if (confirmed !== null) return;
    void AccessibilityInfo.isReduceMotionEnabled().then((r) => setConfirmed(!r));
  }, [confirmed]);

  if (confirmed === null) return null;
  if (!confirmed) {
    return (
      <Card>
        <H2>This screen will flash</H2>
        <P>
          The stream shows rapidly changing coloured patterns, about 10 frames per second. Reduce Motion is on, so the stream is paused. Start it only if flashing content is safe for you, and look
          away from the screen while it runs.
        </P>
        <Row>
          <Button title="Start the stream" tone="primary" onPress={() => setConfirmed(true)} testID="confirm-flashing" />
          <Button title="Cancel" tone="ghost" onPress={onStop} />
        </Row>
      </Card>
    );
  }
  return <Stage sender={sender} onStop={onStop} {...(caption ? { caption } : {})} />;
}

function Stage({ sender, onStop, caption }: { sender: FacetSender; onStop: () => void; caption?: string }) {
  useKeepAwake("sealed-facet-stream");
  const { width, height } = useWindowDimensions();
  const active = useAppActive();
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState({ hz: 60, frames: 0, hold: 0, finished: false });
  const image = useSharedValue<SkImage | null>(null);
  const sideDp = streamSizePx(width, height * 0.8, 1, 8);
  const renderPx = Math.min(MAX_RENDER_PX, streamSizePx(width, height * 0.8, PixelRatio.get(), 8));
  const lastImage = useRef<SkImage | null>(null);

  // Full brightness while streaming; the previous level is restored on exit.
  useEffect(() => {
    let previous: number | null = null;
    let cancelled = false;
    void (async () => {
      try {
        previous = await Brightness.getBrightnessAsync();
        if (!cancelled) await Brightness.setBrightnessAsync(1);
      } catch {
        // Brightness control unavailable (or permission refused on Android system brightness).
      }
    })();
    return () => {
      cancelled = true;
      if (previous !== null) void Brightness.setBrightnessAsync(previous).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (paused || !active || renderPx <= 0) return;
    const scheduler = new FrameScheduler();
    let raf = 0;
    let lastStats = 0;
    let current: FacetFrame | null = null;

    const show = (f: FacetFrame) => {
      const next = toSkImage(sender.render(f, renderPx));
      image.value = next;
      lastImage.current?.dispose();
      lastImage.current = next;
    };

    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      scheduler.observe(ts);
      if (!scheduler.tick()) return;
      if (sender.finished) {
        setStats((s) => (s.finished ? s : { ...s, finished: true }));
        return;
      }
      current = sender.next();
      show(current);
      scheduler.beginFrame(current.holdRefreshes);
      if (ts - lastStats > 500) {
        lastStats = ts;
        setStats({ hz: scheduler.refreshRate, frames: scheduler.framesShown, hold: scheduler.hold, finished: sender.finished });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sender, paused, active, renderPx, image]);

  useEffect(
    () => () => {
      lastImage.current?.dispose();
      lastImage.current = null;
    },
    [],
  );

  const bg = `rgb(${FACET_BACKGROUND[0]}, ${FACET_BACKGROUND[1]}, ${FACET_BACKGROUND[2]})`;
  return (
    <View style={[styles.stage, { backgroundColor: bg }]} accessible accessibilityLabel="Optical stream. Point the receiving camera at this screen.">
      <Canvas style={{ width: sideDp, height: sideDp }} testID="facet-canvas">
        <Image image={image} x={0} y={0} width={sideDp} height={sideDp} fit="fill" sampling={{ filter: FilterMode.Nearest, mipmap: MipmapMode.None }} />
      </Canvas>
      <View style={styles.hud}>
        <Text style={styles.hudText}>
          {caption ? `${caption} · ` : ""}
          {stats.hz} Hz · hold {stats.hold} · frame {stats.frames} · screen kept on
          {stats.finished ? " · stream complete" : ""}
        </Text>
        <Row>
          <Button small title={paused ? "Resume" : "Pause"} onPress={() => setPaused((p) => !p)} />
          <Button small tone="danger" title="Stop" onPress={onStop} testID="stop-stream" />
        </Row>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { alignItems: "center", justifyContent: "center", paddingVertical: 8, gap: 12, borderRadius: 12 },
  hud: { alignSelf: "stretch", paddingHorizontal: 12, gap: 8, backgroundColor: color.bg, paddingVertical: 8 },
  hudText: { fontFamily: fonts.mono, fontSize: 12, color: color.textSubtle },
});
