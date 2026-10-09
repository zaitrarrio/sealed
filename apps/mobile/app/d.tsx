/**
 * Existing-device side of adding a device (spec §6.3.4): scan the new device's code (or arrive here from a
 * camera that scanned it), compare the check code, append add_device behind a fresh biometric prompt, then
 * show this device's pairing code so the new device can join.
 */
import { activeDevices, addDeviceCheckCode, compress, createPairingOffer, ctEqual, type ParsedCode } from "@sealed/core";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { QrCode } from "../src/components/QrCode";
import { Scanner } from "../src/components/Scanner";
import { takeCode } from "../src/lib/code-stash";
import { acceptedOrigins, codeOrigin } from "../src/lib/config";
import { approveScannedDevice } from "../src/lib/identity";
import { expectCode, friendlyCodeError } from "../src/lib/routing";
import { useSession } from "../src/lib/session";
import { B, Button, Card, CheckCode, Notice, P, ProtectionBadge, Row, Screen, Spinner, Title, errorMessage } from "../src/ui/kit";

export default function AddDevice() {
  const s = useSession();
  const { ref } = useLocalSearchParams<{ ref?: string }>();
  const [code, setCode] = useState<Extract<ParsedCode, { kind: "add-device" }> | null>(null);
  const [phase, setPhase] = useState<"scan" | "confirm" | "added">("scan");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const landed = useRef(false);

  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    const text = takeCode(ref);
    if (!text) return;
    try {
      setCode(expectCode(text, "add-device", acceptedOrigins()));
      setPhase("confirm");
    } catch (e) {
      setError(friendlyCodeError(e));
    }
  }, [ref]);

  const pairing = useMemo(() => (phase === "added" && s.chain ? createPairingOffer(codeOrigin(), s.chain, s.profile.label) : null), [phase, s.chain, s.profile.label]);

  if (!s.profile.fingerprint) {
    return (
      <Screen>
        <Title eyebrow="Add a device">This phone has no identity yet</Title>
        <P>That code adds a new device to an identity. Open it on a device that already uses Sealed.</P>
        <Button title="Set up this phone" onPress={() => router.replace("/welcome")} />
      </Screen>
    );
  }
  if (!s.chain) {
    return (
      <Screen>
        <Spinner label="Loading your identity…" />
      </Screen>
    );
  }
  const alreadyIn = code ? activeDevices(s.chain).some((d) => ctEqual(compress(d.signingPublicKey), compress(code.signingPublicKey))) : false;

  return (
    <Screen>
      <Title eyebrow="Devices">Add a device</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {phase === "scan" ? (
        <>
          <P>On the new device, choose "Add this phone to my identity" (or "Add this browser" on the web), then scan the code it shows.</P>
          <Scanner
            label="Scan the new device's code"
            onCode={(text) => {
              try {
                setCode(expectCode(text, "add-device", acceptedOrigins()));
                setPhase("confirm");
                return null;
              } catch (e) {
                return friendlyCodeError(e);
              }
            }}
          />
        </>
      ) : null}
      {phase === "confirm" && code ? (
        <>
          <Card>
            <Row>
              <B>{code.label}</B>
              <ProtectionBadge protection={code.protection} />
            </Row>
            <CheckCode value={addDeviceCheckCode(code)} testID="add-device-confirm-sas" />
            <P>The new device shows a check code. Approve only if the digits match.</P>
          </Card>
          {alreadyIn ? <Notice>This device is already part of your identity.</Notice> : null}
          <Row>
            <Button
              title={busy ? "Adding…" : "The codes match — add it"}
              tone="primary"
              busy={busy}
              disabled={alreadyIn}
              testID="approve-device"
              onPress={() => {
                setBusy(true);
                setError(null);
                approveScannedDevice(code)
                  .then(() => setPhase("added"))
                  .catch((e: unknown) => setError(errorMessage(e)))
                  .finally(() => setBusy(false));
              }}
            />
            <Button
              title="They do not match"
              tone="ghost"
              onPress={() => {
                setCode(null);
                setPhase("scan");
              }}
            />
          </Row>
        </>
      ) : null}
      {phase === "added" && pairing ? (
        <View style={{ gap: 16 }}>
          <Notice tone="ok">{`Added ${code?.label ?? "the device"}. Finish on the new device by scanning this code.`}</Notice>
          <QrCode text={pairing.code} label="This device's pairing code" testID="join-pairing-code" />
          <Button title="Done" onPress={() => router.replace("/devices")} />
        </View>
      ) : null}
    </Screen>
  );
}
