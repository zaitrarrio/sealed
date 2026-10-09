/**
 * R2 object layout (ADR-0012): t/{id}/manifest, t/{id}/s/{n}, t/{id}/p/{k}. Every object carries an `expires`
 * custom metadata field (unix seconds) used by the sweeper; a bucket lifecycle rule (8 days, README) is the
 * backstop for anything the sweeper misses.
 */
import type { Env } from "./env";

export const r2Keys = {
  prefix: (id: string) => `t/${id}/`,
  manifest: (id: string) => `t/${id}/manifest`,
  segment: (id: string, n: number) => `t/${id}/s/${n}`,
  padding: (id: string, k: number) => `t/${id}/p/${k}`,
};

/** Writes one ciphertext part and returns the size R2 stored. */
export async function putPart(env: Env, key: string, body: Uint8Array, expiresAt: number): Promise<number> {
  const obj = await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { expires: String(expiresAt) },
  });
  if (!obj) throw new Error("R2 put returned no object");
  return obj.size;
}

/** Deletes every object under a transfer prefix. Returns the number deleted. */
export async function deleteTransferObjects(env: Env, transferId: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: r2Keys.prefix(transferId), ...(cursor ? { cursor } : {}) });
    const keys = page.objects.map((o) => o.key);
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (batch.length > 0) await env.BUCKET.delete(batch);
      deleted += batch.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

/** Streams an R2 object as an octet-stream response, or null when missing. */
export async function streamPart(env: Env, key: string): Promise<Response | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(obj.size),
      "cache-control": "no-store",
    },
  });
}
