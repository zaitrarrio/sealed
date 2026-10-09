/** Live progress of an optical receive: coverage, tier, frames read, and file names once known. */
import { View } from "react-native";
import { formatBytes } from "../lib/bytes";
import type { DecodeProgress } from "../lib/facet-decode";
import { ListRow, P, Progress } from "../ui/kit";

export function CaptureStatus({ update }: { update: DecodeProgress | null }) {
  if (!update) return <P tone="subtle">Looking for the stream…</P>;
  const p = update.progress;
  return (
    <View style={{ gap: 8 }}>
      <Progress fraction={p.fraction} label={p.blockCount ? `Block ${Math.min(p.blocksComplete + 1, p.blockCount)} of ${p.blockCount}` : "Coverage"} />
      <P tone="subtle" mono>
        {p.tier !== null ? `T${p.tier} · ` : ""}
        {p.framesDecoded} frames read of {p.framesSeen} · {update.measurement.captureFps.toFixed(0)} fps · {update.measurement.decodeMsPerFrame.toFixed(0)} ms/frame
        {p.calibrated ? " · calibrated" : ""}
      </P>
      {update.files
        ? update.files.map((f) => (
            <ListRow key={f.path}>
              <P tone="default">{f.path}</P>
              <P tone="subtle" mono>
                {formatBytes(f.size)}
              </P>
            </ListRow>
          ))
        : null}
    </View>
  );
}
