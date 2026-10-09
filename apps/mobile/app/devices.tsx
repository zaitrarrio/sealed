/**
 * Devices (spec §6.3.4–6.3.5): this identity's verified device list, adding a device, revoking devices, and
 * paper keys. Every identity change asks for Face ID / fingerprint / passcode.
 */
import { compress, ctEqual, toB64url } from "@sealed/core";
import { Redirect, router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { PaperKeyCard } from "../src/components/PaperKeyCard";
import { revokeOwnDevice } from "../src/lib/identity";
import { session, useSession } from "../src/lib/session";
import { Badge, Button, H2, ListRow, Notice, P, ProtectionBadge, Row, Screen, Spinner, Title, errorMessage } from "../src/ui/kit";

export default function Devices() {
  const s = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [paper, setPaper] = useState(false);
  const [poolCount, setPoolCount] = useState<number | null>(null);

  useEffect(() => {
    if (!s.profile.fingerprint) return;
    void session.refreshOwnChain().catch((e: unknown) => setError(errorMessage(e)));
    if (s.active) void session.prekeyCount().then(setPoolCount, () => undefined);
  }, [s.profile.fingerprint, s.active]);

  if (!s.profile.fingerprint) return <Redirect href="/welcome" />;
  if (!s.chain || !s.keys) {
    return (
      <Screen>
        <Spinner label="Loading devices…" />
      </Screen>
    );
  }

  const mine = compress(s.keys.signing.publicKey);
  const devices = [...s.chain.devices.values()].sort((a, b) => a.addedSeq - b.addedSeq);
  const activePaper = [...s.chain.paperKeys.values()].filter((p) => !p.revoked).length;

  return (
    <Screen>
      <Title eyebrow="Identity">Devices</Title>
      <P>
        Your identity is the signed list below. Contacts verify every change against what they pinned when you paired. Fingerprint{" "}
        <P mono tone="default">
          {s.profile.fingerprint.slice(0, 16)}
        </P>
        .
      </P>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View>
        {devices.map((d) => {
          const id = toB64url(compress(d.signingPublicKey));
          const self = ctEqual(compress(d.signingPublicKey), mine);
          const revoked = d.revokedSeq !== undefined;
          return (
            <ListRow
              key={id}
              testID="device-row"
              right={
                !revoked && !self ? (
                  <Button
                    small
                    tone="danger"
                    title={busy === id ? "Revoking…" : "Revoke"}
                    disabled={busy !== null}
                    onPress={() =>
                      Alert.alert(`Revoke ${d.label}?`, "It will stop receiving files immediately. Files already on it stay there.", [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Revoke",
                          style: "destructive",
                          onPress: () => {
                            setBusy(id);
                            setError(null);
                            revokeOwnDevice(d.signingPublicKey, "revoked by owner")
                              .catch((e: unknown) => setError(errorMessage(e)))
                              .finally(() => setBusy(null));
                          },
                        },
                      ])
                    }
                  />
                ) : undefined
              }
            >
              <P tone="default" style={revoked ? { textDecorationLine: "line-through", opacity: 0.6 } : undefined}>
                {d.label}
              </P>
              <Row>
                {self ? <Badge>this phone</Badge> : null}
                <ProtectionBadge protection={d.protection} />
                {revoked ? <Badge tone="bad">revoked</Badge> : null}
              </Row>
              {self && poolCount !== null ? <P tone="subtle">{`${poolCount} one-time prekeys on the relay`}</P> : null}
            </ListRow>
          );
        })}
      </View>
      <Row>
        <Button title="Add a device" tone="primary" onPress={() => router.push("/d")} testID="add-device" />
        <Button title="Show my pairing code" tone="ghost" onPress={() => router.push("/p")} />
      </Row>
      <H2>Paper keys</H2>
      <P>{activePaper === 0 ? "No paper key. Without one, losing every device means losing this identity." : `${activePaper} active paper key(s).`}</P>
      {paper ? <PaperKeyCard onDone={() => setPaper(false)} skipLabel="Cancel" /> : <Button title="Create a paper key" onPress={() => setPaper(true)} />}
    </Screen>
  );
}
