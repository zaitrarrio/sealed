/** Small presentational building blocks shared by every screen. */
import { HARDWARE_PROTECTIONS, type KeyProtection } from "@sealed/core";
import { useEffect, useRef, type ReactNode } from "react";
import { percent } from "../lib/bytes";

/** Six-digit check code, large and monospaced; read aloud in groups by screen readers. */
export function CheckCode({ value, label = "Check code", small = false, testId }: { value: string; label?: string; small?: boolean; testId?: string }) {
  const spoken = value.replace(/\s+/g, "").split("").join(" ");
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="eyebrow">{label}</div>
      <div className={`check-code${small ? " small" : ""}`} aria-label={`${label}: ${spoken}`} role="text" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

export function ProtectionBadge({ protection }: { protection: KeyProtection }) {
  const hw = HARDWARE_PROTECTIONS.includes(protection);
  return <span className={`badge ${hw ? "hw" : "browser"}`}>{hw ? "hardware-protected" : protection === "browser" ? "browser key" : "software key"}</span>;
}

export function Progress({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.max(0, Math.min(1, fraction));
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row between subtle">
        <span>{label}</span>
        <span className="mono">{percent(pct)}</span>
      </div>
      <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(pct * 100)}>
        <span style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

export function Notice({ tone = "info", children, live = false }: { tone?: "info" | "danger" | "ok"; children: ReactNode; live?: boolean }) {
  return (
    <div className={`notice${tone === "danger" ? " danger" : tone === "ok" ? " ok" : ""}`} role={tone === "danger" ? "alert" : live ? "status" : undefined}>
      {children}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="row" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label}</span>
    </span>
  );
}

/** Moves focus to the page heading on mount, so screen readers announce each new screen. */
export function PageTitle({ children, eyebrow }: { children: ReactNode; eyebrow?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h1 ref={ref} tabIndex={-1} style={{ outline: "none" }}>
        {children}
      </h1>
    </header>
  );
}

export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="3" width="26" height="26" rx="7" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <rect x="9" y="9" width="6" height="6" rx="1.5" fill="#E8A33D" />
      <rect x="17" y="9" width="6" height="6" rx="1.5" fill="#C2334B" />
      <rect x="9" y="17" width="6" height="6" rx="1.5" fill="#C2334B" />
      <rect x="17" y="17" width="6" height="6" rx="1.5" fill="#E8A33D" />
    </svg>
  );
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
