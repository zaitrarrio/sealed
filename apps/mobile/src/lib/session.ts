/**
 * The app session: this device's device keys, its profile and verified identity chain, the relay client and
 * the presence socket. React subscribes through `useSession()` (useSyncExternalStore).
 *
 * Receivers need no identity: keys are created silently on first use and a claim works with no fingerprint.
 * Senders create (or join) an identity; the relay client then signs requests with the device signing key.
 */
import {
  RelayClient,
  SoftwareAgreementKey,
  activeDevices,
  compress,
  ctEqual,
  extendChain,
  fromB64url,
  makeLink,
  randomBytes,
  replenishPrekeys,
  rotateMpkStatement,
  toB64url,
  verifyChain,
  type ChainState,
} from "@sealed/core";
import { useSyncExternalStore } from "react";
import { env } from "./config";
import { encodeChainLinks, loadProfile, loadSettings, saveProfile, saveSettings, verifyCachedChain, type Profile, type Settings } from "./device-store";
import { loadOrCreateDeviceKeys } from "./native-keys";
import { StoredPrekeyStore } from "./prekey-store";
import { PresenceSocket } from "./presence";
import type { MobileDeviceKeys } from "./native-keys";

export interface SessionState {
  status: "loading" | "ready" | "error";
  error?: string;
  keys: MobileDeviceKeys | null;
  profile: Profile;
  settings: Settings;
  /** Verified chain of this device's identity, when it has one. */
  chain: ChainState | null;
  relayUrl: string;
  client: RelayClient;
  presence: PresenceSocket | null;
  /** True when this device is an active device of its identity. */
  active: boolean;
}

/** Medium-term prekey lifetime and early-rotation margin (spec §6.4.1). */
const MPK_LIFETIME_SECONDS = 7 * 86400;
const MPK_ROTATE_MARGIN_SECONDS = 86400;

type Listener = () => void;

class Session {
  private state: SessionState;
  private listeners = new Set<Listener>();
  private started = false;
  private maintenance: Promise<{ uploaded: number; rotated: boolean }> | null = null;
  private chainLock: Promise<unknown> = Promise.resolve();
  prekeys: StoredPrekeyStore | null = null;

