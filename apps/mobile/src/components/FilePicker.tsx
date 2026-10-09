/**
 * File selection: the system document picker (local files and every installed cloud provider — Google Drive,
 * iCloud Drive, OneDrive, Dropbox) and the photo library.
 */
import { useState } from "react";
import { View } from "react-native";
import { formatBytes } from "../lib/bytes";
import { dedupePaths, pickDocuments, pickPhotos, totalSize, type PickedFile } from "../lib/files";
import { Badge, Button, ListRow, Notice, P, Row, errorMessage } from "../ui/kit";

export function FilePicker({ files, onChange, disabled = false }: { files: PickedFile[]; onChange: (f: PickedFile[]) => void; disabled?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const add = (more: PickedFile[]) => onChange(dedupePaths([...files, ...more]));
  const pick = (fn: () => Promise<PickedFile[]>) => {
    setError(null);
    setOpening(true);
    fn()
      .then(add)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setOpening(false));
  };

  return (
    <View style={{ gap: 12 }}>
      <P tone="subtle">Everything is encrypted on this phone before it leaves. Cloud files (Drive, iCloud, OneDrive, Dropbox) appear in the file browser.</P>
      <Row>
        <Button title="Choose files" onPress={() => pick(pickDocuments)} disabled={disabled || opening} testID="pick-files" />
        <Button title="Photos & videos" tone="ghost" onPress={() => pick(pickPhotos)} disabled={disabled || opening} />
      </Row>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {files.length > 0 ? (
        <View>
          <Row between>
            <P tone="default">
              {files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(totalSize(files))}
            </P>
            <Button small tone="ghost" title="Clear" onPress={() => onChange([])} disabled={disabled} />
          </Row>
          {files.slice(0, 200).map((f, i) => (
            <ListRow
              key={`${f.path}-${i}`}
              right={<Button small tone="ghost" title="Remove" accessibilityLabel={`Remove ${f.path}`} disabled={disabled} onPress={() => onChange(files.filter((_, j) => j !== i))} />}
            >
              <P tone="default">{f.path}</P>
              <Row>
                <P tone="subtle" mono>
                  {formatBytes(f.size)}
                </P>
                {f.source === "cloud" ? <Badge>cloud</Badge> : null}
              </Row>
            </ListRow>
          ))}
          {files.length > 200 ? <P tone="subtle">and {files.length - 200} more</P> : null}
        </View>
      ) : null}
    </View>
  );
}
