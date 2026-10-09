import {
  RelayClient,
  SoftwareAgreementKey,
  SoftwareSigningKey,
  createIdentity,
  fromB64url,
  toB64url,
  type AgreementKey,
  type ChainState,
  type DeviceKeys,
  type EnvelopeInput,
  type ExtractSink,
  type FileEntry,
  type KeyProtection,
  type PrekeyStore,
  type SigningKey,
} from "@sealed/core";
import { exports } from "cloudflare:workers";

export const BASE = "https://relay.test";

/** RelayClient fetch adapter that calls the Worker under test in-process. */
export const workerFetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string | null; signal?: AbortSignal }) =>
  exports.default.fetch(input, init as RequestInit);

export function client(identity?: { fingerprint: Uint8Array; signing: SigningKey }): RelayClient {
  return new RelayClient({ baseUrl: BASE, fetch: workerFetch, ...(identity ? { identity } : {}) });
}

class LabeledAgreement implements AgreementKey {
  readonly publicKey: Uint8Array;
  constructor(
    private readonly key: SoftwareAgreementKey,
    readonly protection: KeyProtection,
  ) {
    this.publicKey = key.publicKey;
  }
  dh(peer: Uint8Array): Promise<Uint8Array> {
    return this.key.dh(peer);
  }
}

class LabeledSigning implements SigningKey {
  readonly publicKey: Uint8Array;
  constructor(
    readonly key: SoftwareSigningKey,
    readonly protection: KeyProtection,
  ) {
    this.publicKey = key.publicKey;
  }
  sign(m: Uint8Array): Promise<Uint8Array> {
    return this.key.sign(m);
  }
}

export interface TestDevice extends DeviceKeys {
  label: string;
  protection: KeyProtection;
}

/** Device keys reporting the given protection (stands in for Secure Enclave / StrongBox / WebCrypto keys). */
export function makeDevice(protection: KeyProtection, label = `device-${protection}`): TestDevice {
  return { agreement: new LabeledAgreement(new SoftwareAgreementKey(), protection), signing: new LabeledSigning(new SoftwareSigningKey(), protection), label, protection };
}

export interface TestIdentity {
  device: TestDevice;
  state: ChainState;
  fingerprint: Uint8Array;
  fp: string;
  client: RelayClient;
}

/** Creates an identity on its first device and registers it with the relay. */
export async function makeIdentity(protection: KeyProtection = "secure-enclave", label?: string): Promise<TestIdentity> {
  const device = makeDevice(protection, label);
  const { link, state } = await createIdentity({ signing: device.signing, agreementPublicKey: device.agreement.publicKey, label: device.label, protection });
  const r = await client().createIdentity(link);
  if (r.fingerprint !== toB64url(state.fingerprint)) throw new Error("relay computed a different fingerprint");
  return { device, state, fingerprint: state.fingerprint, fp: r.fingerprint, client: client({ fingerprint: state.fingerprint, signing: device.signing }) };
}

export function bytesOf(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 0xff;
  }
  return b;
}

export function file(path: string, data: Uint8Array, mediaType = "application/octet-stream"): EnvelopeInput {
  return { path, mediaType, size: data.length, data };
}

/** Collects extracted files in memory. */
export class MemorySink implements ExtractSink {
  readonly files = new Map<string, Uint8Array[]>();
  onFileData(entry: FileEntry, chunk: Uint8Array): void {
    const list = this.files.get(entry.path) ?? [];
    list.push(chunk.slice());
    this.files.set(entry.path, list);
  }
  bytes(path: string): Uint8Array {
    const parts = this.files.get(path) ?? [];
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

export class MemoryPrekeyStore implements PrekeyStore {
  private readonly m = new Map<string, Uint8Array>();
  async put(id: Uint8Array, secretKey: Uint8Array): Promise<void> {
    this.m.set(toB64url(id), secretKey);
  }
  async get(id: Uint8Array): Promise<Uint8Array | null> {
    return this.m.get(toB64url(id)) ?? null;
  }
  async delete(id: Uint8Array): Promise<void> {
    this.m.delete(toB64url(id));
  }
  get size(): number {
    return this.m.size;
  }
}

/** A WebSocket client against the Worker; queues messages and lets tests await specific frames. */
export class TestSocket {
  private readonly queue: unknown[] = [];
  private readonly waiting: { pred: (m: unknown) => boolean; resolve: (m: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  closed = false;

  private constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
      } catch {
        msg = ev.data;
      }
      const i = this.waiting.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = this.waiting.splice(i, 1);
        clearTimeout(w!.timer);
        w!.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
    });
  }

  static async open(url: string): Promise<TestSocket> {
    const res = await exports.default.fetch(url.replace(/^ws/, "http"), { headers: { upgrade: "websocket" } });
    if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
    return new TestSocket(res.webSocket);
  }

  next<T = Record<string, unknown>>(pred: (m: T) => boolean = () => true, timeoutMs = 5000): Promise<T> {
    const i = this.queue.findIndex((m) => pred(m as T));
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0] as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiting.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiting.splice(idx, 1);
        reject(new Error(`timed out waiting for frame; queued: ${JSON.stringify(this.queue)}`));
      }, timeoutMs);
      this.waiting.push({ pred: pred as (m: unknown) => boolean, resolve: resolve as (m: unknown) => void, reject, timer });
    });
  }

  send(v: unknown): void {
    this.ws.send(typeof v === "string" ? v : JSON.stringify(v));
  }

  close(): void {
    try {
      this.ws.close(1000, "done");
    } catch {
      // already closed
    }
  }
}

export async function expectRelayError(p: Promise<unknown>, status: number, code?: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    if (err.status !== status || (code !== undefined && err.code !== code)) {
      throw new Error(`expected ${status}${code ? ` ${code}` : ""}, got ${err.status} ${err.code}: ${err.message}`);
    }
    return;
  }
  throw new Error(`expected ${status}${code ? ` ${code}` : ""}, but the call succeeded`);
}

export { fromB64url, toB64url };