  constructor() {
    this.state = {
      status: "loading",
      keys: null,
      profile: { label: "" },
      settings: {},
      chain: null,
      relayUrl: env.relayUrl,
      client: new RelayClient({ baseUrl: env.relayUrl }),
      presence: null,
      active: false,
    };
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): SessionState => this.state;

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Loads keys, profile and settings once per page. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
      const keys = await loadOrCreateDeviceKeys(settings.keyPolicy);
      this.prekeys = new StoredPrekeyStore(keys.agreement);
      const relayUrl = settings.relayUrl || env.relayUrl;
      const chain = verifyCachedChain(profile);
      this.set({ keys, profile, settings, relayUrl, chain, status: "ready" });
      this.rebuildClient();
      if (chain) void this.refreshOwnChain().catch(() => undefined);
    } catch (e) {
      this.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  private rebuildClient(): void {
    const { keys, profile, relayUrl, chain } = this.state;
    this.state.presence?.stop();
    const fingerprint = profile.fingerprint ? fromB64url(profile.fingerprint) : undefined;
    const client = new RelayClient({ baseUrl: relayUrl, ...(keys && fingerprint ? { identity: { fingerprint, signing: keys.signing } } : {}) });
    const active = Boolean(keys && chain && isActive(chain, keys.signing.publicKey));
    let presence: PresenceSocket | null = null;
    if (active) {
      presence = new PresenceSocket(client);
      presence.start();
    }
    this.set({ client, presence, active });
    if (active) this.scheduleMaintenance();
  }

  // ------------------------------------------------------------ profile and settings

  async setLabel(label: string): Promise<void> {
    const clean = label.trim().slice(0, 40);
    if (!clean) throw new Error("A device name cannot be empty.");
    const profile = { ...this.state.profile, label: clean };
    await saveProfile(profile);
    this.set({ profile });
  }

  async updateProfile(patch: Partial<Profile>): Promise<void> {
    const profile = { ...this.state.profile, ...patch };
    await saveProfile(profile);
    this.set({ profile });
  }

  async setRelayUrl(url: string | undefined): Promise<void> {
    const settings: Settings = { ...this.state.settings };
    if (url) settings.relayUrl = url;
    else delete settings.relayUrl;
    await saveSettings(settings);
    this.set({ settings, relayUrl: url || env.relayUrl });
    this.rebuildClient();
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const settings = { ...this.state.settings, ...patch };
    await saveSettings(settings);
    this.set({ settings });
  }

  // ------------------------------------------------------------ identity

  /** Adopts a verified chain (after create, join or recovery) as this device's identity. */
  async adoptChain(chain: ChainState, links: readonly Uint8Array[]): Promise<void> {
    const profile: Profile = { ...this.state.profile, fingerprint: toB64url(chain.fingerprint), chainLinks: encodeChainLinks(links), onboardedAt: this.state.profile.onboardedAt ?? Date.now() };
    await saveProfile(profile);
    this.set({ profile, chain });
    this.rebuildClient();
  }

  /** Records links this device appended itself (keeps the cache in step without a round trip). */
  async appendedLinks(next: ChainState, links: readonly Uint8Array[]): Promise<void> {
    const existing = this.state.profile.chainLinks ?? [];
    const profile: Profile = { ...this.state.profile, chainLinks: [...existing, ...encodeChainLinks(links)] };
    await saveProfile(profile);
    const wasActive = this.state.active;
    this.set({ profile, chain: next });
    if (this.state.keys && wasActive !== isActive(next, this.state.keys.signing.publicKey)) this.rebuildClient();
  }

  /** Fetches the identity's chain, verifies it extends the cached one (fork check), and caches it. */
  async refreshOwnChain(): Promise<ChainState> {
    const { profile, client, chain: cached, keys } = this.state;
    if (!profile.fingerprint) throw new Error("this device has no identity");
    const fp = fromB64url(profile.fingerprint);
    const { links } = await client.getChain(fp);
    const chain = verifyChain(links, fp);
    if (cached) extendChain(cached, links);
    const p: Profile = { ...this.state.profile, chainLinks: encodeChainLinks(links) };
    await saveProfile(p);
    const wasActive = this.state.active;
    this.set({ profile: p, chain });
    if (keys && wasActive !== isActive(chain, keys.signing.publicKey)) this.rebuildClient();
    return chain;
  }

  // ------------------------------------------------------------ prekeys

  /**
   * Serializes everything that appends links to this identity from this device (MPK rotation, paper keys,
   * adding and revoking devices), so two local operations never race for the same chain head.
   */
  withChainLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chainLock.then(fn, fn);
    this.chainLock = run.catch(() => undefined);
    return run;
  }

  private scheduleMaintenance(): void {
    void this.maintainPrekeys().catch(() => undefined);
  }

  /**
   * Keeps the one-time prekey pool above the low-water mark and the medium-term prekey fresh (spec §6.4.1).
   * Concurrent callers share one run.
   */
  maintainPrekeys(): Promise<{ uploaded: number; rotated: boolean }> {
    if (this.maintenance) return this.maintenance;
    const run = (async () => {
      const { keys, client, active } = this.state;
      if (!keys || !active || !this.prekeys) return { uploaded: 0, rotated: false };
      const uploaded = await replenishPrekeys(client, keys.signing, this.prekeys);
      const rotated = await this.withChainLock(() => this.rotateMpkIfDue());
      return { uploaded, rotated };
    })();
    this.maintenance = run;
    void run.finally(() => {
      if (this.maintenance === run) this.maintenance = null;
    }).catch(() => undefined);
    return run;
  }

  private async rotateMpkIfDue(now = Math.floor(Date.now() / 1000)): Promise<boolean> {
    const { keys, client } = this.state;
    let chain = this.state.chain;
    if (!keys || !chain || !this.prekeys) return false;
    const me = deviceRecord(chain, keys.signing.publicKey);
    if (!me) return false;
    const local = await this.prekeys.list("medium-term");
    const current = me.mpk && local.some((r) => r.id === toB64url(me.mpk!.id));
    if (current && me.mpk && me.mpk.expires - now > MPK_ROTATE_MARGIN_SECONDS) return false;
    const mpk = new SoftwareAgreementKey();
    const id = randomBytes(8);
    const expires = now + MPK_LIFETIME_SECONDS;
    await this.prekeys.putKind(id, mpk.secretKey, "medium-term", expires);
    const statement = await rotateMpkStatement(keys.signing, mpk.publicKey, id, expires);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const link = await makeLink(chain, keys.signing, statement);
        const next = extendChain(chain, [link]);
        await client.appendLinks([link]);
        await this.appendedLinks(next, [link]);
        return true;
      } catch (e) {
        if (attempt === 1) {
          await this.prekeys.delete(id);
          throw e;
        }
        // Another device appended first: refresh and retry on the new head.
        chain = await this.refreshOwnChain();
      }
    }
    return false;
  }

  /** The relay's pool size for this device (diagnostics on the Devices screen). */
  async prekeyCount(): Promise<number> {
    return (await this.state.client.prekeyCount()).count;
  }
}

function deviceRecord(chain: ChainState, signingPublicKey: Uint8Array) {
  return activeDevices(chain).find((d) => ctEqual(compress(d.signingPublicKey), compress(signingPublicKey)));
}

export function isActive(chain: ChainState, signingPublicKey: Uint8Array): boolean {
  return deviceRecord(chain, signingPublicKey) !== undefined;
}

export const session = new Session();

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

