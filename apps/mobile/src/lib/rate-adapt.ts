/**
 * Sender side of the torch back-channel (ADR-0022): applies the receiver's messages to a live stream.
 *
 *   done             the receiver has everything: stop streaming
 *   slower / faster  move one rung on the rate ladder (frame hold, then codes on screen); bytes per code are
 *                    fixed for the stream
 */
import { adaptQrRate, type FacetSender, type QrRate, type QrStreamSetting, type TorchMessage } from "@sealed/core";
import { useCallback, useState } from "react";

export interface LiveRate {
  rate: QrRate;
  /** The last message applied, for the UI. */
  last: TorchMessage | null;
  delivered: boolean;
  onMessage: (m: TorchMessage) => void;
}

export function useLiveRate(sender: FacetSender | null, initial: QrStreamSetting, onDelivered?: () => void): LiveRate {
  const [rate, setRate] = useState<QrRate>({ holdRefreshes60: initial.holdRefreshes60, codesPerScreen: initial.codesPerScreen });
  const [last, setLast] = useState<TorchMessage | null>(null);
  const [delivered, setDelivered] = useState(false);
  const onMessage = useCallback(
    (m: TorchMessage) => {
      setLast(m);
      if (m === "done") {
        setDelivered(true);
        onDelivered?.();
        return;
      }
      setRate((r) => {
        const next = adaptQrRate(r, m);
        if (sender && next.holdRefreshes60 !== r.holdRefreshes60) sender.setQrHold(next.holdRefreshes60);
        return next;
      });
    },
    [sender, onDelivered],
  );
  return { rate, last, delivered, onMessage };
}
