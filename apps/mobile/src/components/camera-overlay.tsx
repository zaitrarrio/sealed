/**
 * Visual viewfinder reticle and transmission lock indicator for camera capture.
 *
 * Shows:
 * 1. Target framing guide (corners) to help the user align the sender's screen at the ideal 8–12 in distance.
 * 2. Prominent transmission lock badge showing when a stream is locked, its stream ID, tier, and calibration.
 * 3. Optical lock status (focus/exposure lock and shutter speed).
 * 4. Tap-to-focus ring when the user taps anywhere on the viewfinder.
 */
import { color, radius, size } from "@sealed/tokens";
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { fonts } from "../ui/kit";

export interface StreamInfo {
  streamId?: string | null;
  tier?: number | null;
  calibrated?: boolean;
  fps?: number | null;
  exposure?: string | null;
  goodputBytesPerSecond?: number | null;
}

export interface CameraOverlayProps {
  /** Whether the optical reception / stream has locked. */
  isLocked: boolean;
  /** Stream metadata once known. */
  streamInfo?: StreamInfo;
  /** Temporary coordinates of a user tap for focus confirmation. */
  tapPoint?: { x: number; y: number } | null;
  /** Optional custom bottom HUD content (progress numbers, counters). */
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function CameraOverlay({ isLocked, streamInfo, tapPoint, children, style }: CameraOverlayProps) {
  const pulseAnim = useRef(new Animated.Value(0.4)).current;
  const tapAnim = useRef(new Animated.Value(0)).current;

  // Pulse animation for the searching dot or locked border glow
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.4,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  // Flash the focus box when tapPoint changes
  useEffect(() => {
    if (!tapPoint) return;
    tapAnim.setValue(1);
    Animated.timing(tapAnim, {
      toValue: 0,
      duration: 750,
      useNativeDriver: true,
    }).start();
  }, [tapPoint, tapAnim]);

  const tierLabel = streamInfo?.tier !== undefined && streamInfo.tier !== null
    ? streamInfo.tier === 0
      ? "T0 QR"
      : `T${streamInfo.tier} Grid`
    : null;

  return (
    <View style={[StyleSheet.absoluteFill, styles.container, style]} pointerEvents="box-none">
      {/* Top Header Badge */}
      <View style={styles.topBadgeContainer} pointerEvents="none">
        {isLocked ? (
          <View style={styles.lockedBadge}>
            <View style={styles.badgeRow}>
              <View style={[styles.indicatorDot, styles.dotLocked]} />
              <Text style={styles.lockedTitle}>TRANSMISSION LOCKED</Text>
              {tierLabel ? <Text style={styles.tierPill}>{tierLabel}</Text> : null}
            </View>
            <View style={styles.detailRow}>
              {streamInfo?.streamId ? (
                <Text style={styles.detailText}>Stream #{streamInfo.streamId.slice(0, 8)}</Text>
              ) : null}
              {streamInfo?.calibrated ? (
                <Text style={styles.calibratedText}>✓ Calibrated</Text>
              ) : null}
              {streamInfo?.exposure ? (
                <Text style={styles.detailText}>{streamInfo.exposure}</Text>
              ) : null}
              {streamInfo?.fps ? (
                <Text style={styles.detailText}>{streamInfo.fps} fps</Text>
              ) : null}
            </View>
          </View>
        ) : (
          <View style={styles.searchingBadge}>
            <View style={styles.badgeRow}>
              <Animated.View style={[styles.indicatorDot, styles.dotSearching, { opacity: pulseAnim }]} />
              <Text style={styles.searchingTitle}>Searching for stream…</Text>
            </View>
            <Text style={styles.searchingHint}>Hold 8–12 in away · Any angle (0°, 90°, 180°, 270°)</Text>
          </View>
        )}
      </View>

      {/* Center Framing Reticle */}
      <View style={styles.reticleContainer} pointerEvents="none">
        <View style={[styles.reticleBox, isLocked && styles.reticleBoxLocked]}>
          {/* Corner Brackets */}
          <View style={[styles.corner, styles.cornerTL, isLocked && styles.cornerLocked]} />
          <View style={[styles.corner, styles.cornerTR, isLocked && styles.cornerLocked]} />
          <View style={[styles.corner, styles.cornerBL, isLocked && styles.cornerLocked]} />
          <View style={[styles.corner, styles.cornerBR, isLocked && styles.cornerLocked]} />

          {!isLocked ? (
            <View style={styles.reticleGuidePill}>
              <Text style={styles.reticleGuideText}>Align sender's screen · Any rotation</Text>
            </View>
          ) : (
            <View style={[styles.reticleGuidePill, { backgroundColor: "rgba(6, 78, 59, 0.8)", borderColor: "rgba(52, 211, 153, 0.3)" }]}>
              <Text style={[styles.reticleGuideText, { color: "#34D399" }]}>
                {streamInfo?.goodputBytesPerSecond
                  ? `✓ Locked · ${(streamInfo.goodputBytesPerSecond / 1024).toFixed(1)} KB/s`
                  : "✓ Transmission Locked"}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Tap-to-Focus Indicator */}
      {tapPoint ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.tapFocusRing,
            {
              left: tapPoint.x - 28,
              top: tapPoint.y - 28,
              opacity: tapAnim,
              transform: [
                {
                  scale: tapAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1.2, 0.9],
                  }),
                },
              ],
            },
          ]}
        >
          <View style={styles.tapFocusCenter} />
        </Animated.View>
      ) : null}

      {/* Bottom HUD / Custom Overlay */}
      {children ? (
        <View style={styles.bottomOverlay} pointerEvents="none">
          {children}
        </View>
      ) : null}
    </View>
  );
}

