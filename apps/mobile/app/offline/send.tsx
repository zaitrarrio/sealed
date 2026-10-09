/**
 * Share offline · Secure (Air-gap, spec §3.6, §6.5). The receiver shows a reverse key code; this phone's camera
 * scans it; both show the Air-gap check code; this screen streams Facet frames that only the receiver's device
 * key can open.
 */
import { TIERS, compress, ctEqual, prepareAirgapStream, type FacetSender, type ParsedCode, type Tier } from "@sealed/core";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { FacetStream } from "../../src/components/FacetStream";
import { FilePicker } from "../../src/components/FilePicker";
import { Scanner } from "../../src/components/Scanner";
import { formatBytes } from "../../src/lib/bytes";
import { takeCode } from "../../src/lib/code-stash";
import { acceptedOrigins } from "../../src/lib/config";
import { cachedChain, listContacts } from "../../src/lib/contacts-store";
import { toEnvelopeInputs, totalSize } from "../../src/lib/files";
import { expectCode, friendlyCodeError } from "../../src/lib/routing";
import { useSelection } from "../../src/lib/selection";
import { useSession } from "../../src/lib/session";
import { B, Button, Card, CheckCode, Notice, P, Row, Screen, Title, errorMessage } from "../../src/ui/kit";

/** Above this, an optical transfer takes long enough that the UI warns before starting. */
const LARGE_OPTICAL_BYTES = 20 * 1024 * 1024;

export function etaSeconds(bytes: number, tier: Tier): number {
  const t = TIERS[tier];
  return Math.ceil(bytes / (t.symbolSize * t.dataFps * 0.85));
}

export function formatDuration(s: number): string {
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

  const prepare = async () => {
    if (!rk || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const signedBy = s.keys && s.active ? s.keys : undefined;
      const p = await prepareAirgapStream({ files: toEnvelopeInputs(files), reverseKey: rk, ...(signedBy ? { senderKeys: signedBy } : {}), senderLabel: s.profile.label || "Sealed sender" });
      setPrepared({ sender: p.sender, sas: p.sas });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (prepared && streaming) {
    return (
      <Screen padded={false}>
        <FacetStream sender={prepared.sender} caption={`check ${prepared.sas}`} onStop={() => setStreaming(false)} reduceMotion={s.settings.reduceMotion ?? false} />
      </Screen>
    );
  }

  const tier = (rk ? Math.min(rk.tier, 3) : 1) as Tier;
  const bytes = totalSize(files);

  return (
    <Screen>
      <Title eyebrow="Share offline · Secure">Send to one device, through light</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!rk ? (
        <>
          <P>On the receiving device, open Sealed and choose "Receive offline". Scan the key code it shows.</P>
          <Scanner
            label="Scan the receiver's key code"
            onCode={(text) => {
              try {
                setRk(expectCode(text, "reverse-key", acceptedOrigins()));
                return null;
              } catch (e) {
                return friendlyCodeError(e);
              }
            }}
          />
        </>
      ) : null}
      {rk && !prepared ? (
        <>
          <Card>
            <B>{`Receiver: ${pinnedName ?? rk.label}`}</B>
            <P tone="subtle">{`Capability T${rk.tier}${pinnedName ? " · a device of a paired contact" : ""}`}</P>
          </Card>
          <FilePicker files={files} onChange={setFiles} disabled={busy} />
          {bytes > 0 ? (
            bytes > LARGE_OPTICAL_BYTES ? (
              <Notice>{`About ${formatDuration(etaSeconds(bytes, tier))} of streaming at T${tier}. That is long for an optical transfer; consider sharing online if a network is allowed.`}</Notice>
            ) : (
              <P tone="subtle">{`About ${formatDuration(etaSeconds(bytes, tier))} of streaming at T${tier}.`}</P>
            )
          ) : null}
          <Button title={busy ? "Encrypting…" : "Encrypt for this receiver"} tone="primary" busy={busy} disabled={files.length === 0} onPress={() => void prepare()} testID="prepare-airgap" />
        </>
      ) : null}
      {prepared && !streaming ? (
        <>
          <CheckCode value={prepared.sas} label="Check code" testID="airgap-sender-sas" />
          <P>Start the stream. The receiver's screen shows a check code as soon as it reads the first frames. Continue only if it matches; if not, stop: the key code was not theirs.</P>
          <Row>
            <Button title="Start streaming" tone="primary" onPress={() => setStreaming(true)} testID="start-stream" />
            <Button title="Back" tone="ghost" onPress={() => setPrepared(null)} />
          </Row>
        </>
      ) : null}
    </Screen>
  );
}
