/** Creates a paper key (appends add_paper_key) and shows it exactly once, printable, as text and QR. */
import { useState } from "react";
import { newPaperKey } from "../lib/identity";
import { QrCode } from "./QrCode";
import { Notice, errorMessage } from "./ui";

export function PaperKeyCard({ onDone, skipLabel }: { onDone: () => void; skipLabel?: string }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  if (!text) {
    return (
      <div className="stack">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            data-testid="create-paper-key"
            onClick={() => {
              setBusy(true);
              setError(null);
              newPaperKey()
                .then(setText)
                .catch((e: unknown) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Creating…" : "Create paper key"}
          </button>
          {skipLabel && (
            <button type="button" className="btn ghost" onClick={onDone} disabled={busy}>
              {skipLabel}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <Notice tone="danger">This is shown once. Anyone holding this paper key can add devices to your identity. Do not photograph it or store it in a cloud note.</Notice>
      <div className="paper-key stack" data-testid="paper-key">
        <div className="row between">
          <strong style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>Sealed paper key</strong>
          <span>{new Date().toLocaleDateString()}</span>
        </div>
        <div className="words" aria-label="Paper key">
          {text}
        </div>
        <QrCode text={text} label="Paper key as a QR code" small />
      </div>
      <div className="row no-print">
        <button type="button" className="btn" onClick={() => window.print()}>
          Print
        </button>
        <label className="toggle">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I have printed or written it down
        </label>
      </div>
      <button
        type="button"
        className="btn primary no-print"
        disabled={!confirmed}
        onClick={() => {
          setText(null);
          onDone();
        }}
      >
        Done
      </button>
    </div>
  );
}
