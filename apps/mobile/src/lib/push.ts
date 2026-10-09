/**
 * Push for stored deliveries (spec §6.4.2). The relay sends a *silent* push — APNs background / FCM data —
 * carrying only the transfer id, never names or contents. The app wakes, and a background task posts a local
 * notification ("Files are waiting"); in the foreground the inbox refreshes instead. Tapping opens the inbox.
 *
 * Push tokens are the platform's own (APNs device token, FCM registration token), registered with the relay
 * over a device-signed request; no third-party push service sits in between.
 */
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { session } from "./session";

export const BACKGROUND_PUSH_TASK = "sealed.background-push";

TaskManager.defineTask(BACKGROUND_PUSH_TASK, async () => {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: "Sealed", body: "Files are waiting for you. Open Sealed to receive them.", data: { route: "/inbox" } },
      trigger: null,
    });
  } catch {
    // Nothing useful to do from a background task.
  }
});

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export type PushRegistration = "registered" | "denied" | "unavailable";

export async function registerForPush(): Promise<PushRegistration> {
  const current = await Notifications.getPermissionsAsync();
  let granted = current.granted;
  if (!granted && current.canAskAgain) granted = (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return "denied";
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("deliveries", { name: "Deliveries", importance: Notifications.AndroidImportance.DEFAULT });
  }
  let token: Notifications.DevicePushToken;
  try {
    token = await Notifications.getDevicePushTokenAsync();
  } catch {
    // No APNs entitlement / google-services.json in this build.
    return "unavailable";
  }
  const s = session.getSnapshot();
  if (!s.active) return "unavailable";
  await s.client.registerPush(token.type === "ios" ? "apns" : "fcm", String(token.data));
  await Notifications.registerTaskAsync(BACKGROUND_PUSH_TASK).catch(() => undefined);
  await session.updateSettings({ pushEnabled: true });
  return "registered";
}

/**
 * Wires foreground pushes to `onDelivery` (refresh the inbox) and taps to `onOpen` (navigate). Re-registers
 * the token when the platform rotates it. Returns an unsubscribe function.
 */
export function listenForPush(onDelivery: () => void, onOpen: (route: string) => void): () => void {
  const received = Notifications.addNotificationReceivedListener(() => onDelivery());
  const response = Notifications.addNotificationResponseReceivedListener((r) => {
    const route = (r.notification.request.content.data as { route?: unknown } | undefined)?.route;
    onOpen(typeof route === "string" && route.startsWith("/") ? route : "/inbox");
  });
  const rotated = Notifications.addPushTokenListener((t) => {
    const s = session.getSnapshot();
    if (s.active && s.settings.pushEnabled) void s.client.registerPush(t.type === "ios" ? "apns" : "fcm", String(t.data)).catch(() => undefined);
  });
  return () => {
    received.remove();
    response.remove();
    rotated.remove();
  };
}
