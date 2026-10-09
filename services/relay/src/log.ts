/**
 * Structured logging under ADR-0015 metadata minimization. The schema is closed: only the fields in
 * `LogFields` may be emitted, so raw IPs, file names, labels or tokens cannot leak into logs by accident.
 * Timestamps are rounded to the hour; IP addresses are HMAC'd with a key that rotates daily.
 */
import { toB64url, utf8 } from "@sealed/core";
import { hourFloor } from "./util";

export interface LogFields {
  event: string;
  route?: string;
  method?: string;
  status?: number;
  code?: string;
  transfer_id?: string;
  fp?: string;
  mode?: string;
  size_bucket?: number;
  region?: string;
  ip_hash?: string;
  count?: number;
  provider?: string;
  duration_ms?: number;
}

/** Field names that must never appear in a log record (checked in tests). */
export const FORBIDDEN_LOG_FIELDS = ["ip", "cf_connecting_ip", "x_forwarded_for", "file", "filename", "path_name", "label", "token", "cs", "wrap"] as const;

const ALLOWED = new Set<keyof LogFields>(["event", "route", "method", "status", "code", "transfer_id", "fp", "mode", "size_bucket", "region", "ip_hash", "count", "provider", "duration_ms"]);

export type LogSink = (record: Record<string, unknown>) => void;

let sink: LogSink = (record) => console.log(JSON.stringify(record));

/** Replaces the sink (tests capture records through this). Returns the previous sink. */
export function setLogSink(next: LogSink): LogSink {
  const prev = sink;
  sink = next;
  return prev;
}

export function log(fields: LogFields): void {
  const record: Record<string, unknown> = { ts_hour: hourFloor() };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (!ALLOWED.has(k as keyof LogFields)) continue;
    record[k] = v;
  }
  sink(record);
}

const keyCache = new Map<string, CryptoKey>();

/**
 * HMAC-SHA256(daily_key, ip_prefix), truncated to 16 bytes. The daily key is HMAC(secret, "ip-hash/" ∥ YYYY-MM-DD),
 * so hashes from different days cannot be linked and old keys are not recoverable from the current one.
 * IPv4 addresses are truncated to /24 and IPv6 to /48 first, matching the rate-limit prefix granularity.
 */
export async function hashIp(secret: string, ip: string, now = new Date()): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  let key = keyCache.get(day);
  if (!key) {
    const root = await crypto.subtle.importKey("raw", utf8(secret.length > 0 ? secret : "sealed-relay-default-ip-hash-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const dayKey = new Uint8Array(await crypto.subtle.sign("HMAC", root, utf8(`ip-hash/${day}`)));
    key = await crypto.subtle.importKey("raw", dayKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.clear();
    keyCache.set(day, key);
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(ipPrefix(ip))));
  return toB64url(mac.slice(0, 16));
}

/** Coarse network prefix used for rate limiting and hashing: IPv4 /24, IPv6 /48. */
export function ipPrefix(ip: string): string {
  if (ip.includes(":")) {
    const parts = expandIpv6(ip);
    return parts ? `${parts.slice(0, 3).join(":")}::/48` : "invalid";
  }
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : "invalid";
}

function expandIpv6(ip: string): string[] | null {
  const [head, tail, ...rest] = ip.split("::");
  if (rest.length > 0) return null;
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const parts = [...h, ...Array<string>(fill).fill("0"), ...t];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-fA-F]{1,4}$/.test(p))) return null;
  return parts.map((p) => p.toLowerCase().replace(/^0+(?=.)/, ""));
}
