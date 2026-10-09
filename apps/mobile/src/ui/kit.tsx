/** Presentational building blocks shared by every screen, styled from @sealed/tokens. */
import { HARDWARE_PROTECTIONS, type KeyProtection } from "@sealed/core";
import { color, radius, size, space } from "@sealed/tokens";
import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { percent } from "../lib/bytes";

export const fonts = {
  display: "Fraunces_600SemiBold",
  displayLight: "Fraunces_400Regular",
  body: "DMSans_400Regular",
  bodyBold: "DMSans_700Bold",
  mono: "JetBrainsMono_400Regular",
  monoBold: "JetBrainsMono_600SemiBold",
} as const;

export function Screen({ children, scroll = true, padded = true }: { children: ReactNode; scroll?: boolean; padded?: boolean }) {
  const inner = <View style={[styles.stackLg, padded && styles.padded]}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={["bottom", "left", "right"]}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {inner}
        </ScrollView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
}

export function Stack({ children, gap = space.md, style }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ gap }, style]}>{children}</View>;
}

export function Row({ children, gap = space.sm, between = false, wrap = true, style }: { children: ReactNode; gap?: number; between?: boolean; wrap?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap, flexWrap: wrap ? "wrap" : "nowrap" }, between && { justifyContent: "space-between" }, style]}>{children}</View>;
}

export function Title({ children, eyebrow }: { children: ReactNode; eyebrow?: string }) {
  return (
    <View style={{ gap: 4 }}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <Text style={styles.h1} accessibilityRole="header">
        {children}
      </Text>
    </View>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.h2} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <Text style={styles.eyebrow}>{typeof children === "string" ? children.toUpperCase() : children}</Text>;
}

export function P({ children, tone = "muted", style, mono = false, selectable = false }: { children: ReactNode; tone?: "default" | "muted" | "subtle" | "danger" | "ok"; style?: StyleProp<TextStyle>; mono?: boolean; selectable?: boolean }) {
  const c = tone === "default" ? color.text : tone === "muted" ? color.textMuted : tone === "subtle" ? color.textSubtle : tone === "danger" ? color.danger : color.success;
  return (
    <Text selectable={selectable} style={[styles.p, { color: c }, mono && { fontFamily: fonts.mono, fontSize: size.sm }, style]}>
      {children}
    </Text>
  );
}

export function B({ children }: { children: ReactNode }) {
  return <Text style={{ fontFamily: fonts.bodyBold, color: color.text }}>{children}</Text>;
}

type ButtonTone = "primary" | "default" | "ghost" | "danger";

