/** Sealed design tokens shared by web and mobile. Warm near-black surfaces, amber and crimson accents. */
export const color = {
  bg: "#14110F",
  bgRaised: "#1E1916",
  bgSunken: "#0B0908",
  line: "#3A302A",
  lineStrong: "#5A5048",
  text: "#F4EDE4",
  textMuted: "#CFC4B8",
  textSubtle: "#9A8F84",
  amber: "#E8A33D",
  amberSoft: "#3A2A12",
  crimson: "#C2334B",
  crimsonDeep: "#9B1B30",
  crimsonText: "#E0566C",
  success: "#7FB77E",
  warning: "#E8A33D",
  danger: "#E0566C",
  paper: "#F4EDE4",
  ink: "#1F1A17",
} as const;

export const font = {
  display: "Fraunces",
  body: "DM Sans",
  mono: "JetBrains Mono",
} as const;

export const fontStack = {
  display: "'Fraunces', Georgia, serif",
  body: "'DM Sans', system-ui, -apple-system, Segoe UI, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

/** Type scale in px. */
export const size = { xs: 12, sm: 14, md: 16, lg: 20, xl: 28, xxl: 40, hero: 56 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { sm: 6, md: 12, lg: 20, pill: 999 } as const;

export const googleFontsHref =
  "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400..700&family=Fraunces:wght@300..700&family=JetBrains+Mono:wght@400;600&display=swap";
