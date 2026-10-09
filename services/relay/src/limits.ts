/**
 * Plan and abuse limits enforced at the Worker edge (ADR-0015). New identities have lower limits for their
 * first 7 days. Rate limiting uses the Workers Rate Limiting binding where configured, keyed by device key and
 * IP prefix; on self-hosted workerd (no binding) it is a no-op and operators rely on their own edge.
 */
import { Limits } from "@sealed/core";
import type { Env } from "./env";
import { Errors } from "./http";
import { ipPrefix } from "./log";

export type Plan = "free" | "plus" | "teams" | "enterprise";

const GiB = 1024 * 1024 * 1024;

export interface PlanLimits {
  maxBucketBytes: number;
  maxTransfersPerDay: number;
  maxRoomCap: number;
  maxDailyBytes: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { maxBucketBytes: 2 * GiB, maxTransfersPerDay: 200, maxRoomCap: Limits.roomDefaultCap, maxDailyBytes: 20 * GiB },
  plus: { maxBucketBytes: 20 * GiB, maxTransfersPerDay: 1000, maxRoomCap: 500, maxDailyBytes: 200 * GiB },
  teams: { maxBucketBytes: 50 * GiB, maxTransfersPerDay: 5000, maxRoomCap: 1000, maxDailyBytes: 1000 * GiB },
  enterprise: { maxBucketBytes: 50 * GiB, maxTransfersPerDay: 20000, maxRoomCap: 5000, maxDailyBytes: 5000 * GiB },
};

/** ADR-0015: accounts younger than this get NEW_ACCOUNT_LIMITS (or their plan's, whichever is lower). */
export const NEW_ACCOUNT_SECONDS = 7 * 86400;

export const NEW_ACCOUNT_LIMITS: PlanLimits = {
  maxBucketBytes: 256 * 1024 * 1024,
  maxTransfersPerDay: 30,
  maxRoomCap: 50,
  maxDailyBytes: 2 * GiB,
};

export function effectiveLimits(plan: Plan, createdAt: number, now: number): PlanLimits {
  const p = PLAN_LIMITS[plan];
  if (now - createdAt >= NEW_ACCOUNT_SECONDS) return p;
  return {
    maxBucketBytes: Math.min(p.maxBucketBytes, NEW_ACCOUNT_LIMITS.maxBucketBytes),
    maxTransfersPerDay: Math.min(p.maxTransfersPerDay, NEW_ACCOUNT_LIMITS.maxTransfersPerDay),
    maxRoomCap: Math.min(p.maxRoomCap, NEW_ACCOUNT_LIMITS.maxRoomCap),
    maxDailyBytes: Math.min(p.maxDailyBytes, NEW_ACCOUNT_LIMITS.maxDailyBytes),
  };
}

/** Mailbox deliveries may not outlive the paired TTL; direct/room transfers have a 7-day hard cap for rooms. */
export function maxTtlFor(mode: "direct" | "room" | "paired"): number {
  switch (mode) {
    case "room":
      return Limits.roomMaxTtlSeconds;
    case "direct":
      return 7 * 86400;
    case "paired":
      return Limits.pairedTtlSeconds;
  }
}

async function check(binding: RateLimit | undefined, key: string): Promise<void> {
  if (!binding) return;
  const { success } = await binding.limit({ key });
  if (!success) throw Errors.rateLimited();
}

/** Per-IP-prefix limit, applied to every request. */
export function limitIp(env: Env, ip: string | null): Promise<void> {
  return ip ? check(env.RL_IP, `ip:${ipPrefix(ip)}`) : Promise.resolve();
}

/** Per-device limit, applied after a device signature verifies. */
export function limitDevice(env: Env, deviceId: string): Promise<void> {
  return check(env.RL_DEVICE, `dev:${deviceId}`);
}

/** Identity creation per IP prefix (sign-up throttling). */
export function limitSignup(env: Env, ip: string | null): Promise<void> {
  return ip ? check(env.RL_SIGNUP, `signup:${ipPrefix(ip)}`) : Promise.resolve();
}
