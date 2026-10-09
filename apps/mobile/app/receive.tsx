/** Receive: scan any Sealed code (or paste it) and route to the screen that handles it. */
import { router } from "expo-router";
import { Scanner } from "../src/components/Scanner";
import { inAppRouteFor } from "../src/lib/code-stash";
import { acceptedOrigins } from "../src/lib/config";
import { friendlyCodeError } from "../src/lib/routing";
import { Button, Row, Screen, Title } from "../src/ui/kit";

export default function Receive() {
  return (
    <Screen>
      <Title eyebrow="Receive">Scan the code on their screen</Title>
      <Scanner
        onCode={(text) => {
          try {
            router.replace(inAppRouteFor(text, acceptedOrigins()) as never);
            return null;
          } catch (e) {
            return friendlyCodeError(e);
          }
        }}
      />
      <Row>
        <Button title="Receive offline" tone="ghost" onPress={() => router.push("/offline/receive")} />
        <Button title="Receive a broadcast" tone="ghost" onPress={() => router.push("/broadcast/receive")} />
      </Row>
    </Screen>
  );
}
