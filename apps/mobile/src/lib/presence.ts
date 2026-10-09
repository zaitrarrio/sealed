/**
 * Presence socket (spec §6.4.3, §9.2): one authenticated WebSocket per device to the identity's Durable Object.
 * Carries presence counts for watched contacts, "mailbox" nudges, and signed signaling for live transfers.
 * Reconnects with capped exponential backoff and keeps itself alive with pings.
 */
import { Paths, PresenceServerFrame, type PresenceClientFrame, type RelayClient } from "@sealed/core";

export type PresenceListener = (frame: PresenceServerFrame) => void;
export type PresenceStatus = "connecting" | "open" | "closed";

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

export class PresenceSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<PresenceListener>();
  private statusListeners = new Set<(s: PresenceStatus) => void>();
  private watching: string[] = [];
  private backoff = 1000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  status: PresenceStatus = "closed";
  /** Online device counts by base64url fingerprint, from the latest presence frames. */
  readonly online = new Map<string, number>();

  constructor(private readonly client: RelayClient) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, "stopped");
    this.setStatus("closed");
  }

  on(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (s: PresenceStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Subscribes to presence of these identities (replaces the previous list). */
  watch(fps: string[]): void {
    this.watching = [...new Set(fps)].slice(0, 500);
    this.send({ type: "watch", fps: this.watching });
  }

  send(frame: PresenceClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private setStatus(s: PresenceStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus("connecting");
    let url: string;
    try {
      url = await this.client.socketUrl(Paths.presence(), { kind: "device" });
    } catch {
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.setStatus("open");
      if (this.watching.length) this.send({ type: "watch", fps: this.watching });
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_MS);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let parsed;
      try {
        parsed = PresenceServerFrame.safeParse(JSON.parse(ev.data));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.type === "presence") this.online.set(frame.fp, frame.devices_online);
      for (const l of this.listeners) l(frame);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.setStatus("closed");
      this.scheduleRetry();
    };
    ws.onerror = () => {
      // onclose follows and schedules the retry.
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = this.backoff + Math.floor(Math.random() * 500);
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}
