/** Home: share, share offline, receive, and the paired-mode screens. */
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
        <Title eyebrow="Sealed">Show a code. Hand over a file.</Title>
        <P>Receiving needs no setup: scan the sender's code and approve nothing. To share, set up an identity on this phone.</P>
        <Button title="Receive — scan a code" tone="primary" onPress={() => router.push("/receive")} testID="action-receive" />
        <Stack>
          <Tile title="Set up to share" desc="Create an identity, add this phone to yours, or restore with a paper key." onPress={() => router.push("/welcome")} />
          <Tile title="Receive offline" desc="Show a key code and read a stream from the sender's screen. No network needed." onPress={() => router.push("/offline/receive")} />
          <Tile title="Received files" right={received === null ? "…" : `${received}`} onPress={() => router.push("/files")} />
          <Tile title="Settings" right="relay, security" onPress={() => router.push("/settings")} />
        </Stack>
      </Screen>
    );
  }

  const devices = s.chain ? [...s.chain.devices.values()].filter((d) => d.revokedSeq === undefined).length : 0;
  const waiting = inbox.items.length + inbox.live.filter((l) => l.status !== "failed").length;

  return (
    <Screen>
      <Title eyebrow={s.profile.label}>Show a code. Hand over a file.</Title>
      {!s.active ? <Notice tone="danger">This phone is no longer an active device of your identity (it may have been revoked). Sharing is disabled. You can still receive.</Notice> : null}
      <Stack>
        <Tile primary title="Share" desc={'Show a code; the person in front of you scans it. Turn on "Let a room join" for a whole room.'} onPress={() => router.push("/share")} testID="action-share" />
        <Tile title="Share offline" desc="Stream files through the screen to a camera. No network needed on either side." onPress={() => router.push("/offline")} testID="action-offline" />
      </Stack>
      <Button title="Receive — scan a code" onPress={() => router.push("/receive")} testID="action-receive" />
      <Stack>
        <Tile title="Inbox" right={`${waiting} waiting`} onPress={() => router.push("/inbox")} />
        <Tile title="Contacts" right={contacts === null ? "…" : `${contacts} paired`} onPress={() => router.push("/contacts")} />
        <Tile title="Received files" right={received === null ? "…" : `${received}`} onPress={() => router.push("/files")} />
        <Tile title="Devices" right={`${devices} active`} onPress={() => router.push("/devices")} />
        <Tile title="Settings" right="relay, security" onPress={() => router.push("/settings")} />
      </Stack>
    </Screen>
  );
}
