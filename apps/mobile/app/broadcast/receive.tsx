/**
 * Receive a broadcast (spec §3.7, §6.6). The publisher is named only when its signature verifies against a
 * pinned contact's chain (or this identity); otherwise the files are labelled unsigned or unverified.
 */
import { compress, ctEqual, fromB64url } from "@sealed/core";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { CaptureStatus } from "../../src/components/CaptureStatus";
import { OpticalCapture } from "../../src/components/OpticalCapture";
import { ReceivedFiles } from "../../src/components/ReceivedFiles";
import { cachedChain, listContacts } from "../../src/lib/contacts-store";
import type { DecodeProgress, DecodeResult, DecodeSessionOptions } from "../../src/lib/facet-decode";
import { storeOpened, type ReceivedFile } from "../../src/lib/received";
import { useSession } from "../../src/lib/session";
import { Button, Notice, P, Screen, Title, errorMessage } from "../../src/ui/kit";

interface PublisherView {
  verified: "pinned" | "self" | "signature-only" | "invalid" | "unsigned";
  name?: string;
}

export default function BroadcastReceive() {
  const s = useSession();
  const [capturing, setCapturing] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [update, setUpdate] = useState<DecodeProgress | null>(null);
  const [result, setResult] = useState<{ files: ReceivedFile[]; publisher: PublisherView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo<DecodeSessionOptions>(() => ({ mode: "broadcast" }), [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const classify = async (r: DecodeResult): Promise<PublisherView> => {
    const p = r.publisher;
    if (!p) return { verified: "unsigned" };
    if (!p.signatureValid) return { verified: "invalid" };
    const fp = p.fingerprint;
    if (s.chain && ctEqual(fp, s.chain.fingerprint)) {
      const own = [...s.chain.devices.values()].some((d) => d.revokedSeq === undefined && ctEqual(compress(d.signingPublicKey), compress(p.signingKey)));
      return own ? { verified: "self", name: "you" } : { verified: "invalid" };
    }
    for (const c of await listContacts()) {
      if (!ctEqual(fromB64url(c.id), fp) || c.blocked) continue;
      const chain = cachedChain(c);
      const signer = chain && [...chain.devices.values()].some((d) => d.revokedSeq === undefined && ctEqual(compress(d.signingPublicKey), compress(p.signingKey)));
      if (signer) return { verified: "pinned", name: c.displayName };
    }
    return { verified: "signature-only" };
  };

  if (result) {
    const v = result.publisher;
    return (
      <Screen>
        <Title eyebrow="Broadcast received">{result.files.length === 1 ? "Your file is here" : `${result.files.length} files are here`}</Title>
        {v.verified === "pinned" || v.verified === "self" ? (
          <Notice tone="ok">{`Signed by ${v.name}`}</Notice>
        ) : v.verified === "signature-only" ? (
          <Notice>Signature present, publisher not verified. You have not paired with this publisher.</Notice>
        ) : v.verified === "invalid" ? (
          <Notice tone="danger">The broadcast carries a signature that does not verify. Treat these files as unsigned and untrusted.</Notice>
        ) : (
          <Notice>Unsigned broadcast. Anyone could have produced it.</Notice>
        )}
        <ReceivedFiles files={result.files} />
        <Button title="Done" tone="ghost" onPress={() => router.replace("/")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title eyebrow="Receive a broadcast">Point your camera at the screen</Title>
      <P>You can start at any moment; the stream repeats. Keep the whole pattern in view until the progress reaches 100%.</P>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {capturing ? (
        <>
          <OpticalCapture
            key={attempt}
            options={options}
            onProgress={setUpdate}
            onComplete={(r) => {
              if (!s.keys) return;
              const keys = s.keys;
              void classify(r)
                .then(async (publisher) => setResult({ files: await storeOpened(keys.agreement, r.files, publisher.name ?? "a broadcast"), publisher }))
                .catch((e: unknown) => setError(errorMessage(e)));
            }}
            onError={setError}
          />
          <CaptureStatus update={update} />
          <Button title="Stop" tone="ghost" onPress={() => setCapturing(false)} />
        </>
      ) : (
        <Button
          title="Start camera"
          onPress={() => {
            setAttempt((a) => a + 1);
            setUpdate(null);
            setCapturing(true);
          }}
        />
      )}
    </Screen>
  );
}
