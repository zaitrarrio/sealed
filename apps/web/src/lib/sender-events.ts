/**
 * Sender event socket (spec §6.1.2, §9.2): claims, claim status changes, upload completion and expiry for one
 * transfer. The relay replays existing claims on connect, so reconnecting never loses state.
 */
import { SenderEvent } from "@sealed/core";

export function openSenderEvents(url: string, onEvent: (e: SenderEvent) => void, onStatus: (open: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      backoff = 1000;
      onStatus(true);
      ping = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send("ping"), 25_000);
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      try {
        const parsed = SenderEvent.safeParse(JSON.parse(ev.data));
        if (parsed.success) onEvent(parsed.data);
      } catch {
        // ignore malformed frames
      }
    };
    sock.onclose = () => {
      if (ping) clearInterval(ping);
      ping = null;
      onStatus(false);
      if (stopped || ws !== sock) return;
      retry = setTimeout(connect, backoff);
      backoff = Math.min(15_000, backoff * 2);
    };
  };
  connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    if (ping) clearInterval(ping);
    ws?.close(1000);
    ws = null;
  };
}
