/** Applies @sealed/tokens to CSS custom properties and loads the Google Fonts stylesheet. */
import { color, fontStack, googleFontsHref, radius } from "@sealed/tokens";

export function applyTheme(doc: Document = document): void {
  const root = doc.documentElement.style;
  const map: Record<string, string> = {
    "--bg": color.bg,
    "--bg-raised": color.bgRaised,
    "--bg-sunken": color.bgSunken,
    "--line": color.line,
    "--line-strong": color.lineStrong,
    "--text": color.text,
    "--text-muted": color.textMuted,
    "--text-subtle": color.textSubtle,
    "--amber": color.amber,
    "--amber-soft": color.amberSoft,
    "--crimson": color.crimson,
    "--crimson-deep": color.crimsonDeep,
    "--crimson-text": color.crimsonText,
    "--success": color.success,
    "--paper": color.paper,
    "--ink": color.ink,
    "--font-display": fontStack.display,
    "--font-body": fontStack.body,
    "--font-mono": fontStack.mono,
    "--r-sm": `${radius.sm}px`,
    "--r-md": `${radius.md}px`,
    "--r-lg": `${radius.lg}px`,
  };
  for (const [k, v] of Object.entries(map)) root.setProperty(k, v);
  if (!doc.querySelector(`link[data-sealed-fonts]`)) {
    for (const href of ["https://fonts.googleapis.com", "https://fonts.gstatic.com"]) {
      const pre = doc.createElement("link");
      pre.rel = "preconnect";
      pre.href = href;
      if (href.includes("gstatic")) pre.crossOrigin = "anonymous";
      doc.head.appendChild(pre);
    }
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = googleFontsHref;
    link.dataset["sealedFonts"] = "1";
    doc.head.appendChild(link);
  }
}
