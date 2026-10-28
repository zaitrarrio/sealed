/** Acoustic offline hub (ADR-0024): Secure or Anyone listening over the speaker. */
import { router } from "expo-router";
import { formatBytes } from "../../src/lib/bytes";
import { totalSize } from "../../src/lib/files";
import { useSelection } from "../../src/lib/selection";
import { Button, P, Row, Screen, Stack, Tile, Title } from "../../src/ui/kit";

export default function AcousticHub() {
  const [files] = useSelection();
  return (
    <Screen>
      <Title eyebrow="Share offline">Send through the speaker</Title>
      <P>No network is needed. This phone plays audible tones; the other listens with its microphone. Sound is slower than the screen — prefer the camera for large files.</P>
      {files.length > 0 ? <P tone="subtle">{`Using your selection: ${files.length} ${files.length === 1 ? "file" : "files"} · ${formatBytes(totalSize(files))}`}</P> : null}
      <Stack>
        <Tile primary title="Secure" desc="Scan their key code first. Only that device can open the tones, even if others listen." onPress={() => router.push("/acoustic/send")} testID="acoustic-airgap-send" />
        <Tile title="Anyone listening" desc="Anyone who can hear this can receive it — including through an open door." onPress={() => router.push("/acoustic/broadcast")} testID="acoustic-broadcast-send" />
      </Stack>
      <Row>
        <Button title="Receive over sound" onPress={() => router.push("/acoustic/receive")} />
        <Button title="Use the screen instead" tone="ghost" onPress={() => router.push("/offline")} />
      </Row>
    </Screen>
  );
}
