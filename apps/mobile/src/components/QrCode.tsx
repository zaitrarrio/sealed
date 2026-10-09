/** A QR code (EC level M, spec §6.1.1): house ink on a paper background, with a quiet zone, for any camera. */
import { color, radius } from "@sealed/tokens";
import { View } from "react-native";
import QRCode from "react-native-qrcode-svg";

export function QrCode({ text, label, size = 260, testID }: { text: string; label: string; size?: number; testID?: string }) {
  return (
    <View
      style={{ padding: 16, backgroundColor: color.paper, borderRadius: radius.md, alignSelf: "center" }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      testID={testID}
    >
      <QRCode value={text} size={size} ecl="M" color={color.ink} backgroundColor={color.paper} quietZone={0} />
    </View>
  );
}