export function Button({
  title,
  onPress,
  tone = "default",
  disabled = false,
  busy = false,
  small = false,
  block = false,
  testID,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  block?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const off = disabled || busy;
  const bg = tone === "primary" ? color.amber : tone === "danger" ? color.crimsonDeep : tone === "ghost" ? "transparent" : color.bgRaised;
  const fg = tone === "primary" ? color.ink : color.text;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      accessibilityLabel={accessibilityLabel ?? title}
      testID={testID}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        block && { alignSelf: "stretch" },
        { backgroundColor: bg, borderColor: tone === "ghost" || tone === "default" ? color.line : bg, opacity: off ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text style={[styles.btnText, small && { fontSize: size.sm }, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

/** A large navigational tile (home screen actions). */
export function Tile({ title, desc, onPress, primary = false, testID, right }: { title: string; desc?: string; onPress: () => void; primary?: boolean; testID?: string; right?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      testID={testID}
      style={({ pressed }) => [styles.tile, primary && { borderColor: color.amber, backgroundColor: color.amberSoft }, pressed && { opacity: 0.8 }]}
    >
      <Row between wrap={false}>
        <Text style={[styles.tileTitle, primary && { color: color.amber }]}>{title}</Text>
        {right ? <Text style={styles.subtleSm}>{right}</Text> : null}
      </Row>
      {desc ? <Text style={styles.tileDesc}>{desc}</Text> : null}
    </Pressable>
  );
}

export function Card({ children, tone = "raised", style }: { children: ReactNode; tone?: "raised" | "sunken" | "danger"; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        styles.card,
        tone === "sunken" && { backgroundColor: color.bgSunken },
        tone === "danger" && { borderColor: color.crimson },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "danger" | "ok"; children: ReactNode }) {
  const border = tone === "danger" ? color.crimson : tone === "ok" ? color.success : color.line;
  return (
    <View style={[styles.notice, { borderLeftColor: border }]} accessibilityRole={tone === "danger" ? "alert" : undefined} accessibilityLiveRegion={tone === "danger" ? "assertive" : "polite"}>
      {typeof children === "string" ? <Text style={[styles.p, { color: tone === "danger" ? color.crimsonText : color.textMuted }]}>{children}</Text> : children}
    </View>
  );
}

/** Six-digit check code, large and monospaced; read aloud digit by digit. */
export function CheckCode({ value, label = "Check code", small = false, testID }: { value: string; label?: string; small?: boolean; testID?: string }) {
  const spoken = value.replace(/\s+/g, "").split("").join(" ");
  return (
    <View style={{ gap: 4 }} accessible accessibilityLabel={`${label}: ${spoken}`}>
      <Eyebrow>{label}</Eyebrow>
      <Text style={[styles.checkCode, small && { fontSize: size.xl }]} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

export function ProtectionBadge({ protection }: { protection: KeyProtection }) {
  const hw = HARDWARE_PROTECTIONS.includes(protection);
  return <Badge tone={hw ? "ok" : "warn"}>{hw ? "hardware-protected" : protection === "browser" ? "browser key" : "software key"}</Badge>;
}

export function Badge({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "ok" | "warn" | "bad" }) {
  const c = tone === "ok" ? color.success : tone === "warn" ? color.amber : tone === "bad" ? color.crimsonText : color.textSubtle;
  return (
    <View style={[styles.badge, { borderColor: c }]}>
      <Text style={[styles.badgeText, { color: c }]}>{children}</Text>
    </View>
  );
}

export function Progress({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.max(0, Math.min(1, fraction));
  return (
    <View style={{ gap: 6 }} accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: Math.floor(pct * 100) }}>
      <Row between>
        <Text style={styles.subtleSm}>{label}</Text>
        <Text style={[styles.subtleSm, { fontFamily: fonts.mono }]}>{percent(pct)}</Text>
      </Row>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct * 100}%` }]} />
      </View>
    </View>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }} accessible accessibilityLabel={label}>
      <ActivityIndicator color={color.amber} />
      <Text style={[styles.p, { color: color.textMuted }]}>{label}</Text>
    </View>
  );
}

export function Field({ label, hint, ...input }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={color.textSubtle} style={styles.input} accessibilityLabel={label} {...input} />
      {hint ? <Text style={styles.subtleSm}>{hint}</Text> : null}
    </View>
  );
}

export function Toggle({ label, detail, value, onChange, testID }: { label: string; detail?: string; value: boolean; onChange: (v: boolean) => void; testID?: string }) {
  return (
    <Pressable onPress={() => onChange(!value)} style={styles.toggle} accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontFamily: fonts.bodyBold, color: color.text, fontSize: size.md }}>{label}</Text>
        {detail ? <Text style={styles.subtleSm}>{detail}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: color.amber, false: color.line }} thumbColor={color.text} testID={testID} />
    </Pressable>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map(([v, l]) => (
        <Pressable
          key={v}
          onPress={() => onChange(v)}
          accessibilityRole="radio"
          accessibilityState={{ checked: v === value }}
          style={[styles.segment, v === value && { backgroundColor: color.amberSoft, borderColor: color.amber }]}
        >
          <Text style={{ color: v === value ? color.amber : color.textMuted, fontFamily: fonts.bodyBold, fontSize: size.sm }}>{l}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A row in a list: main content on the left, actions on the right. */
export function ListRow({ children, right, testID }: { children: ReactNode; right?: ReactNode; testID?: string }) {
  return (
    <View style={styles.listRow} testID={testID}>
      <View style={{ flex: 1, gap: 4 }}>{children}</View>
      {right ? <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>{right}</View> : null}
    </View>
  );
}

export function Disclosure({ title, children, initiallyOpen = false }: { title: string; children: ReactNode; initiallyOpen?: boolean }) {
  return <DisclosureImpl title={title} initiallyOpen={initiallyOpen}>{children}</DisclosureImpl>;
}

function DisclosureImpl({ title, children, initiallyOpen }: { title: string; children: ReactNode; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={{ gap: space.sm }}>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <Text style={styles.subtleSm}>
          {open ? "▾" : "▸"} {title}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  scrollContent: { flexGrow: 1 },
  padded: { padding: space.lg, paddingBottom: space.xxxl },
  stackLg: { gap: space.xl },
  h1: { fontFamily: fonts.display, fontSize: size.xl, lineHeight: size.xl * 1.2, color: color.text },
  h2: { fontFamily: fonts.display, fontSize: size.lg, color: color.text },
  eyebrow: { fontFamily: fonts.bodyBold, fontSize: size.xs, letterSpacing: 1.2, color: color.amber },
  p: { fontFamily: fonts.body, fontSize: size.md, lineHeight: size.md * 1.45 },
  subtleSm: { fontFamily: fonts.body, fontSize: size.sm, color: color.textSubtle },
  label: { fontFamily: fonts.bodyBold, fontSize: size.sm, color: color.textMuted },
  btn: {
    minHeight: 48,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  btnSmall: { minHeight: 36, paddingHorizontal: space.md },
  btnText: { fontFamily: fonts.bodyBold, fontSize: size.md },
  tile: { padding: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, backgroundColor: color.bgRaised, gap: 6 },
  tileTitle: { fontFamily: fonts.display, fontSize: size.lg, color: color.text },
  tileDesc: { fontFamily: fonts.body, fontSize: size.sm, color: color.textMuted, lineHeight: size.sm * 1.4 },
  card: { padding: space.lg, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.bgRaised, gap: space.md },
  notice: { padding: space.md, borderRadius: radius.sm, backgroundColor: color.bgRaised, borderLeftWidth: 3 },
  checkCode: { fontFamily: fonts.monoBold, fontSize: size.xxl, letterSpacing: 4, color: color.amber },
  badge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start" },
  badgeText: { fontFamily: fonts.bodyBold, fontSize: size.xs },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: color.bgSunken, overflow: "hidden" },
  progressFill: { height: 6, backgroundColor: color.amber },
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.bgSunken,
    color: color.text,
    paddingHorizontal: space.md,
    fontFamily: fonts.body,
    fontSize: size.md,
  },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm },
  segmented: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  segment: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.line },
  listRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
});
