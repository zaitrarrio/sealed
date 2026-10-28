/** Acoustic Broadcast send — open by design; strong warning before play. */
import { ACOUSTIC_SIZE_WARN_BYTES, estimateAcousticSeconds, prepareBroadcastAcousticStream, type AcousticProfileId, type AcousticSender } from "@sealed/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { FilePicker } from "../../src/components/FilePicker";
import { playAcousticSender } from "../../src/lib/acoustic-audio";
import { formatBytes } from "../../src/lib/bytes";
import { toEnvelopeInputs, totalSize } from "../../src/lib/files";
import { useSelection } from "../../src/lib/selection";
import { useSession } from "../../src/lib/session";
import { Button, Notice, Screen, Title, errorMessage } from "../../src/ui/kit";

export default function AcousticBroadcast() {
  const s = useSession();
  const [files, setFiles] = useSelection();
  const [warned, setWarned] = useState(false);
  const [prepared, setPrepared] = useState<{ sender: AcousticSender; profile: AcousticProfileId } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bytes = totalSize(files);

  const prepare = useCallback(async () => {
    if (files.length === 0) return;
    setError(null);
    try {
      const publisher =
        s.keys && s.active && s.chain
          ? { signing: s.keys.signing, fingerprint: s.chain.fingerprint, label: s.profile.label || "Sealed" }
          : undefined;
      const p = await prepareBroadcastAcousticStream({
        files: toEnvelopeInputs(files),
        ...(publisher ? { publisher } : {}),
        profile: 0,
      });
      setPrepared({ sender: p.sender, profile: p.profile });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [files, s.keys, s.active, s.chain, s.profile.label]);

  const startPlay = useCallback(async () => {
    if (!prepared) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setPlaying(true);
    try {
      await playAcousticSender(prepared.sender, prepared.profile, { signal: ctl.signal });
    } catch (e) {
      if ((e as Error).message !== "aborted") setError(errorMessage(e));
    } finally {
      setPlaying(false);
    }
  }, [prepared]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!warned) {
    return (
      <Screen>
        <Title eyebrow="Anyone listening">Open broadcast over sound</Title>
        <Notice tone="info">Anyone who can hear these tones can receive the files — including people in the next room. Continue only for material meant for everyone present.</Notice>
        <FilePicker files={files} onChange={setFiles} />
        {bytes > ACOUSTIC_SIZE_WARN_BYTES ? (
          <Notice tone="info">{`Large for sound (~${estimateAcousticSeconds(bytes, 0)} s). Prefer the screen.`}</Notice>
        ) : null}
        <Button title="I understand — continue" testID="acoustic-broadcast-warn-ok" disabled={files.length === 0} onPress={() => setWarned(true)} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title eyebrow="Anyone listening">Broadcasting over sound</Title>
      {!prepared ? (
        <Button title="Prepare stream" testID="acoustic-broadcast-prepare" onPress={() => void prepare()} />
      ) : playing ? (
        <Button title="Stop" testID="acoustic-broadcast-stop" onPress={() => abortRef.current?.abort()} />
      ) : (
        <Button title="Play tones" testID="acoustic-broadcast-play" onPress={() => void startPlay()} />
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {bytes > 0 ? <Notice tone="info">{`${formatBytes(bytes)} · open by design`}</Notice> : null}
    </Screen>
  );
}
