/**
 * Received files, stored encrypted on this phone. "Open / save" decrypts into a temporary copy (one biometric
 * prompt) and hands it to the system share sheet — Files, Photos, Drive, another app — then deletes the copy.
 */
import { useState } from "react";
import { View } from "react-native";
import { formatBytes } from "../lib/bytes";
import { shareReceived, type ReceivedFile } from "../lib/received";
import { useSession } from "../lib/session";
import { Button, ListRow, Notice, P, errorMessage } from "../ui/kit";

export function ReceivedFiles({ files }: { files: ReceivedFile[] }) {
  const s = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={{ gap: 8 }}>
      {files.map((f, i) => (
        <ListRow
          key={f.id}
          testID={`received-${i}`}
          right={
            <Button
              small
              title={busy === f.id ? "Opening…" : "Open / save"}
              busy={busy === f.id}
              disabled={busy !== null || !s.keys}
              onPress={() => {
                if (!s.keys) return;
                setBusy(f.id);
                setError(null);
                shareReceived(f, s.keys.agreement)
                  .catch((e: unknown) => setError(errorMessage(e)))
                  .finally(() => setBusy(null));
              }}
            />
          }
        >
          <P tone="default">{f.path}</P>
          <P tone="subtle" mono>
            {formatBytes(f.size)}
            {f.from ? ` · from ${f.from}` : ""}
          </P>
        </ListRow>
      ))}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <P tone="subtle">Files stay encrypted on this phone until you open them. Copies you save elsewhere are ordinary files that Sealed cannot recall.</P>
    </View>
  );
}
