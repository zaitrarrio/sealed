/**
 * Transfer session store (spec §3.3, §6.1). Keeps active ShareSessions alive independently of screen
 * mounts so navigating away cannot cancel an in-flight transfer and wipe relay ciphertext.
 */
import type { ShareSession } from "@sealed/core";

export interface ActiveShare {
  session: ShareSession;
  abort: AbortController;
  anyApproved: boolean;
  startedAt: number;
}

class TransferSessionStore {
  private active: ActiveShare | null = null;

  adopt(session: ShareSession, abort: AbortController): void {
    const previous = this.active;
    this.active = { session, abort, anyApproved: false, startedAt: Date.now() };
    if (previous && previous.session.transferId !== session.transferId) {
      previous.abort.abort();
      void previous.session.cancel().catch(() => undefined);
    }
  }

  markApproved(): void {
    if (this.active) this.active.anyApproved = true;
  }

  async cancel(): Promise<void> {
    const cur = this.active;
    if (!cur) return;
    this.active = null;
    cur.abort.abort();
    await cur.session.cancel().catch(() => undefined);
  }

  release(): void {
    this.active = null;
  }

  get current(): ActiveShare | null {
    return this.active;
  }
}

export const transferSessions = new TransferSessionStore();
