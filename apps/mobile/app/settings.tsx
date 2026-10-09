/** Settings: device name, relay, notifications, motion, diagnostics, and reports (ADR-0015). */
import { router } from "expo-router";
import { useState } from "react";
import { ReportForm } from "../src/components/ReportForm";
import { env, validateRelayUrl } from "../src/lib/config";
import { registerForPush } from "../src/lib/push";
import { session, useSession } from "../src/lib/session";
import { nativeAesGcm } from "../src/polyfills";
import { Button, Field, H2, Notice, P, ProtectionBadge, Row, Screen, Stack, Title, Toggle, errorMessage } from "../src/ui/kit";

export default function Settings() {
  const s = useSession();
  const [label, setLabel] = useState(s.profile.label);
  const [relay, setRelay] = useState(s.settings.relayUrl ?? "");
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMsg(null);
    fn()
      .then((text) => setMsg({ tone: "ok", text }))
      .catch((e: unknown) => setMsg({ tone: "danger", text: errorMessage(e) }))
      .finally(() => setBusy(null));
  };

  return (
    <Screen>
      <Title eyebrow="Settings">This device</Title>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <Stack>
        <Field label="Device name" hint="Shown to senders when you scan their code, and on your shares." value={label} maxLength={40} onChangeText={setLabel} />
        <Button
          title="Save name"
          disabled={busy !== null || !label.trim()}
          onPress={() =>
            run("label", async () => {
              await session.setLabel(label);
              return "Saved. New shares and claims use this name; your identity's device list keeps the name it was added with.";
            })
          }
        />
      </Stack>
      <Stack>
        <Field
          label="Relay"
          hint={`Default: ${env.relayUrl}. Use a self-hosted relay only if your organization runs one; your identity lives on the relay where it was created.`}
          value={relay}
          placeholder={env.relayUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onChangeText={setRelay}
        />
        <Row>
          <Button
            title="Save relay"
            disabled={busy !== null}
            onPress={() =>
              run("relay", async () => {
                const url = relay.trim() ? validateRelayUrl(relay) : undefined;
                if (url) {
                  const res = await fetch(`${url}/v1/health`).catch(() => null);
                  if (!res?.ok) throw new Error("That relay did not answer its health check.");
                }
                await session.setRelayUrl(url);
                return url ? `Using relay ${url}.` : `Using the default relay ${env.relayUrl}.`;
              })
            }
          />
          <P tone="subtle" mono>{`now: ${s.relayUrl}`}</P>
        </Row>
      </Stack>

      {s.profile.fingerprint ? (
        <Stack>
          <H2>Notifications</H2>
          <P>Get notified when a contact sends you files while Sealed is closed. The notification contains no file names or sender.</P>
          <Button
            title={s.settings.pushEnabled ? "Re-register notifications" : "Turn on notifications"}
            disabled={busy !== null}
            onPress={() =>
              run("push", async () => {
                const r = await registerForPush();
                if (r === "denied") throw new Error("Notifications are off for Sealed in system settings.");
                if (r === "unavailable") throw new Error("Push is not configured for this build.");
                return "Notifications are on.";
              })
            }
          />
        </Stack>
      ) : null}

      <Stack>
        <H2>Accessibility</H2>
        <Toggle
          label="Ask before flashing streams"
          detail="Optical streams flash about 10 times a second. When on (or when the system's Reduce Motion is on), Sealed asks before starting one."
          value={s.settings.reduceMotion ?? false}
          onChange={(v) => void session.updateSettings({ reduceMotion: v })}
        />
      </Stack>

      <Stack>
        <H2>This phone's keys</H2>
        {s.keys ? (
          <Row>
            <ProtectionBadge protection={s.keys.agreement.protection} />
            <P tone="subtle">{s.keys.hardware ? "Unlocked with Face ID, fingerprint or passcode." : "No secure hardware available: software keys, which cannot approve shares."}</P>
          </Row>
        ) : null}
        <P tone="subtle" mono>{`AES-GCM: ${nativeAesGcm} · key policy: ${s.settings.keyPolicy ?? "biometry-current-set"}`}</P>
      </Stack>

      <Row>
        {s.profile.fingerprint ? <Button tone="ghost" title="Devices and paper keys" onPress={() => router.push("/devices")} /> : null}
        <Button tone="ghost" title="Received files" onPress={() => router.push("/files")} />
        <Button tone="ghost" title="What the relay can see" onPress={() => router.push("/security")} />
      </Row>

      <Stack>
        <H2>Report a transfer</H2>
        <P>If someone sent you something harmful, report the transfer. Sealed acts on the sender's account; it cannot read the files.</P>
        <ReportForm />
      </Stack>
    </Screen>
  );
}
