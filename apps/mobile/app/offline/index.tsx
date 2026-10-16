/** Share offline hub (spec §3.6–3.7): Secure (Air-gap) or Anyone watching (Broadcast), and the receive sides. */
import { router } from "expo-router";
import { formatBytes } from "../../src/lib/bytes";
import { totalSize } from "../../src/lib/files";
import { useSelection } from "../../src/lib/selection";
import { Button, P, Row, Screen, Stack, Tile, Title } from "../../src/ui/kit";

export default function OfflineHub() {
  const [files] = useSelection();
  return (
    <Screen>
      <Title eyebrow="Share offline">Send through the screen</Title>
      <P>No network is needed on either device. The file streams as coloured frames from this screen to the other device's camera.</P>
      {files.length > 0 ? <P tone="subtle">{`Using your selection: ${files.length} ${files.length === 1 ? "file" : "files"} · ${formatBytes(totalSize(files))}`}</P> : null}
      <Stack>
        <Tile primary title="Secure" desc="Scan the receiver's key code first. Only that device can open the stream, even if others film it." onPress={() => router.push("/offline/send")} testID="airgap-send" />
        <Tile title="Anyone watching" desc="Loop the file for everyone in view. Use only for material meant for all of them." onPress={() => router.push("/broadcast")} testID="broadcast-send" />
      </Stack>
      <Row>
        <Button title="Receive offline" onPress={() => router.push("/offline/receive")} />
        <Button title="Receive a broadcast" tone="ghost" onPress={() => router.push("/broadcast/receive")} />
        <Button title="Benchmark" tone="ghost" onPress={() => router.push("/bench")} />
      </Row>
    </Screen>
  );
}
