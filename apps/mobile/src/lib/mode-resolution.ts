/**
 * Automatic mode resolution (spec §3.2). The UI exposes Send and Receive; this module picks Direct, Room,
 * Air-gap, or Broadcast from connectivity and a small set of plain-language toggles.
 */
export type ResolvedSendMode = "direct" | "room" | "airgap" | "broadcast";

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

export function sendModeLabel(mode: ResolvedSendMode): string {
  switch (mode) {
    case "direct":
      return "Send to one person nearby";
    case "room":
      return "Send to everyone who scans";
    case "airgap":
      return "Send through the screen (secure)";
    case "broadcast":
      return "Send through the screen (anyone watching)";
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
