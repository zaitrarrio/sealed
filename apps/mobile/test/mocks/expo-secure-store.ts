const items = new Map<string, string>();
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 0;
export async function getItemAsync(k: string): Promise<string | null> {
  return items.get(k) ?? null;
}
export async function setItemAsync(k: string, v: string): Promise<void> {
  items.set(k, v);
}
export async function deleteItemAsync(k: string): Promise<void> {
  items.delete(k);
}
export const __items = items;
