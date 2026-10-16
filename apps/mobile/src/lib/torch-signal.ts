/**
 * Receiver side of the torch back-channel (ADR-0022): turns decode progress into torch bursts.
 *
 *   report(progress)  every progress update; asks the sender to slow down or speed up from recent loss
 *   done()            on completion; flashes "done" so the sender stops by itself
 *
 * `torch` is what the camera's torch should be right now; `busy` keeps the camera (and so the torch) alive
 * after completion until the last "done" burst has played.
 */
import { ReceiverRateController, TorchPlayer, type ReceiveProgress, type TorchMessage } from "@sealed/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface TorchSignal {
  torch: boolean;
  busy: boolean;
  /** The last message sent, for the UI. */
  last: TorchMessage | null;
  report: (p: ReceiveProgress) => void;
  done: () => void;
  stop: () => void;
}

export function useTorchSignal(enabled = true): TorchSignal {
  const [torch, setTorch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<TorchMessage | null>(null);
  const player = useMemo(() => new TorchPlayer(setTorch), []);
  const controller = useMemo(() => new ReceiverRateController(), []);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  // `busy` follows the player; polled because the player has no completion event.
  const watch = useCallback(() => {
    setBusy(true);
    if (poll.current) return;
    poll.current = setInterval(() => {
      if (!player.busy) {
        if (poll.current) clearInterval(poll.current);
        poll.current = null;
        setBusy(false);
      }
    }, 200);
  }, [player]);

  useEffect(
    () => () => {
      player.stop();
      if (poll.current) clearInterval(poll.current);
    },
    [player],
  );

  const send = useCallback(
    (m: TorchMessage) => {
      player.play(m);
      setLast(m);
      watch();
    },
    [player, watch],
  );

  const report = useCallback(
    (p: ReceiveProgress) => {
      if (!enabled || p.complete) return;
      const m = controller.decide(p.recentLoss, p.fraction, Date.now());
      if (m) send(m);
    },
    [controller, enabled, send],
  );
  const done = useCallback(() => {
    if (enabled) send("done");
  }, [enabled, send]);
  const stop = useCallback(() => {
    player.stop();
    setBusy(false);
  }, [player]);

  return { torch, busy, last, report, done, stop };
}
