/**
 * Automatic mode resolution (spec §3.2). The UI exposes Send and Receive; this module picks Direct, Room,
 * Air-gap, or Broadcast from connectivity and a small set of plain-language toggles. Offline channel
 * (screen vs sound) is chosen at send time; trust mode stays Air-gap or Broadcast (ADR-0001, ADR-0024).
 */
export type ResolvedSendMode = "direct" | "room" | "airgap" | "broadcast";
export type OfflineChannel = "optical" | "acoustic";

export interface SendIntent {
  online: boolean;
  allowRoom: boolean;
  preferOffline: boolean;
  anyoneWatching: boolean;
}

export const RELAY_PROBE_MS = 5_000;

export function resolveSendMode(intent: SendIntent): ResolvedSendMode {
  if (intent.preferOffline || !intent.online) {
    return intent.anyoneWatching ? "broadcast" : "airgap";
  }
  return intent.allowRoom ? "room" : "direct";
}

export function sendModeLabel(mode: ResolvedSendMode, channel: OfflineChannel = "optical"): string {
  switch (mode) {
    case "direct":
      return "Send to one person nearby";
    case "room":
      return "Send to everyone who scans";
    case "airgap":
      return channel === "acoustic" ? "Send through the speaker (secure)" : "Send through the screen (secure)";
    case "broadcast":
      return channel === "acoustic" ? "Send through the speaker (anyone listening)" : "Send through the screen (anyone watching)";
  }
}

export async function probeRelay(baseUrl: string, timeoutMs = RELAY_PROBE_MS): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/health`;
    const res = await fetch(url, { signal: ctl.signal, method: "GET" });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
