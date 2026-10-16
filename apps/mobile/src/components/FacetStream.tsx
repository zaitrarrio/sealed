/**
 * Full-screen Facet stream (spec §7.3, §10.3), drawn with Skia. Frames advance by counting presented display
 * refreshes (requestAnimationFrame callbacks), never by timers; holds scale with the measured refresh rate, so a
 * 120 Hz panel doubles every hold. The screen is kept awake and at full brightness while streaming (restored
 * afterwards). With Reduce Motion on, the stream waits behind a flashing-content confirmation.
 *
 * QR (T0) streams are drawn as vector paths straight from each code's module matrix — no RGBA rasterization in
 * JavaScript — and may show several codes per screen (ADR-0019), each a different frame of the stream. The next
 * batch is prepared right after a batch is shown, while the display holds it, so encoding overlaps the hold.
 * Grid streams are rasterized and scaled with nearest-neighbour sampling.
 */
import { AlphaType, Canvas, ColorType, FilterMode, Image, MipmapMode, Path, Rect, Skia, type SkImage, type SkPath } from "@shopify/react-native-skia";
import type { FacetFrame, FacetSender } from "@sealed/core";
import { FACET_BACKGROUND } from "@sealed/core";
import { color } from "@sealed/tokens";
import * as Brightness from "expo-brightness";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, PixelRatio, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { useAppActive } from "../lib/app-state";
import { FrameScheduler, layoutCodes, streamSizePx, type CodeSlot } from "../lib/frame-scheduler";
import { Button, Card, H2, P, Row, fonts } from "../ui/kit";

/** Upper bound on rendered grid-frame pixels per side (scaled to the display by Skia). */
const MAX_RENDER_PX = 768;
/** QR quiet zone, in modules, on each side (ISO/IEC 18004). */
const QUIET = 4;
export const MAX_CODES_PER_SCREEN = 4;

function toSkImage(rgba: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }): SkImage | null {
  const bytes = rgba.data instanceof Uint8Array ? rgba.data : new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength);
  const data = Skia.Data.fromBytes(bytes);
  return Skia.Image.MakeImage({ width: rgba.width, height: rgba.height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }, data, rgba.width * 4);
}

/**
 * Dark modules of a QR code as one path in canvas units, each module a whole number of device pixels (sharp
 * edges, no anti-aliasing seams). Horizontal runs are merged into single rectangles.
 */
function qrPath(m: { size: number; modules: Uint8Array }, slot: CodeSlot, dpr: number): SkPath {
  const span = m.size + 2 * QUIET;
  const modulePx = Math.max(1, Math.floor((slot.side * dpr) / span));
  const unit = modulePx / dpr;
  const offset = (slot.side - span * unit) / 2;
  const x0 = slot.x + offset + QUIET * unit;
  const y0 = slot.y + offset + QUIET * unit;
  const path = Skia.Path.Make();
  const n = m.size;
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (m.modules[y * n + x]) {
        let w = 1;
        while (x + w < n && m.modules[y * n + x + w]) w++;
        path.addRect(Skia.XYWHRect(x0 + x * unit, y0 + y * unit, w * unit, unit));
        x += w;
      } else x++;
    }
  }
  return path;
}

export function FacetStream({
  sender,
  onStop,
  caption,
  reduceMotion,
  codesPerScreen = 1,
}: {
  sender: FacetSender;
  onStop: () => void;
  caption?: string;
  reduceMotion?: boolean;
  /** QR streams only: codes drawn side by side, each a different frame (1, 2 or 4). */
  codesPerScreen?: number;
}) {
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
          The stream shows rapidly changing patterns, 10 to 30 frames per second. Reduce Motion is on, so the stream is paused. Start it only if flashing content is safe for you, and look away from
          the screen while it runs.
        </P>
        <Row>
          <Button title="Start the stream" tone="primary" onPress={() => setConfirmed(true)} testID="confirm-flashing" />
          <Button title="Cancel" tone="ghost" onPress={onStop} />
        </Row>
      </Card>
    );
  }
  const codes = sender.tier === 0 ? Math.max(1, Math.min(MAX_CODES_PER_SCREEN, Math.floor(codesPerScreen))) : 1;
  return <Stage sender={sender} onStop={onStop} codes={codes} {...(caption ? { caption } : {})} />;
}

interface Stats {
  hz: number;
  fps: number;
  hold: number;
  frames: number;
  drawMs: number;
  finished: boolean;
}

