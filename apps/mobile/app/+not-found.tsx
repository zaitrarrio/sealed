import { router } from "expo-router";
import { Button, P, Screen, Title } from "../src/ui/kit";

export default function NotFound() {
  return (
    <Screen>
      <Title>Nothing here</Title>
      <P>This screen does not exist. If you scanned a code, it may be incomplete.</P>
      <Button title="Go home" onPress={() => router.replace("/")} />
    </Screen>
  );
}
