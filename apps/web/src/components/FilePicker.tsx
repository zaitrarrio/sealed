/** File selection: input, folder input (webkitdirectory), drag-and-drop of files and folders, and Google Drive. */
import { useRef, useState } from "react";
import { formatBytes } from "../lib/bytes";
import { dedupePaths, fromDataTransfer, fromFileList, totalSize, type PickedFile } from "../lib/files";
import { driveConfigured, pickFromDrive } from "../lib/gdrive";

export function FilePicker({ files, onChange, disabled = false }: { files: PickedFile[]; onChange: (f: PickedFile[]) => void; disabled?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [driveStatus, setDriveStatus] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);

  const add = (more: PickedFile[]) => onChange(dedupePaths([...files, ...more]));

  return (
    <div className="stack">
      <div
        className={`dropzone${over ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (disabled) return;
          void fromDataTransfer(e.dataTransfer).then(add);
        }}
      >
        <p style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 6 }}>Drop files or folders here</p>
        <p className="subtle">Everything is encrypted in this browser before it leaves.</p>
        <div className="row" style={{ justifyContent: "center", marginTop: 14 }}>
          <button type="button" className="btn" onClick={() => fileInput.current?.click()} disabled={disabled}>
            Choose files
          </button>
          <button type="button" className="btn ghost" onClick={() => folderInput.current?.click()} disabled={disabled}>
            Choose a folder
          </button>
          {driveConfigured() && (
            <button
              type="button"
              className="btn ghost"
              disabled={disabled || driveStatus !== null}
              onClick={() => {
                setDriveError(null);
                setDriveStatus("Opening Google Drive…");
                void pickFromDrive((done, total) => setDriveStatus(`Downloading from Drive ${done} of ${total}…`))
                  .then(add)
                  .catch((e: unknown) => setDriveError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setDriveStatus(null));
              }}
            >
              Google Drive
            </button>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            if (e.target.files) add(fromFileList(e.target.files));
            e.target.value = "";
          }}
        />
        <input
          ref={(el) => {
            folderInput.current = el;
            if (el) {
              el.setAttribute("webkitdirectory", "");
              el.setAttribute("directory", "");
            }
          }}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) add(fromFileList(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
      {driveStatus && <p className="subtle" role="status">{driveStatus}</p>}
      {driveError && (
        <div className="notice danger" role="alert">
          {driveError}
        </div>
      )}
      {files.length > 0 && (
        <div className="stack">
          <div className="row between">
            <strong>
              {files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(totalSize(files))}
            </strong>
            <button type="button" className="btn small ghost" onClick={() => onChange([])} disabled={disabled}>
              Clear
            </button>
          </div>
          <ul className="list" aria-label="Selected files">
            {files.slice(0, 200).map((f, i) => (
              <li key={`${f.path}-${i}`}>
                <span className="grow truncate" title={f.path}>
                  {f.path}
                  {f.source === "gdrive" && <span className="badge" style={{ marginLeft: 8 }}>Drive</span>}
                </span>
                <span className="subtle mono">{formatBytes(f.size)}</span>
                <button type="button" className="btn small ghost" aria-label={`Remove ${f.path}`} disabled={disabled} onClick={() => onChange(files.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </li>
            ))}
            {files.length > 200 && <li className="subtle">and {files.length - 200} more</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
