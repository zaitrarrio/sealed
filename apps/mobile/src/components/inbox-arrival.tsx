/** Banner for a delivery that arrived while this phone was open. The inbox screen opens it. */
import { color, radius, space } from "@sealed/tokens";
import { router, usePathname } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getContact } from "../lib/contacts-store";
import { dismissArrival, useInbox } from "../lib/inbox";
import { useSession } from "../lib/session";
import { B, Button, P, Row } from "../ui/kit";

export function InboxArrivalBanner() {
  const inbox = useInbox();
  const s = useSession();
  const path = usePathname();
  const insets = useSafeAreaInsets();
  const arrival = inbox.arrivals[0];
  const [label, setLabel] = useState("Someone");

  useEffect(() => {
    if (!arrival) return;
    if (s.profile.fingerprint && arrival.senderFp === s.profile.fingerprint) {
      setLabel("you, from another device");
      return;
    }
    let cancel = false;
    void getContact(arrival.senderFp).then((c) => {
      if (!cancel) setLabel(c?.displayName ?? "someone you paired with");
    });
    return () => {
      cancel = true;
    };
  }, [arrival, s.profile.fingerprint]);

  if (!arrival || path === "/inbox") return null;
  const extra = inbox.arrivals.length > 1 ? ` · ${inbox.arrivals.length} new` : "";

  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: space.md, right: space.md, bottom: Math.max(insets.bottom, space.md) }}>
      <View testID="inbox-arrival" accessibilityLiveRegion="polite" style={{ gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: color.amber, backgroundColor: color.amberSoft }}>
        <B>{`From ${label}`}</B>
        <P tone="subtle">{`In your inbox${extra}`}</P>
        <Row>
          <Button title="Open" tone="primary" small onPress={() => router.push("/inbox")} />
          <Button title="Dismiss" tone="ghost" small onPress={() => dismissArrival(arrival.id)} />
        </Row>
      </View>
    </View>
  );
}
