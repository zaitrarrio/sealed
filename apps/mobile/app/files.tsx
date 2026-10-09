/**
 * Everything received on this phone, kept encrypted at rest (ADR-0005): each file's key is wrapped to the
 * hardware device key, so opening or saving one asks for Face ID / fingerprint / passcode.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import { useFocusEffect } from "expo-router";
import { ReceivedFiles } from "../src/components/ReceivedFiles";
import { formatBytes } from "../src/lib/bytes";
import { deleteReceived, listReceived, type ReceivedFile } from "../src/lib/received";
import { Button, Card, ListRow, P, Screen, Spinner, Title } from "../src/ui/kit";

export default function Files() {
  const [files, setFiles] = useState<ReceivedFile[] | null>(null);
  const load = useCallback(() => void listReceived().then(setFiles), []);
  useFocusEffect(load);
  useEffect(load, [load]);

  return (
    <Screen>
      <Title eyebrow="On this phone">Received files</Title>
      {files === null ? (
        <Spinner label="Loading…" />
      ) : files.length === 0 ? (
        <Card tone="sunken">
          <P>Nothing here yet. Files you receive are kept here, encrypted, until you delete them.</P>
        </Card>
      ) : (
        <>
          <P tone="subtle">
            {files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(files.reduce((a, f) => a + f.size, 0))}
          </P>
          <ReceivedFiles files={files} />
          <Title eyebrow="Manage">Delete</Title>
          {files.map((f) => (
            <ListRow
              key={f.id}
              right={
                <Button
                  small
                  tone="danger"
                  title="Delete"
                  accessibilityLabel={`Delete ${f.path}`}
                  onPress={() =>
                    Alert.alert(`Delete ${f.path}?`, "The encrypted copy on this phone is erased.", [
                      { text: "Cancel", style: "cancel" },
                      { text: "Delete", style: "destructive", onPress: () => void deleteReceived(f.id).then(load) },
                    ])
                  }
                />
              }
            >
              <P tone="default">{f.path}</P>
              <P tone="subtle">{new Date(f.receivedAt * 1000).toLocaleString()}</P>
            </ListRow>
          ))}
        </>
      )}
    </Screen>
  );
}
