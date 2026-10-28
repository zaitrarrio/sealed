/**
 * Acoustic Air-gap send: scan reverse key (camera), then play Envelope ciphertext as tones.
 */
import {
  ACOUSTIC_SIZE_WARN_BYTES,
  compress,
  ctEqual,
  estimateAcousticSeconds,
  prepareAirgapAcousticStream,
  type AcousticProfileId,
  type AcousticSender,
  type ParsedCode,
} from "@sealed/core";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FilePicker } from "../../src/components/FilePicker";
import { Scanner } from "../../src/components/Scanner";
import { Steps } from "../../src/components/Steps";
import { playAcousticSender } from "../../src/lib/acoustic-audio";
import { takeCode } from "../../src/lib/code-stash";
import { acceptedOrigins } from "../../src/lib/config";
import { cachedChain, listContacts } from "../../src/lib/contacts-store";
import { formatBytes } from "../../src/lib/bytes";
import { toEnvelopeInputs, totalSize } from "../../src/lib/files";
import { expectCode, friendlyCodeError } from "../../src/lib/routing";
import { useSelection } from "../../src/lib/selection";
import { useSession } from "../../src/lib/session";
import { Button, CheckCode, Notice, P, Screen, Spinner, Title, errorMessage } from "../../src/ui/kit";

export default function AcousticSend() {
  const s = useSession();
  const { ref } = useLocalSearchParams<{ ref?: string }>();
  const [files, setFiles] = useSelection();
  const [rk, setRk] = useState<Extract<ParsedCode, { kind: "reverse-key" }> | null>(null);
  const [prepared, setPrepared] = useState<{ sender: AcousticSender; sas: string; profile: AcousticProfileId } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pinnedName, setPinnedName] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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

  useEffect(() => {
    if (!rk || files.length === 0 || prepared || busy || error) return;
    setBusy(true);
    const signedBy = s.keys && s.active ? s.keys : undefined;
    prepareAirgapAcousticStream({
      files: toEnvelopeInputs(files),
      reverseKey: rk,
      ...(signedBy ? { senderKeys: signedBy } : {}),
      senderLabel: s.profile.label || "Sealed sender",
      profile: 0,
    })
      .then((p) => setPrepared({ sender: p.sender, sas: p.sas, profile: p.profile }))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  }, [rk, files, prepared, busy, error, s.keys, s.active, s.profile.label]);

  const startPlay = useCallback(async () => {
    if (!prepared) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setPlaying(true);
    setError(null);
    try {
      await playAcousticSender(prepared.sender, prepared.profile, { signal: ctl.signal });
      setDone(true);
    } catch (e) {
      if ((e as Error).message !== "aborted") setError(errorMessage(e));
    } finally {
      setPlaying(false);
    }
  }, [prepared]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const bytes = totalSize(files);

  if (done && prepared) {
    return (
      <Screen>
        <Title eyebrow="Finished playing">Tones sent</Title>
        <CheckCode value={prepared.sas} label="Safety code — their screen shows the same" testID="acoustic-sender-sas" />
        <Button title="Done" onPress={() => router.replace("/")} />
      </Screen>
    );
  }

  if (prepared) {
    return (
      <Screen>
        <Steps current={2} steps={["They show, you film", "You play, they listen"]} />
        <CheckCode value={prepared.sas} label="Safety code — their screen shows the same" testID="acoustic-sender-sas" />
        <Notice tone="info">Keep the phones close. Do not read the safety code aloud while the tones play.</Notice>
        {playing ? (
          <Button title="Stop" tone="ghost" onPress={() => abortRef.current?.abort()} />
        ) : (
          <Button title="Play tones" testID="acoustic-play" onPress={() => void startPlay()} />
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Screen>
    );
  }

  return (
    <Screen>
      <Title eyebrow="Sound · Secure">Send through the speaker</Title>
      <Steps current={rk ? 2 : 1} steps={["They show, you film", "You play, they listen"]} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {(files.length === 0 || !rk) && <FilePicker files={files} onChange={setFiles} disabled={busy} />}
      {bytes > ACOUSTIC_SIZE_WARN_BYTES ? (
        <Notice tone="info">{`About ${formatBytes(bytes)} over sound takes roughly ${estimateAcousticSeconds(bytes, 0)} s. Prefer the screen for large files.`}</Notice>
      ) : null}
      {!rk ? (
        <>
          <P tone="muted">On their phone: Sealed → Receive over sound. Film the key code it shows.</P>
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
      ) : null}
      {rk && files.length > 0 && busy ? <Spinner label="Encrypting…" /> : null}
      {rk && pinnedName ? <P tone="subtle">{`Key matches pinned contact ${pinnedName}.`}</P> : null}
    </Screen>
  );
}
