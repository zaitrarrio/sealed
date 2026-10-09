/** Contacts: pinned identities with presence, notices about device changes, and hard blocks on forks. */
import { activeDevices } from "@sealed/core";
import { color } from "@sealed/tokens";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { cachedChain, listContacts, removeContact, saveContact, type ContactRecord } from "../../src/lib/contacts-store";
import { watchContacts } from "../../src/lib/inbox";
import { ContactBlocked, refreshContact } from "../../src/lib/paired";
import { useSession } from "../../src/lib/session";
import { B, Badge, Button, Card, ListRow, Notice, P, Row, Screen, Spinner, Title, errorMessage } from "../../src/ui/kit";

export default function Contacts() {
  const s = useSession();
  const { paired } = useLocalSearchParams<{ paired?: string }>();
  const [contacts, setContacts] = useState<ContactRecord[] | null>(null);
  const [online, setOnline] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const list = await listContacts();
    setContacts(list);
    void watchContacts();
    for (const c of list) {
      if (c.blocked) continue;
      void refreshContact(c)
        .then(({ record }) => setContacts((prev) => prev?.map((p) => (p.id === record.id ? record : p)) ?? prev))
        .catch(async (e: unknown) => {
          if (e instanceof ContactBlocked) setContacts(await listContacts());
        });
    }
  };

  useEffect(() => {
    void load().catch((e: unknown) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.presence]);

  useEffect(() => {
    if (!s.presence) return;
    const p = s.presence;
    setOnline(new Map(p.online));
    return p.on((f) => {
      if (f.type === "presence") setOnline(new Map(p.online));
    });
  }, [s.presence]);

  if (!s.profile.fingerprint) return <Redirect href="/welcome" />;

  return (
    <Screen>
      <Title eyebrow="Paired">Contacts</Title>
      {paired ? <Notice tone="ok">{`Paired with ${paired}.`}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button title="Pair with someone" tone="primary" onPress={() => router.push("/p")} testID="pair-new" />
      {contacts === null ? (
        <Spinner label="Loading contacts…" />
      ) : contacts.length === 0 ? (
        <Card tone="sunken">
          <P>No contacts yet. Pair in person once, then send files to each other from anywhere.</P>
        </Card>
      ) : (
        <View>
          {contacts.map((c) => {
            const chain = cachedChain(c);
            const devices = chain ? activeDevices(chain).length : 0;
            const on = online.get(c.id) ?? 0;
            return (
              <ListRow key={c.id} testID="contact-row">
                <Row>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: on > 0 ? color.success : color.line }} />
                  <B>{c.displayName}</B>
                  <P tone="subtle">
                    {devices} {devices === 1 ? "device" : "devices"}
                    {on > 0 ? ` · ${on} online` : ""}
                  </P>
                </Row>
                {c.blocked ? <Badge tone="bad">Blocked: identity changed unexpectedly</Badge> : null}
                {c.notice ? (
                  <Row>
                    <P tone="subtle">{c.notice}</P>
                    <Button
                      small
                      tone="ghost"
                      title="Dismiss"
                      onPress={() => {
                        const { notice: _n, ...rest } = c;
                        void saveContact(rest).then(load);
                      }}
                    />
                  </Row>
                ) : null}
                <P tone="subtle" mono>
                  {c.id.slice(0, 16)}
                </P>
                <Row>
                  {c.blocked ? (
                    <P tone="subtle">Pair again in person to unblock.</P>
                  ) : (
                    <Button small tone="primary" title="Send files" onPress={() => router.push({ pathname: "/contacts/[fp]", params: { fp: c.id } })} testID="send-to-contact" />
                  )}
                  <Button
                    small
                    tone="ghost"
                    title="Remove"
                    onPress={() =>
                      Alert.alert(`Remove ${c.displayName}?`, "You will need to pair in person again to send to each other.", [
                        { text: "Cancel", style: "cancel" },
                        { text: "Remove", style: "destructive", onPress: () => void removeContact(c.id).then(load) },
                      ])
                    }
                  />
                </Row>
              </ListRow>
            );
          })}
        </View>
      )}
    </Screen>
  );
}
