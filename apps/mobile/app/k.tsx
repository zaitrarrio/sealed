/** A phone camera scanned a reverse key code: continue on the Secure offline send screen with that code. */
import { Redirect, useLocalSearchParams } from "expo-router";

export default function ReverseKeyLanding() {
  const { ref } = useLocalSearchParams<{ ref?: string }>();
  return <Redirect href={ref ? { pathname: "/offline/send", params: { ref } } : "/offline/send"} />;
}
