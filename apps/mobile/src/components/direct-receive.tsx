/**
 * One-button receive with no relay and no code. The camera reads a Send on the other screen;
 * the files appear here when the stream completes.
 */
import { useEffect, useMemo, useState } from "react";
import { CaptureStatus } from "./CaptureStatus";
import { OpticalCapture } from "./OpticalCapture";
import { ReceivedFiles } from "./ReceivedFiles";
import type { DecodeProgress, DecodeSessionOptions } from "../lib/facet-decode";
import { storeOpened, type ReceivedFile } from "../lib/received";
import { useSession } from "../lib/session";
import { Button, Card, Notice, P, errorMessage } from "../ui/kit";

export function DirectReceive({ autoStart }: { autoStart: boolean }) {
  const s = useSession();
  const [capturing, setCapturing] = useState(autoStart);
  const [attempt, setAttempt] = useState(0);
  const [update, setUpdate] = useState<DecodeProgress | null>(null);
  const [batches, setBatches] = useState<ReceivedFile[][]>([]);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo<DecodeSessionOptions>(() => ({ mode: "broadcast" }), [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (autoStart) setCapturing(true);
  }, [autoStart]);

  return (
    <>
      {batches.map((files, i) => (
        <Card key={i}>
          <ReceivedFiles files={files} />
        </Card>
      ))}
      {capturing ? (
        <>
          <OpticalCapture
            key={attempt}
            options={options}
            onProgress={setUpdate}
            onComplete={(r) => {
              const keys = s.keys;
              if (!keys) {
                setError("This phone's keys are not ready yet.");
                setCapturing(false);
                return;
              }
              void storeOpened(keys.agreement, r.files)
                .then((files) => {
                  setBatches((prev) => [files, ...prev]);
                  setCapturing(false);
                  setUpdate(null);
                })
                .catch((e: unknown) => setError(errorMessage(e)));
            }}
            onError={setError}
          />
          <CaptureStatus update={update} />
          <Button title="Stop" tone="ghost" onPress={() => setCapturing(false)} />
        </>
      ) : (
        <Button
          title={batches.length > 0 ? "Receive another" : "Receive"}
          tone="primary"
          testID="direct-listen"
          onPress={() => {
            setError(null);
            setUpdate(null);
            setAttempt((n) => n + 1);
            setCapturing(true);
          }}
        />
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!capturing && batches.length === 0 ? <P tone="subtle">Tap Receive and point the camera at their screen. The file shows up here. Nothing is uploaded.</P> : null}
    </>
  );
}
