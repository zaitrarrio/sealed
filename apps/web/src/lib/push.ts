/**
 * Web Push (spec §6.4.2 step 4): the relay notifies this device of new mailbox deliveries with a payload that
 * contains only the transfer id. Requires VITE_VAPID_PUBLIC_KEY (the relay's VAPID key) and a service worker.
 */
import { fromB64url } from "@sealed/core";
import { buf } from "./bytes";
import { env } from "./config";
import { session } from "./session";

export function pushSupported(): boolean {
  return Boolean(env.vapidPublicKey) && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  return existing ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Subscribes this browser and registers the subscription with the relay for this device. */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error("Notifications are not available in this browser or are not configured.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed.");
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: buf(fromB64url(env.vapidPublicKey)) }));
  await session.getSnapshot().client.registerPush("webpush", JSON.stringify(sub.toJSON()));
  await session.updateSettings({ pushEnabled: true });
}

export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } finally {
    await session.updateSettings({ pushEnabled: false });
  }
}
