/**
 * Share offline · Secure (Air-gap, spec §3.6, §6.5), as two turns of "one shows, the other films":
 *
 *   1. The receiver shows its key code; this phone films it (full frame, any angle — nothing to line up).
 *   2. Switch: this phone encrypts to that key and starts streaming at once; the receiver films this screen.
 *
 * Both screens show the same safety code as soon as the receiver reads the first frames. The files can be
 * chosen before or after filming the key code.
 */
import { TIERS, compress, ctEqual, prepareAirgapStream, type FacetSender, type ParsedCode, type Tier } from "@sealed/core";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { FacetStream } from "../../src/components/FacetStream";
import { FilePicker } from "../../src/components/FilePicker";
import { Scanner } from "../../src/components/Scanner";
import { Steps } from "../../src/components/Steps";
import { takeCode } from "../../src/lib/code-stash";
import { acceptedOrigins } from "../../src/lib/config";
import { cachedChain, listContacts } from "../../src/lib/contacts-store";
import { toEnvelopeInputs, totalSize } from "../../src/lib/files";
import { expectCode, friendlyCodeError } from "../../src/lib/routing";
import { useSelection } from "../../src/lib/selection";
import { useSession } from "../../src/lib/session";
import { B, Button, Card, CheckCode, Notice, P, Row, Screen, Spinner, Title, errorMessage } from "../../src/ui/kit";

/** Above this, an optical transfer takes long enough that the UI warns before starting. */
const LARGE_OPTICAL_BYTES = 2 * 1024 * 1024;

function etaSeconds(bytes: number, tier: Tier): number {
  const t = TIERS[tier];
  return Math.ceil(bytes / (t.symbolSize * t.dataFps * 0.7));
}

function formatDuration(s: number): string {
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export default function SendOffline() {
  const s = useSession();
  const { ref } = useLocalSearchParams<{ ref?: string }>();
  const [files, setFiles] = useSelection();
  const [rk, setRk] = useState<Extract<ParsedCode, { kind: "reverse-key" }> | null>(null);
  const [prepared, setPrepared] = useState<{ sender: FacetSender; sas: string } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinnedName, setPinnedName] = useState<string | null>(null);
  const landed = useRef(false);

  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    const text = takeCode(ref);
    if (!text) return;
    try {
      setRk(expectCode(text, "reverse-key", acceptedOrigins()));
    } catch (e) {
      setError(friendlyCodeError(e));
    }
  }, [ref]);

  // A receiver whose key belongs to a pinned contact device is named in the UI (it still uses the scanned key).
  useEffect(() => {
    if (!rk) return;
    void (async () => {
      for (const c of await listContacts()) {
        const chain = cachedChain(c);
        if (!chain) continue;
        for (const d of chain.devices.values()) {
          if (d.revokedSeq === undefined && ctEqual(compress(d.agreementPublicKey), compress(rk.receiverPublicKey))) {
            setPinnedName(`${c.displayName} (${d.label})`);
            return;
          }
        }
      }
    })();
  }, [rk]);

  // Turn 2 starts by itself: as soon as there is a key and files, encrypt and stream.
  useEffect(() => {
    if (!rk || files.length === 0 || prepared || busy || error) return;
    setBusy(true);
    const signedBy = s.keys && s.active ? s.keys : undefined;
    prepareAirgapStream({ files: toEnvelopeInputs(files), reverseKey: rk, ...(signedBy ? { senderKeys: signedBy } : {}), senderLabel: s.profile.label || "Sealed sender" })
      .then((p) => {
        setPrepared({ sender: p.sender, sas: p.sas });
        setStreaming(true);
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  }, [rk, files, prepared, busy, error, s.keys, s.active, s.profile.label]);

  const tier = (rk ? Math.min(rk.tier, 3) : 0) as Tier;
  const bytes = totalSize(files);
  const step = !rk ? 1 : 2;

  if (prepared && streaming) {
    return (
      <Screen>
        <Steps current={2} steps={["They show, you film", "Switch: you show, they film"]} />
        <Title eyebrow="Your turn to show">Turn your screen toward them</Title>
        <CheckCode value={prepared.sas} label="Safety code — their screen shows the same" testID="airgap-sender-sas" />
        <FacetStream sender={prepared.sender} caption={`T${tier}`} onStop={() => setStreaming(false)} reduceMotion={s.settings.reduceMotion ?? false} />
        <P tone="subtle">Keep streaming until their phone says the files arrived. If the safety codes differ, stop: the key code was not theirs.</P>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title eyebrow="Share offline · Secure">Send to one phone, through the screen</Title>
      <Steps current={step} steps={["They show, you film", "Switch: you show, they film"]} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {files.length === 0 || !rk ? <FilePicker files={files} onChange={setFiles} disabled={busy} /> : null}
      {!rk ? (
        <>
          <P>On their phone: Sealed → Receive offline. Point your camera at the code it shows; anywhere in view is fine.</P>
          <Scanner
            label="Film their key code"
            onCode={(text) => {
              try {
                setRk(expectCode(text, "reverse-key", acceptedOrigins()));
                setError(null);
                return null;
              } catch (e) {
                return friendlyCodeError(e);
              }
            }}
          />
        </>
      ) : (
        <Card>
          <B>{`Got their key: ${pinnedName ?? rk.label}`}</B>
          {files.length === 0 ? <P>Choose the files to send; streaming starts as soon as you do.</P> : null}
          {bytes > 0 ? (
            <P tone="subtle">{`About ${formatDuration(etaSeconds(bytes, tier))} of streaming at T${tier}${bytes > LARGE_OPTICAL_BYTES ? ". That is long for an offline transfer; share online if a network is allowed" : ""}.`}</P>
          ) : null}
          {busy ? <Spinner label="Encrypting for their phone…" /> : null}
          {prepared && !streaming ? (
            <View style={{ gap: 12 }}>
              <CheckCode value={prepared.sas} label="Safety code" />
              <Row>
                <Button title="Stream again" tone="primary" onPress={() => setStreaming(true)} testID="start-stream" />
                <Button
                  title="Different receiver"
                  tone="ghost"
                  onPress={() => {
                    setPrepared(null);
                    setRk(null);
                  }}
                />
              </Row>
            </View>
          ) : null}
          {error ? (
            <Button
              title="Try again"
              onPress={() => {
                setError(null);
                setPrepared(null);
              }}
            />
          ) : null}
        </Card>
      )}
    </Screen>
  );
}
