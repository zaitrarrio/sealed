/**
 * Worker bindings. Kept in sync with wrangler.jsonc by hand (the relay declares optional secrets that
 * `wrangler types` cannot know about). Declared on `Cloudflare.Env` so `cloudflare:workers` / `cloudflare:test`
 * `env` imports are typed too.
 */
import type { IdentityDO } from "./identity-do";
import type { TransferDO } from "./transfer-do";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "TransferDO" | "IdentityDO";
    }

    interface Env {
      DB: D1Database;
      BUCKET: R2Bucket;
      TRANSFER: DurableObjectNamespace<TransferDO>;
      IDENTITY: DurableObjectNamespace<IdentityDO>;

      /** Workers Rate Limiting bindings; absent on self-hosted workerd, where limiting is a no-op. */
      RL_DEVICE?: RateLimit;
      RL_IP?: RateLimit;
      RL_SIGNUP?: RateLimit;

      /** Comma-separated list of web client origins allowed by CORS. */
      ALLOWED_ORIGINS?: string;
      /** Public base URL of the relay (https://relay.sealed.to); defaults to the request origin. */
      PUBLIC_URL?: string;
      ENVIRONMENT?: string;

      WEBAUTHN_RP_ID?: string;
      WEBAUTHN_RP_NAME?: string;
      /** Comma-separated list of origins accepted in WebAuthn client data. */
      WEBAUTHN_ORIGIN?: string;

      TURN_KEY_ID?: string;
      TURN_KEY_API_TOKEN?: string;
      /** Self-hosted coturn: comma-separated stun:/turn:/turns: URLs and the `static-auth-secret`. */
      TURN_URLS?: string;
      TURN_SHARED_SECRET?: string;

      VAPID_PUBLIC_KEY?: string;
      VAPID_PRIVATE_KEY?: string;
      VAPID_SUBJECT?: string;
      FCM_SERVICE_ACCOUNT_JSON?: string;
      APNS_KEY_ID?: string;
      APNS_TEAM_ID?: string;
      APNS_KEY_P8?: string;
      APNS_BUNDLE_ID?: string;
      /** "production" (default) or "sandbox". */
      APNS_ENVIRONMENT?: string;

      /** Secret for the daily-rotating IP hash key (ADR-0015). */
      IP_HASH_SECRET?: string;
    }
  }
}

export type Env = Cloudflare.Env;
