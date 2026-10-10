/**
 * Root layout: waits for fonts and the AES-GCM self-test (src/polyfills.ts), starts the session (device keys,
 * profile, relay client, presence), attaches the inbox, and wires push notifications.
 */
import { DMSans_400Regular } from "@expo-google-fonts/dm-sans/400Regular";
import { DMSans_700Bold } from "@expo-google-fonts/dm-sans/700Bold";
import { Fraunces_400Regular } from "@expo-google-fonts/fraunces/400Regular";
import { Fraunces_600SemiBold } from "@expo-google-fonts/fraunces/600SemiBold";
import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono/400Regular";
import { JetBrainsMono_600SemiBold } from "@expo-google-fonts/jetbrains-mono/600SemiBold";
import { color } from "@sealed/tokens";
import { useFonts } from "expo-font";
import { Stack, router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { attachInbox, refreshInbox } from "../src/lib/inbox";
import { launchNotificationRoute, listenForPush } from "../src/lib/push";
import { session, useSession } from "../src/lib/session";
import { cryptoReady } from "../src/polyfills";
import { Notice, P, Screen, Spinner, fonts } from "../src/ui/kit";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ DMSans_400Regular, DMSans_700Bold, Fraunces_400Regular, Fraunces_600SemiBold, JetBrainsMono_400Regular, JetBrainsMono_600SemiBold });
  const [crypto, setCrypto] = useState(false);
  const s = useSession();
  const ready = (fontsLoaded || fontError !== null) && crypto;

  useEffect(() => {
    void cryptoReady.then(() => setCrypto(true));
    session.start();
  }, []);

  useEffect(() => {
    attachInbox();
  }, [s.presence, s.active, s.keys]);

  // Notification taps navigate only once the navigator is mounted (status "ready"); a tap that launched the app
  // is picked up from the last notification response.
  const [pendingRoute, setPendingRoute] = useState<string | null>(null);
  useEffect(() => {
    void launchNotificationRoute().then((r) => r && setPendingRoute(r));
    return listenForPush(() => void refreshInbox(), setPendingRoute);
  }, []);
  useEffect(() => {
    if (!pendingRoute || s.status !== "ready" || !ready) return;
    const route = pendingRoute;
    setPendingRoute(null);
    // One frame later, so the Stack rendered in this commit has registered with the router.
    requestAnimationFrame(() => router.push(route as never));
  }, [pendingRoute, s.status, ready]);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {s.status === "ready" ? (
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: color.bg },
            headerTintColor: color.text,
            headerTitleStyle: { fontFamily: fonts.display },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: color.bg },
            headerBackButtonDisplayMode: "minimal",
          }}
        >
          <Stack.Screen name="index" options={{ title: "Sealed" }} />
          <Stack.Screen name="welcome" options={{ title: "Set up" }} />
          <Stack.Screen name="share" options={{ title: "Share" }} />
          <Stack.Screen name="receive" options={{ title: "Receive" }} />
          <Stack.Screen name="c/[transferId]" options={{ title: "Receive", headerBackVisible: false, gestureEnabled: false }} />
          <Stack.Screen name="p" options={{ title: "Pair" }} />
          <Stack.Screen name="d" options={{ title: "Add a device" }} />
          <Stack.Screen name="k" options={{ title: "Share offline" }} />
          <Stack.Screen name="contacts/index" options={{ title: "Contacts" }} />
          <Stack.Screen name="contacts/[fp]" options={{ title: "Send" }} />
          <Stack.Screen name="inbox" options={{ title: "Inbox" }} />
          <Stack.Screen name="files" options={{ title: "Received files" }} />
          <Stack.Screen name="devices" options={{ title: "Devices" }} />
          <Stack.Screen name="offline/index" options={{ title: "Share offline" }} />
          <Stack.Screen name="offline/send" options={{ title: "Secure offline" }} />
          <Stack.Screen name="offline/receive" options={{ title: "Receive offline" }} />
          <Stack.Screen name="broadcast/index" options={{ title: "Broadcast" }} />
          <Stack.Screen name="broadcast/receive" options={{ title: "Receive a broadcast" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
          <Stack.Screen name="security" options={{ title: "Security" }} />
          <Stack.Screen name="unknown-code" options={{ title: "Sealed" }} />
        </Stack>
      ) : (
        <Screen>
          {s.status === "loading" ? <Spinner label="Opening this phone's keys…" /> : null}
          {s.status === "error" ? (
            <Notice tone="danger">
              <P tone="danger">{`Sealed could not open this phone's keys or storage: ${s.error}`}</P>
            </Notice>
          ) : null}
        </Screen>
      )}
    </SafeAreaProvider>
  );
}
