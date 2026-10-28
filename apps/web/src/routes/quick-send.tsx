/**
 * One-button send with no relay and no code. The screen shows the file; the receiver points a camera
 * at it and the files show up in their inbox. Anyone who can see the screen can receive the same stream.
 */
import { describeQrStream, prepareBroadcastStream, qrStreamSetting, type FacetSender } from "@sealed/core";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { FacetStream } from "../components/FacetStream";
import { FilePicker } from "../components/FilePicker";
import { Notice, PageTitle, errorMessage } from "../components/ui";
import { toEnvelopeInputs } from "../lib/files";
import { useSelection } from "../lib/selection";
import { useSession } from "../lib/session";

export function QuickSendPage() {
  const s = useSession();
  const [files, setFiles] = useSelection();
  const [sender, setSender] = useState<FacetSender | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qrStream = useMemo(() => qrStreamSetting(s.settings.qrStream), [s.settings.qrStream]);

  if (sender) {
    return <FacetStream sender={sender} codesPerScreen={qrStream.codesPerScreen} caption={`Send · ${describeQrStream(qrStream)}`} onStop={() => setSender(null)} />;
  }

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Send">One button. Their inbox.</PageTitle>
      <Notice>Anyone who can see this screen can receive these files. Nothing is uploaded.</Notice>
      <FilePicker files={files} onChange={setFiles} disabled={busy} />
      <button
        type="button"
        className="btn primary block"
        data-testid="send-direct"
        disabled={busy || files.length === 0}
        onClick={() => {
          setBusy(true);
          setError(null);
          const publisher = s.keys && s.active && s.chain ? { signing: s.keys.signing, fingerprint: s.chain.fingerprint, label: s.profile.label || "Sealed" } : undefined;
          prepareBroadcastStream({ files: toEnvelopeInputs(files), ...(publisher ? { publisher } : {}), tier: 0, qr: qrStream })
            .then((r) => setSender(r.sender))
            .catch((e: unknown) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Preparing…" : "Send"}
      </button>
      <p className="subtle">Their Receive button turns the camera on. Keep this screen in view until the file shows up in their inbox.</p>
      {error && <Notice tone="danger">{error}</Notice>}
      <Link to="/" className="btn ghost">
        Home
      </Link>
    </div>
  );
}