function Stage({ sender, onStop, caption, codes }: { sender: FacetSender; onStop: () => void; caption?: string; codes: number }) {
  useKeepAwake("sealed-facet-stream");
  const { width, height } = useWindowDimensions();
  const active = useAppActive();
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<Stats>({ hz: 60, fps: 0, hold: 0, frames: 0, drawMs: 0, finished: false });
  const dpr = PixelRatio.get();
  const vector = sender.tier === 0;
  // Area for the codes: full width, most of the height (the HUD sits below).
  const areaW = Math.floor(width - 16);
  const areaH = Math.floor(height * 0.72);
  const slots = useMemo(() => (vector ? layoutCodes(codes, areaW, areaH, 8) : [{ x: 0, y: 0, side: streamSizePx(width, height * 0.8, 1, 8) }]), [vector, codes, areaW, areaH, width, height]);
  const canvasW = vector ? areaW : (slots[0]?.side ?? 0);
  const canvasH = vector ? Math.max(...slots.map((s) => s.y + s.side), 0) : (slots[0]?.side ?? 0);
  const renderPx = Math.min(MAX_RENDER_PX, streamSizePx(width, height * 0.8, dpr, 8));

  // Fixed number of hooks: one path per possible code, plus the grid image.
  const empty = useMemo(() => Skia.Path.Make(), []);
  const p0 = useSharedValue<SkPath>(empty);
  const p1 = useSharedValue<SkPath>(empty);
  const p2 = useSharedValue<SkPath>(empty);
  const p3 = useSharedValue<SkPath>(empty);
  const paths: SharedValue<SkPath>[] = [p0, p1, p2, p3];
  const image = useSharedValue<SkImage | null>(null);
  // Recently shown images: the UI thread may still be drawing the previous one, so an image is disposed only
  // after two newer frames have replaced it.
  const recent = useRef<SkImage[]>([]);

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
    if (paused || !active || slots.length === 0) return;
    const scheduler = new FrameScheduler();
    let raf = 0;
    let lastStats = 0;
    let shownAtStats = 0;
    let drawMs = 0;

    /** Encodes the next batch: one frame per slot, all with the first frame's hold. */
    const prepare = (): { hold: number; paths: SkPath[]; image: SkImage | null } | null => {
      if (sender.finished) return null;
      const t0 = performance.now();
      const frames: FacetFrame[] = [];
      for (let i = 0; i < slots.length && !sender.finished; i++) frames.push(sender.next());
      const first = frames[0];
      if (!first) return null;
      let batch: { hold: number; paths: SkPath[]; image: SkImage | null };
      if (vector) {
        const ps: SkPath[] = [];
        frames.forEach((f, i) => {
          const m = sender.qrModules(f);
          const slot = slots[i];
          if (m && slot) ps.push(qrPath(m, slot, dpr));
        });
        batch = { hold: first.holdRefreshes, paths: ps, image: null };
      } else {
        batch = { hold: first.holdRefreshes, paths: [], image: toSkImage(sender.render(first, renderPx)) };
      }
      drawMs = drawMs * 0.8 + (performance.now() - t0) * 0.2;
      return batch;
    };

    const show = (b: { paths: SkPath[]; image: SkImage | null }) => {
      if (vector) {
        paths.forEach((sv, i) => {
          sv.value = b.paths[i] ?? empty;
        });
      } else {
        image.value = b.image;
        if (b.image) recent.current.push(b.image);
        while (recent.current.length > 3) recent.current.shift()?.dispose();
      }
    };

    let next = prepare();
    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      scheduler.observe(ts);
      if (!scheduler.tick()) return;
      if (!next) {
        setStats((s) => (s.finished ? s : { ...s, finished: true }));
        return;
      }
      show(next);
      scheduler.beginFrame(next.hold);
      // Encode the following batch now, while the display holds this one.
      next = prepare();
      if (ts - lastStats > 500) {
        const shown = scheduler.framesShown;
        const fps = lastStats > 0 ? ((shown - shownAtStats) * 1000) / (ts - lastStats) : 0;
        lastStats = ts;
        shownAtStats = shown;
        setStats({ hz: scheduler.refreshRate, fps, hold: scheduler.hold, frames: shown * slots.length, drawMs, finished: sender.finished });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sender, paused, active, slots, vector, renderPx, dpr]);

  useEffect(
    () => () => {
      image.value = null;
      for (const sv of paths) sv.value = empty;
      // Leave the last frames to the garbage collector: the canvas may still reference them while unmounting.
      recent.current = [];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const bg = `rgb(${FACET_BACKGROUND[0]}, ${FACET_BACKGROUND[1]}, ${FACET_BACKGROUND[2]})`;
  const nominalFps = stats.hold > 0 ? stats.hz / stats.hold : 0;
  return (
    <View style={[styles.stage, { backgroundColor: bg }]} accessible accessibilityLabel="Optical stream. Point the receiving camera at this screen.">
      <Canvas style={{ width: canvasW, height: canvasH }} testID="facet-canvas">
        {vector ? (
          slots.map((slot, i) => (
            <Rect key={`bg-${i}`} x={slot.x} y={slot.y} width={slot.side} height={slot.side} color="#FFFFFF" />
          ))
        ) : (
          <Image image={image} x={0} y={0} width={canvasW} height={canvasH} fit="fill" sampling={{ filter: FilterMode.Nearest, mipmap: MipmapMode.None }} />
        )}
        {vector ? slots.map((_, i) => <Path key={`qr-${i}`} path={paths[i] ?? empty} color={bg} antiAlias={false} />) : null}
      </Canvas>
      <View style={styles.hud}>
        <Text style={styles.hudText}>
          {caption ? `${caption} · ` : ""}
          {`${stats.fps.toFixed(0)}/${nominalFps.toFixed(0)} frames/s · ${slots.length} per screen · encode ${stats.drawMs.toFixed(0)} ms · ${stats.frames} codes shown`}
          {stats.finished ? " · stream complete" : ""}
        </Text>
        {stats.fps > 0 && nominalFps > 0 && stats.fps < nominalFps * 0.8 ? (
          <Text style={[styles.hudText, { color: color.amber }]}>This phone is not keeping up with the frame rate; choose fewer codes, a smaller QR size or fewer frames per second.</Text>
        ) : null}
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
