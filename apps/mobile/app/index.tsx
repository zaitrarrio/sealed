/** Home: Send and Receive as the two primary actions; advanced paths stay secondary. */
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
        <Title eyebrow="Sealed">Send a file. Receive with a scan.</Title>
        <P>Receiving needs no setup: scan the sender's code. To send, set up an identity on this phone.</P>
        <Button title="Receive" tone="primary" onPress={() => router.push("/receive")} testID="action-receive" />
        <Stack>
          <Tile title="Set up to send" desc="Create an identity, add this phone to yours, or restore with a recovery phrase." onPress={() => router.push("/welcome")} />
          <Tile title="Receive offline" desc="Show your key and read a stream from the sender's screen. No network needed." onPress={() => router.push("/offline/receive")} />
          <Tile title="Received files" right={received === null ? "…" : `${received}`} onPress={() => router.push("/files")} />
          <Tile title="Settings" right="relay, security" onPress={() => router.push("/settings")} />
          <Tile title="Benchmark" right="offline speed" onPress={() => router.push("/bench")} testID="action-bench" />
        </Stack>
      </Screen>
    );
  }

  const devices = s.chain ? [...s.chain.devices.values()].filter((d) => d.revokedSeq === undefined).length : 0;
  const waiting = inbox.items.length + inbox.live.filter((l) => l.status !== "failed").length;

  return (
    <Screen>
      <Title eyebrow={s.profile.label}>Send a file. Receive with a scan.</Title>
      {!s.active ? <Notice tone="danger">This phone is no longer an active device of your identity (it may have been revoked). Sending is disabled. You can still receive.</Notice> : null}
      <Stack>
        <Tile
          primary
          title="Send"
          desc={'Drop files and show a code. Turn on "Allow multiple people" for a room.'}
          onPress={() => router.push("/share")}
          testID="action-share"
        />
        <Tile title="Receive" desc="Point your camera at a Sealed code." onPress={() => router.push("/receive")} testID="action-receive" />
      </Stack>
      <Stack>
        <Tile title="No network — stream through the screen" desc="When neither device can reach the internet." onPress={() => router.push("/offline")} testID="action-offline" />
        <Tile title="Inbox" right={`${waiting} waiting`} onPress={() => router.push("/inbox")} />
        <Tile title="Contacts" right={contacts === null ? "…" : `${contacts} paired`} onPress={() => router.push("/contacts")} />
        <Tile title="Received files" right={received === null ? "…" : `${received}`} onPress={() => router.push("/files")} />
        <Tile title="Devices" right={`${devices} active`} onPress={() => router.push("/devices")} />
        <Tile title="Settings" right="relay, security" onPress={() => router.push("/settings")} />
          <Tile title="Benchmark" right="offline speed" onPress={() => router.push("/bench")} testID="action-bench" />
      </Stack>
    </Screen>
  );
}
