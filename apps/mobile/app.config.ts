/**
 * Expo app configuration. Universal links (iOS) and verified app links (Android) claim the code landing paths on
 * the web origin — /c/*, /p, /d, /k (packages/core protocol/codes.ts) — so a phone camera that scans a Sealed
 * code opens this app directly; without the app installed the same URL opens the web client.
 *
 * EXPO_PUBLIC_WEB_ORIGIN  origin written into displayed codes and claimed by the link associations
 * EXPO_PUBLIC_RELAY_URL   default relay (users can override it in Settings)
 * SEALED_IOS_BUNDLE_ID / SEALED_ANDROID_PACKAGE / SEALED_APPLE_TEAM_ID / EAS_PROJECT_ID   build identity
 */
import type { ConfigContext, ExpoConfig } from "expo/config";

const DEFAULT_WEB_ORIGIN = "https://sealed.to";

function originHost(origin: string): { host: string; scheme: "https" | "http" } {
  const u = new URL(origin);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`EXPO_PUBLIC_WEB_ORIGIN must be an http(s) origin, got ${origin}`);
  return { host: u.host, scheme: u.protocol === "https:" ? "https" : "http" };
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const webOrigin = (process.env.EXPO_PUBLIC_WEB_ORIGIN || DEFAULT_WEB_ORIGIN).replace(/\/+$/, "");
  const { host, scheme } = originHost(webOrigin);
  const bundleId = process.env.SEALED_IOS_BUNDLE_ID || "to.sealed.app";
  const androidPackage = process.env.SEALED_ANDROID_PACKAGE || "to.sealed.app";
  const easProjectId = process.env.EAS_PROJECT_ID;
  const appleTeamId = process.env.SEALED_APPLE_TEAM_ID;

  // Android: one verified filter per code path. pathPrefix "/c/" covers claim codes; the others are exact paths.
  const linkData = [
    { scheme, host, pathPrefix: "/c/" },
    { scheme, host, path: "/p" },
    { scheme, host, path: "/d" },
    { scheme, host, path: "/k" },
  ];

  return {
    ...config,
    name: "Sealed",
    slug: "sealed",
    scheme: "sealed",
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "dark",
    backgroundColor: "#14110F",
    platforms: ["ios", "android"],
    ios: {
      bundleIdentifier: bundleId,
      supportsTablet: true,
      deploymentTarget: "16.4",
      ...(appleTeamId ? { appleTeamId } : {}),
      associatedDomains: [`applinks:${host}`, `webcredentials:${host}`],
      infoPlist: {
        NSCameraUsageDescription: "Sealed uses the camera to scan codes and to receive files streamed from another screen.",
        NSFaceIDUsageDescription: "Sealed uses Face ID to unlock this device's keys when you approve or open a transfer.",
        NSMicrophoneUsageDescription: "Sealed does not record audio. WebRTC requires this declaration for direct transfers.",
        UIBackgroundModes: ["remote-notification"],
        ITSAppUsesNonExemptEncryption: true,
      },
    },
    android: {
      package: androidPackage,
      blockedPermissions: ["android.permission.RECORD_AUDIO", "android.permission.SYSTEM_ALERT_WINDOW"],
      permissions: ["android.permission.CAMERA", "android.permission.USE_BIOMETRIC", "android.permission.POST_NOTIFICATIONS", "android.permission.INTERNET"],
      intentFilters: [
        {
          action: "VIEW",
          autoVerify: true,
          data: linkData,
          category: ["BROWSABLE", "DEFAULT"],
        },
      ],
      ...(process.env.GOOGLE_SERVICES_JSON ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON } : {}),
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-sharing",
      [
        "expo-notifications",
        {
          color: "#E8A33D",
          enableBackgroundRemoteNotifications: true,
        },
      ],
      ["expo-build-properties", { android: { minSdkVersion: 31 }, ios: {} }],
      ["@config-plugins/react-native-webrtc", { cameraPermission: "Sealed uses the camera to scan codes.", microphonePermission: "Sealed does not record audio." }],
      ["react-native-quick-crypto", { sodiumEnabled: false }],
      "expo-dev-client",
    ],
    experiments: { typedRoutes: false },
    extra: {
      webOrigin,
      relayUrl: process.env.EXPO_PUBLIC_RELAY_URL || "https://relay.sealed.to",
      ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
    },
  };
};
