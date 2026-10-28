/** Home: one Send and one Receive. The file moves by light, with no relay and no code to scan. */
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { listContacts } from "../src/lib/contacts-store";
import { useInbox } from "../src/lib/inbox";
import { listReceived } from "../src/lib/received";
import { useSession } from "../src/lib/session";
import { Button, Notice, P, Screen, Stack, Tile, Title } from "../src/ui/kit";

export default function Home() {
  const s = useSession();
  const inbox = useInbox();
  const [contacts, setContacts] = useState<number | null>(null);
  const [received, setReceived] = useState<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      void listContacts().then((c) => setContacts(c.length));
      void listReceived().then((r) => setReceived(r.length));
    }, []),
  );

  if (!s.profile.fingerprint) {
    return (
      <Screen>
        <Title eyebrow="Sealed">Send a file. It shows up in their inbox.</Title>
        <P>No server and no code. Tap Send, and on the other phone point the camera at this screen.</P>
        <Button title="Send" tone="primary" onPress={() => router.push("/send")} testID="action-share" />
        <Button title="Receive" onPress={() => router.push({ pathname: "/inbox", params: { listen: "1" } })} testID="action-receive" />
        <Stack>
          <Tile title="Set up an identity" desc="Optional. Pairing and codes use an identity. Send and Receive do not." onPress={() => router.push("/welcome")} />
          <Tile title="Receive offline" desc="Show your key and read a stream from the sender's screen. No network needed." onPress={() => router.push("/offline/receive")} />
          <Tile title="Received files" right={received === null ? "…" : `${received}`} onPress={() => router.push("/files")} />
          <Tile title="Settings" right="security" onPress={() => router.push("/settings")} />
          <Tile title="Benchmark" right="offline speed" onPress={() => router.push("/bench")} testID="action-bench" />
        </Stack>
      </Screen>
    );
  }

  const devices = s.chain ? [...s.chain.devices.values()].filter((d) => d.revokedSeq === undefined).length : 0;
  const waiting = inbox.items.length + inbox.live.filter((l) => l.status !== "failed").length;

  return (
    <Screen>
      <Title eyebrow={s.profile.label}>Send a file. It shows up in their inbox.</Title>
      {s.profile.fingerprint && !s.active ? <Notice>This phone is no longer an active device of your identity. You can still send and receive directly.</Notice> : null}
      <Stack>
        <Tile
          primary
          title="Send"
          desc="Drop the files and tap Send. Their camera reads your screen. No server."
          onPress={() => router.push("/send")}
          testID="action-share"
        />
        <Tile title="Receive" desc={waiting > 0 ? `${waiting} already waiting. New files show up here.` : "Tap once and point your camera at their screen."} onPress={() => router.push({ pathname: "/inbox", params: { listen: "1" } })} testID="action-receive" />
      </Stack>
      <Stack>
        <Tile title="Show a code to scan" desc="For someone in the room who has not paired." onPress={() => router.push("/share")} />
        <Tile title="Scan a code" desc="Point your camera at a Sealed code." onPress={() => router.push("/receive")} />
        <Tile title="No network — stream through the screen" desc="When neither device can reach the internet." onPress={() => router.push("/offline")} testID="action-offline" />
        <Tile title="Contacts" right={contacts === null ? "…" : `${contacts} paired`} onPress={() => router.push("/contacts")} />
        <Tile title="Received files" right={received === null ? "…" : `${received}`} onPress={() => router.push("/files")} />
        <Tile title="Devices" right={`${devices} active`} onPress={() => router.push("/devices")} />
        <Tile title="Settings" right="security" onPress={() => router.push("/settings")} />
        <Tile title="Benchmark" right="offline speed" onPress={() => router.push("/bench")} testID="action-bench" />
      </Stack>
    </Screen>
  );
}
