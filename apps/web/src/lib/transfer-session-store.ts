/**
 * Transfer session store (spec §3.3, §6.1). Keeps active ShareSessions alive independently of React
 * component mounts so navigating away, switching tabs, or StrictMode remounts cannot cancel an in-flight
 * transfer and wipe R2 ciphertext. Transfers end only on explicit cancel, receiver completion, or TTL.
 */
import type { ShareSession } from "@sealed/core";

export interface ActiveShare {
  session: ShareSession;
  abort: AbortController;
  /** True once any claim has been approved or downloaded. */
  anyApproved: boolean;
  startedAt: number;
}

type Listener = () => void;

class TransferSessionStore {
  private active: ActiveShare | null = null;
  private listeners = new Set<Listener>();

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): ActiveShare | null => this.active;

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Registers a newly started share as the sole active transfer. Cancels any previous unfinished share. */
  adopt(session: ShareSession, abort: AbortController): void {
    const previous = this.active;
    this.active = { session, abort, anyApproved: false, startedAt: Date.now() };
    this.emit();
    if (previous && previous.session.transferId !== session.transferId) {
      previous.abort.abort();
      void previous.session.cancel().catch(() => undefined);
    }
  }

  markApproved(): void {
    if (!this.active) return;
    this.active = { ...this.active, anyApproved: true };
    this.emit();
  }

  /** Explicit user cancel or TTL expiry cleanup. Safe to call when no transfer is active. */
  async cancel(): Promise<void> {
    const cur = this.active;
    if (!cur) return;
    this.active = null;
    this.emit();
    cur.abort.abort();
    await cur.session.cancel().catch(() => undefined);
  }

  /** Drops the local handle without cancelling on the relay (e.g. after expiry or successful room close). */
  release(): void {
    this.active = null;
    this.emit();
  }

  get current(): ActiveShare | null {
    return this.active;
  }
}

export const transferSessions = new TransferSessionStore();
