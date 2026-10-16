/** Share offline · Anyone watching (Broadcast, spec §3.7, §6.6): a looping, unencrypted-to-anyone stream. */
import { prepareBroadcastStream, type FacetSender } from "@sealed/core";
import { useState } from "react";
import { FacetStream } from "../../src/components/FacetStream";
import { FilePicker } from "../../src/components/FilePicker";
import { toEnvelopeInputs } from "../../src/lib/files";
import { useSelection } from "../../src/lib/selection";
import { useSession } from "../../src/lib/session";
import { B, Button, Card, Notice, P, Screen, Title, Toggle, errorMessage } from "../../src/ui/kit";

export default function BroadcastSend() {
  const s = useSession();
  const [files, setFiles] = useSelection();
  const [sign, setSign] = useState(Boolean(s.active));
  const [acknowledged, setAcknowledged] = useState(false);
  const [sender, setSender] = useState<FacetSender | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sender) {
    return (
      <Screen padded={false}>
        <FacetStream sender={sender} caption="broadcast" onStop={() => setSender(null)} reduceMotion={s.settings.reduceMotion ?? false} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title eyebrow="Share offline · Anyone watching">Broadcast to everyone in view</Title>
      <Card tone="danger">
        <B>Anyone who can see this screen can receive these files.</B>
        <P>The stream loops and is not encrypted to anyone. Cameras across the room, recordings and reflections all work. Use it only for material meant for everyone present.</P>
      </Card>
      <FilePicker files={files} onChange={setFiles} disabled={busy} />
      <Toggle label="Sign as me" detail="Receivers who paired with you see “Signed by” your name." value={sign && s.active} onChange={(v) => setSign(v && s.active)} />
      <Toggle label="I understand anyone in view can receive these files" value={acknowledged} onChange={setAcknowledged} testID="broadcast-ack" />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        title={busy ? "Preparing…" : "Start broadcast"}
        tone="primary"
        busy={busy}
        disabled={!acknowledged || files.length === 0}
        testID="start-broadcast"
        onPress={() => {
          setBusy(true);
          setError(null);
          const publisher = sign && s.keys && s.chain ? { signing: s.keys.signing, fingerprint: s.chain.fingerprint, label: s.profile.label } : undefined;
          prepareBroadcastStream({ files: toEnvelopeInputs(files), ...(publisher ? { publisher } : {}), tier: 0 })
            .then((r) => setSender(r.sender))
            .catch((e: unknown) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      />
    </Screen>
  );
}
