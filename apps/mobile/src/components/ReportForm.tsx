/**
 * Report form (spec §9.2 /v1/reports, ADR-0015). From a claim screen it authenticates with the claim token;
 * otherwise with this device's signature (paired deliveries). Evidence is an optional SHA-256 of a file,
 * computed on the phone; the file itself never leaves it.
 */
import { RelayError, createSha256, fromB64url, toB64url } from "@sealed/core";
import { useState } from "react";
import { View } from "react-native";
import { pickDocuments, uriChunks } from "../lib/files";
import { useSession } from "../lib/session";
import { Button, Field, Notice, P, Segmented, errorMessage } from "../ui/kit";

type Reason = "malware" | "harassment" | "illegal" | "spam" | "other";

export function ReportForm({ transferId, claimToken }: { transferId?: string; claimToken?: string }) {
  const s = useSession();
  const [id, setId] = useState(transferId ?? "");
  const [reason, setReason] = useState<Reason>("malware");
  const [details, setDetails] = useState("");
  const [evidence, setEvidence] = useState<{ name: string; hash: string } | null>(null);
  const [state, setState] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canSign = Boolean(s.profile.fingerprint);

  return (
    <View style={{ gap: 12 }}>
      {!transferId ? <Field label="Transfer id or share link" value={id} onChangeText={setId} autoCapitalize="none" autoCorrect={false} /> : null}
      <Segmented
        label="Reason"
        value={reason}
        onChange={setReason}
        options={[
          ["malware", "Malware"],
          ["harassment", "Harassment"],
          ["illegal", "Illegal"],
          ["spam", "Spam"],
          ["other", "Other"],
        ]}
      />
      <Field label="Details (optional)" value={details} maxLength={2000} multiline onChangeText={setDetails} style={{ minHeight: 80, textAlignVertical: "top" }} />
      <Button
        small
        tone="ghost"
        title={evidence ? `Fingerprint of ${evidence.name} attached` : "Attach a file's fingerprint (optional)"}
        onPress={() =>
          void (async () => {
            const [f] = await pickDocuments();
            if (!f) return;
            const h = createSha256();
            for await (const chunk of uriChunks(f.uri)) h.update(chunk);
            setEvidence({ name: f.path, hash: toB64url(h.digest()) });
          })().catch((e: unknown) => setState({ tone: "danger", text: errorMessage(e) }))
        }
      />
      {!claimToken && !canSign ? <P tone="subtle">Reports from here need a set-up device. To report a code you scanned, use the report option on the receive screen.</P> : null}
      {state ? <Notice tone={state.tone}>{state.text}</Notice> : null}
      <Button
        title={busy ? "Sending…" : "Send report"}
        tone="danger"
        busy={busy}
        disabled={(!claimToken && !canSign) || !id.trim()}
        onPress={() => {
          setBusy(true);
          setState(null);
          void (async () => {
            try {
              const raw = id.trim();
              const match = raw.match(/\/c\/([A-Za-z0-9_-]{22})/);
              const tid = match ? match[1]! : raw;
              if (fromB64url(tid).length !== 16) throw new Error("Enter the transfer id or the share link.");
              await s.client.report(
                { transfer_id: tid, reason, ...(details.trim() ? { details: details.trim().slice(0, 2000) } : {}), ...(evidence ? { evidence_sha256: evidence.hash } : {}) },
                claimToken,
              );
              setState({ tone: "ok", text: "Report sent. Thank you." });
            } catch (err) {
              setState({ tone: "danger", text: err instanceof RelayError && err.status === 401 ? "This phone cannot report that transfer (it did not receive it)." : errorMessage(err) });
            } finally {
              setBusy(false);
            }
          })();
        }}
      />
    </View>
  );
}
