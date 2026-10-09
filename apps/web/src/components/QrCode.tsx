/**
 * A QR code rendered as crisp SVG with the `qrcode` package (EC level M, spec §6.1.1). Dark modules use the
 * house ink on a paper background for reliable scanning on any camera.
 */
import { color } from "@sealed/tokens";
import { create } from "qrcode";
import { useMemo } from "react";

export function qrPath(text: string, level: "L" | "M" | "Q" | "H" = "M"): { size: number; path: string } {
  const qr = create(text, { errorCorrectionLevel: level });
  const n = qr.modules.size;
  const d = qr.modules.data;
  let path = "";
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (d[y * n + x]) {
        let w = 1;
        while (x + w < n && d[y * n + x + w]) w++;
        path += `M${x} ${y}h${w}v1h-${w}z`;
        x += w;
      } else x++;
    }
  }
  return { size: n, path };
}

export function QrCode({ text, label, small = false, testId }: { text: string; label: string; small?: boolean; testId?: string }) {
  const { size, path } = useMemo(() => qrPath(text), [text]);
  const quiet = 2;
  const vb = size + quiet * 2;
  return (
    <div className={`qr-frame${small ? " small" : ""}`} data-testid={testId} data-code={text}>
      <svg viewBox={`${-quiet} ${-quiet} ${vb} ${vb}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <rect x={-quiet} y={-quiet} width={vb} height={vb} fill={color.paper} />
        <path d={path} fill={color.ink} />
      </svg>
    </div>
  );
}
