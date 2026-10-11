/**
 * Claim secret stash (spec §6.1.2). The claim secret lives in the URL fragment and is stripped from the
 * address bar after first read so it never appears in history or referrer logs. Session storage keeps it
 * for the lifetime of the tab so a reload mid-claim can resume without rescanning.
 */
const PREFIX = "sealed-claim:";

export function stashClaimSecret(transferId: string, claimSecret: string): void {
  try {
    sessionStorage.setItem(`${PREFIX}${transferId}`, claimSecret);
  } catch {
    // private mode / quota — best effort
  }
}

export function takeClaimSecret(transferId: string, fromHash: string): string | null {
  const fromFragment = fromHash.replace(/^#/, "");
  if (fromFragment) {
    stashClaimSecret(transferId, fromFragment);
    return fromFragment;
  }
  try {
    return sessionStorage.getItem(`${PREFIX}${transferId}`);
  } catch {
    return null;
  }
}

export function clearClaimSecret(transferId: string): void {
  try {
    sessionStorage.removeItem(`${PREFIX}${transferId}`);
  } catch {
    // ignore
  }
}
