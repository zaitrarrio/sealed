export const shared: { uri: string; bytes?: Uint8Array }[] = [];
export async function isAvailableAsync(): Promise<boolean> {
  return true;
}
export async function shareAsync(uri: string): Promise<void> {
  const { __fs } = await import("./expo-file-system");
  shared.push({ uri, bytes: __fs.files.get(uri)?.slice() });
}
