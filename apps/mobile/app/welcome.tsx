/**
 * Onboarding (spec §6.3, ADR-0005/0006): create an identity on this phone, join an existing identity as an
 * added device, or restore with a paper key. Then notifications (so paired contacts' deliveries arrive), an
 * optional paper key, and prekeys. On a phone, approvals are verified by Face ID / fingerprint on the hardware
 * key itself, so no passkey step is needed.
 */
import { activeDevices, addDeviceCheckCode, compress, ctEqual, parseCode, toB64url, type ChainState } from "@sealed/core";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { PaperKeyCard } from "../src/components/PaperKeyCard";
import { QrCode } from "../src/components/QrCode";
import { Scanner } from "../src/components/Scanner";
import { acceptedOrigins, codeOrigin } from "../src/lib/config";
import { createNewIdentity, joinScannedIdentity, makeAddDeviceOffer, previewPaperKeyChain, restoreWithPaperKey } from "../src/lib/identity";
import { registerForPush } from "../src/lib/push";
import { expectCode, friendlyCodeError } from "../src/lib/routing";
import { session, useSession } from "../src/lib/session";
import { B, Button, CheckCode, Field, Notice, P, ProtectionBadge, Row, Screen, Spinner, Stack, Title, Toggle, errorMessage } from "../src/ui/kit";

type Step = "choose" | "create" | "join" | "restore" | "notify" | "paper" | "finish";

export default function Welcome() {
  const s = useSession();
  const [step, setStep] = useState<Step>(() => (s.profile.fingerprint ? "finish" : "choose"));
  const [label, setLabel] = useState(s.profile.label);
  const go = (next: Step) => () => void session.setLabel(label).then(() => setStep(next), () => undefined);
  const afterIdentity = () => setStep("notify");

  return (
    <Screen>
      {step === "choose" && (
        <>
          <Title eyebrow="Welcome">Set up Sealed on this phone</Title>
          <P>
            Sealed keeps a key pair in this phone's secure hardware. It never leaves the phone, and every use is unlocked with your face, fingerprint or passcode. To share, this phone joins an identity:
            a signed list of your devices that your contacts verify in person.
          </P>
          {s.keys ? (
            <Row>
              <P tone="subtle">This phone's keys:</P>
              <ProtectionBadge protection={s.keys.agreement.protection} />
            </Row>
          ) : null}
          <Field label="Name for this device" hint="Shown to people you share with and in your device list." value={label} maxLength={40} onChangeText={setLabel} testID="device-label" />
          <Stack>
            <Button title="Create my identity" tone="primary" disabled={!label.trim()} onPress={go("create")} testID="create-identity" />
            <Button title="Add this phone to my identity" disabled={!label.trim()} onPress={go("join")} />
            <Button title="Restore with a paper key" tone="ghost" disabled={!label.trim()} onPress={go("restore")} />
          </Stack>
          <P tone="subtle">Only receiving? You do not need to set anything up.</P>
          <Button title="Scan a code" tone="ghost" onPress={() => router.push("/receive")} />
        </>
      )}
      {step === "create" && <CreateStep onDone={afterIdentity} onBack={() => setStep("choose")} />}
      {step === "join" && <JoinStep onDone={afterIdentity} onBack={() => setStep("choose")} />}
      {step === "restore" && <RestoreStep onDone={afterIdentity} onBack={() => setStep("choose")} />}
      {step === "notify" && <NotifyStep onDone={() => setStep(s.profile.paperKeyCreatedAt ? "finish" : "paper")} />}
      {step === "paper" && (
        <>
          <Title eyebrow="Step 3 of 3">Make a paper key</Title>
          <P>If you lose every device, a paper key is the only way back into your identity. Sealed has no password reset and cannot recover it for you. Write it down and keep it somewhere safe.</P>
          <PaperKeyCard onDone={() => setStep("finish")} skipLabel="Skip for now" />
        </>
      )}
      {step === "finish" && (
        <>
          <Title eyebrow="Ready">You are set up</Title>
          <P>
            <B>{s.profile.label}</B> is an active device of your identity.
          </P>
          {s.keys && !s.keys.hardware ? <Notice tone="danger">This phone has no usable secure hardware, so it can receive and share offline but cannot approve shares through the relay.</Notice> : null}
          <Button title="Start sharing" tone="primary" onPress={() => router.replace("/")} testID="finish-onboarding" />
        </>
      )}
    </Screen>
  );
}

function CreateStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const s = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Title eyebrow="Step 1 of 3">Create your identity</Title>
      <P>
        This phone, <B>{s.profile.label}</B>, becomes the first device of a new identity. Its fingerprint is what your contacts pin when you pair.
      </P>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Row>
        <Button
          title={busy ? "Creating…" : "Create identity"}
          tone="primary"
          busy={busy}
          testID="confirm-create"
          onPress={() => {
            setBusy(true);
            setError(null);
            createNewIdentity(s.profile.label)
              .then(onDone)
              .catch((e: unknown) => setError(`Could not create the identity: ${errorMessage(e)}`))
              .finally(() => setBusy(false));
          }}
        />
        <Button title="Back" tone="ghost" onPress={onBack} disabled={busy} />
      </Row>
    </>
  );
}

function JoinStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const s = useSession();
  const [offer, setOffer] = useState<{ code: string; sas: string } | null>(null);
  const [phase, setPhase] = useState<"show" | "scan">("show");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void makeAddDeviceOffer(codeOrigin(), s.profile.label)
      .then((o) => {
        if (cancelled) return;
        const parsed = parseCode(o.code);
        if (parsed.kind !== "add-device") throw new Error("unexpected code");
        setOffer({ code: o.code, sas: addDeviceCheckCode(parsed) });
      })
      .catch((e: unknown) => setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [s.profile.label]);

  return (
    <>
      <Title eyebrow="Step 1 of 3">Add this phone to your identity</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {phase === "show" ? (
        <>
          <P>On a device that already has Sealed, open Devices, choose "Add a device" and scan this code. Both screens will show the same check code.</P>
          {offer ? (
            <View style={{ alignItems: "center", gap: 12 }}>
              <QrCode text={offer.code} label="New-device code" testID="add-device-code" />
              <CheckCode value={offer.sas} testID="add-device-sas" />
            </View>
          ) : (
            <Spinner label="Preparing code…" />
          )}
          <Row>
            <Button title="I approved it on my other device" tone="primary" onPress={() => setPhase("scan")} disabled={!offer} testID="join-approved" />
            <Button title="Back" tone="ghost" onPress={onBack} />
          </Row>
        </>
      ) : (
        <>
          <P>Now show your pairing code on the other device (Devices → "Show my pairing code") and scan it here.</P>
          <Scanner
            label="Scan the other device's pairing code"
            onCode={async (text) => {
              let code;
              try {
                code = expectCode(text, "pair", acceptedOrigins());
              } catch (e) {
                return friendlyCodeError(e);
              }
              try {
                await joinScannedIdentity(code);
                onDone();
                return null;
              } catch (e) {
                return errorMessage(e);
              }
            }}
          />
          <Button title="Show my code again" tone="ghost" onPress={() => setPhase("show")} />
        </>
      )}
    </>
  );
}

function RestoreStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const s = useSession();
  const [text, setText] = useState("");
  const [chain, setChain] = useState<ChainState | null>(null);
  const [revoke, setRevoke] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Title eyebrow="Recovery">Restore with a paper key</Title>
      <P>Type the paper key exactly as written. It adds this phone to your identity and can revoke devices you no longer have.</P>
      <Field label="Paper key" value={text} onChangeText={setText} multiline autoCapitalize="none" autoCorrect={false} style={{ minHeight: 96, textAlignVertical: "top" }} />
      {!chain ? (
        <Row>
          <Button
            title="Check paper key"
            tone="primary"
            busy={busy}
            disabled={text.trim().length < 20}
            onPress={() => {
              setBusy(true);
              setError(null);
              previewPaperKeyChain(text)
                .then((c) => {
                  setChain(c);
                  setRevoke(new Set());
                })
                .catch((e: unknown) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          />
          <Button title="Back" tone="ghost" onPress={onBack} />
        </Row>
      ) : (
        <Stack>
          <P tone="default">Devices on this identity — select the ones you lost</P>
          {activeDevices(chain).map((d) => {
            const id = toB64url(compress(d.signingPublicKey));
            return (
              <Toggle
                key={id}
                label={d.label}
                detail={d.protection}
                value={revoke.has(id)}
                onChange={(v) => {
                  const next = new Set(revoke);
                  if (v) next.add(id);
                  else next.delete(id);
                  setRevoke(next);
                }}
              />
            );
          })}
          <Button
            title={busy ? "Restoring…" : revoke.size ? `Restore and revoke ${revoke.size}` : "Restore"}
            tone="primary"
            busy={busy}
            onPress={() => {
              setBusy(true);
              setError(null);
              restoreWithPaperKey(text, s.profile.label, (state) =>
                activeDevices(state)
                  .filter((d) => revoke.has(toB64url(compress(d.signingPublicKey))) && !ctEqual(compress(d.signingPublicKey), compress(s.keys!.signing.publicKey)))
                  .map((d) => d.signingPublicKey),
              )
                .then(onDone)
                .catch((e: unknown) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          />
        </Stack>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </>
  );
}

function NotifyStep({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const finish = () => void session.maintainPrekeys().catch(() => undefined).then(onDone);
  return (
    <>
      <Title eyebrow="Step 2 of 3">Get notified of deliveries</Title>
      <P>When a paired contact sends you files while Sealed is closed, a notification tells you they are waiting. The notification carries no file names or contents.</P>
      {note ? <Notice>{note}</Notice> : null}
      <Row>
        <Button
          title="Allow notifications"
          tone="primary"
          busy={busy}
          onPress={() => {
            setBusy(true);
            registerForPush()
              .then((r) => (r === "registered" ? finish() : setNote(r === "denied" ? "Notifications are off. You can turn them on in system settings." : "Push is not configured for this build; the inbox still updates while Sealed is open.")))
              .catch((e: unknown) => setNote(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        />
        <Button title={note ? "Continue" : "Not now"} tone="ghost" onPress={finish} disabled={busy} />
      </Row>
    </>
  );
}