const BRACKET_SIZE = 26;
const BRACKET_THICKNESS = 3;

const styles = StyleSheet.create({
  container: {
    justifyContent: "space-between",
  },
  topBadgeContainer: {
    paddingTop: 12,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  searchingBadge: {
    backgroundColor: "rgba(11, 9, 8, 0.82)",
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "rgba(90, 80, 72, 0.5)",
    alignItems: "center",
    gap: 2,
  },
  searchingTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: size.xs,
    color: color.text,
    letterSpacing: 0.5,
  },
  searchingHint: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: color.textSubtle,
  },
  lockedBadge: {
    backgroundColor: "rgba(20, 17, 15, 0.94)",
    borderRadius: radius.md,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    borderColor: color.amber,
    alignItems: "center",
    gap: 4,
    shadowColor: color.amber,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  indicatorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotSearching: {
    backgroundColor: color.amber,
  },
  dotLocked: {
    backgroundColor: color.success,
  },
  lockedTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: size.xs,
    color: color.amber,
    letterSpacing: 1,
  },
  tierPill: {
    fontFamily: fonts.monoBold,
    fontSize: 10,
    color: color.ink,
    backgroundColor: color.amber,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  detailText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: color.textMuted,
  },
  calibratedText: {
    fontFamily: fonts.monoBold,
    fontSize: 10,
    color: color.success,
  },
  reticleContainer: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  reticleBox: {
    width: "72%",
    aspectRatio: 1,
    maxWidth: 320,
    maxHeight: 320,
    position: "relative",
    justifyContent: "center",
    alignItems: "center",
  },
  reticleBoxLocked: {
    backgroundColor: "rgba(232, 163, 61, 0.05)",
  },
  corner: {
    position: "absolute",
    width: BRACKET_SIZE,
    height: BRACKET_SIZE,
    borderColor: "rgba(244, 237, 228, 0.4)",
  },
  cornerLocked: {
    borderColor: color.amber,
    shadowColor: color.amber,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 5,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: BRACKET_THICKNESS,
    borderLeftWidth: BRACKET_THICKNESS,
    borderTopLeftRadius: 6,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: BRACKET_THICKNESS,
    borderRightWidth: BRACKET_THICKNESS,
    borderTopRightRadius: 6,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: BRACKET_THICKNESS,
    borderLeftWidth: BRACKET_THICKNESS,
    borderBottomLeftRadius: 6,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: BRACKET_THICKNESS,
    borderRightWidth: BRACKET_THICKNESS,
    borderBottomRightRadius: 6,
  },
  reticleGuidePill: {
    backgroundColor: "rgba(11, 9, 8, 0.65)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  reticleGuideText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: color.textSubtle,
  },
  tapFocusRing: {
    position: "absolute",
    width: 56,
    height: 56,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: color.amber,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(232, 163, 61, 0.15)",
  },
  tapFocusCenter: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.amber,
  },
  bottomOverlay: {
    padding: 12,
    backgroundColor: "rgba(11, 9, 8, 0.82)",
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
});
