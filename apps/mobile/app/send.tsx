/**
 * One-button send with no relay and no code. The screen shows the file; the receiver points a camera
 * at it and the files show up in their inbox. Anyone who can see the screen can receive the same stream.
 */
import { describeQrStream, prepareBroadcastStream, qrStreamSetting, type FacetSender } from "@sealed/core";
import { useMemo, useState } from "react";
import { FacetStream } from "../src/components/FacetStream";
import { FilePicker } from "../src/components/FilePicker";
import { toEnvelopeInputs } from "../src/lib/files";
import { useSelection } from "../src/lib/selection";
import { useSession } from "../src/lib/session";
import { Button, Notice, P, Screen, Stack, Title, errorMessage } from "../src/ui/kit";

export default function Send() {
  const s = useSession();
  const [files, setFiles] = useSelection();
  const [sender, setSender] = useState<FacetSender | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qrStream = useMemo(() => qrStreamSetting(s.settings.qrStream), [s.settings.qrStream]);

  if (sender) {
    return (
      <Screen padded={false}>
        <FacetStream sender={sender} codesPerScreen={qrStream.codesPerScreen} caption={`Send · ${describeQrStream(qrStream)}`} onStop={() => setSender(null)} reduceMotion={s.settings.reduceMotion ?? false} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title eyebrow="Send">One button. Their inbox.</Title>
      <Notice>Anyone who can see this screen can receive these files. Nothing is uploaded.</Notice>
      <FilePicker files={files} onChange={setFiles} disabled={busy} />
      <Stack>
        <Button
          title={busy ? "Preparing…" : "Send"}
          tone="primary"
          busy={busy}
          disabled={files.length === 0}
          testID="send-direct"
          onPress={() => {
            setBusy(true);
            setError(null);
            const publisher = s.keys && s.active && s.chain ? { signing: s.keys.signing, fingerprint: s.chain.fingerprint, label: s.profile.label || "Sealed" } : undefined;
            prepareBroadcastStream({ files: toEnvelopeInputs(files), ...(publisher ? { publisher } : {}), tier: 0, qr: qrStream })
              .then((r) => setSender(r.sender))
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        />
        <P tone="subtle">Their Receive button turns the camera on. Keep this screen in view until the file shows up in their inbox.</P>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Stack>
    </Screen>
  );
}
