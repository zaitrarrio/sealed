/** A link opened the app that is not a Sealed code from a trusted origin. */
import { router } from "expo-router";
import { Button, P, Screen, Title } from "../src/ui/kit";

export default function UnknownCode() {
  return (
    <Screen>
      <Title eyebrow="Sealed">That code could not be used</Title>
      <P>The link is incomplete or comes from a site this app does not trust. Scan the code again from inside Sealed.</P>
      <Button title="Scan a code" tone="primary" onPress={() => router.replace("/receive")} />
    </Screen>
  );
}
