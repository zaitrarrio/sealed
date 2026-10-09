/** Lists decrypted files with Save per file and Save all (zip). */
import { useState } from "react";
import { formatBytes } from "../lib/bytes";
import { baseName, saveBlob, zipFiles, type ReceivedFile } from "../lib/received";

export function ReceivedFiles({ files, zipName = "sealed-files.zip" }: { files: ReceivedFile[]; zipName?: string }) {
  const [zipping, setZipping] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack">
      <ul className="list" aria-label="Received files">
        {files.map((f, i) => (
          <li key={`${f.path}-${i}`}>
            <span className="grow truncate" title={f.path}>
              {f.path}
            </span>
            <span className="subtle mono">{formatBytes(f.size)}</span>
            <button
              type="button"
              className="btn small"
              data-testid={`save-${i}`}
              onClick={() => {
                void f
                  .blob()
                  .then((b) => saveBlob(b, baseName(f.path)))
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
              }}
            >
              Save
            </button>
          </li>
        ))}
      </ul>
      {files.length > 1 && (
        <button
          type="button"
          className="btn primary block"
          disabled={zipping !== null}
          data-testid="save-all"
          onClick={() => {
            setZipping(0);
            setError(null);
            void zipFiles(files, (d, t) => setZipping(t ? d / t : 1))
              .then((b) => saveBlob(b, zipName))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setZipping(null));
          }}
        >
          {zipping === null ? `Save all (${formatBytes(files.reduce((a, f) => a + f.size, 0))} zip)` : `Preparing zip ${Math.floor(zipping * 100)}%`}
        </button>
      )}
      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
      <p className="subtle">Saved copies are ordinary files on this device. Sealed cannot recall them.</p>
    </div>
  );
}
