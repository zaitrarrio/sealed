/**
 * Creates a paper key (appends add_paper_key, behind a fresh biometric prompt) and shows it exactly once, as
 * text and QR. Screenshots are the user's choice; the card asks them to write it down instead.
 */
import { color, radius } from "@sealed/tokens";
import { useState } from "react";
import { Text, View } from "react-native";
import { newPaperKey } from "../lib/identity";
import { Button, Notice, Row, Toggle, errorMessage, fonts } from "../ui/kit";
import { QrCode } from "./QrCode";

export function PaperKeyCard({ onDone, skipLabel }: { onDone: () => void; skipLabel?: string }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  if (!text) {
    return (
      <View style={{ gap: 12 }}>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Row>
          <Button
            title={busy ? "Creating…" : "Create paper key"}
            tone="primary"
            busy={busy}
            testID="create-paper-key"
            onPress={() => {
              setBusy(true);
              setError(null);
              newPaperKey()
                .then(setText)
                .catch((e: unknown) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          />
          {skipLabel ? <Button title={skipLabel} tone="ghost" onPress={onDone} disabled={busy} /> : null}
        </Row>
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      <Notice tone="danger">This is shown once. Anyone holding this paper key can add devices to your identity. Write it down; do not keep it in photos or a cloud note.</Notice>
      <View style={{ backgroundColor: color.paper, borderRadius: radius.md, padding: 16, gap: 12 }} testID="paper-key">
        <Text style={{ fontFamily: fonts.display, fontSize: 20, color: color.ink }}>Sealed paper key</Text>
        <Text selectable style={{ fontFamily: fonts.monoBold, fontSize: 18, lineHeight: 28, color: color.ink }} accessibilityLabel="Paper key">
          {text}
        </Text>
        <QrCode text={text} label="Paper key as a QR code" size={160} />
      </View>
      <Toggle label="I have written it down" value={confirmed} onChange={setConfirmed} />
      <Button
        title="Done"
        tone="primary"
        disabled={!confirmed}
        onPress={() => {
          setText(null);
          onDone();
        }}
      />
    </View>
  );
}
