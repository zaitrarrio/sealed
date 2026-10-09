import { Text } from "react-native";
import { claimSas, TIERS } from "@sealed/core";
import { color } from "@sealed/tokens";
export default function Home() {
  return <Text style={{ color: color.text }}>{claimSas(new Uint8Array(16), new Uint8Array(16), new Uint8Array(65)) + String(TIERS[1].grid)}</Text>;
}
