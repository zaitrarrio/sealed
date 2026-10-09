/** The security explainer (spec §11–12): what the relay can and cannot see, and what this phone keeps. */
import { color } from "@sealed/tokens";
import { View } from "react-native";
import { H2, P, Screen, Title } from "../src/ui/kit";

const ROWS: [string, string, string][] = [
  ["File contents, names, types, counts", "No", "—"],
  ["Ciphertext size", "Rounded up to a size bucket", "Until the transfer expires"],
  ["Sender account", "Yes", "Account lifetime"],
  ["Receiver (Direct and Room)", "Device public key hash and the device name you typed", "Until the transfer expires"],
  ["Who sends to whom (Paired)", "Delivery events between identity fingerprints", "Mailbox lifetime; only aggregates after"],
  ["IP addresses", "Hashed with a key that rotates daily", "7 days unless tied to an abuse report"],
  ["Timestamps", "Rounded to the hour in logs", "90 days"],
  ["Your contact list", "No — it stays on your devices", "—"],
];

export default function Security() {
  return (
    <Screen>
      <Title eyebrow="Security">What the relay can and cannot see</Title>
      <P>
        Files are encrypted on the sending device before anything is uploaded. The relay stores and forwards ciphertext; it never holds a key that opens your files, and it cannot add itself as a recipient
        without the check codes on both screens disagreeing.
      </P>
      <View>
        {ROWS.map(([a, b, c]) => (
          <View key={a} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: color.line, gap: 2 }}>
            <P tone="default">{a}</P>
            <P>{b}</P>
            <P tone="subtle">{`Kept: ${c}`}</P>
          </View>
        ))}
      </View>
      <H2>On this phone</H2>
      <P>• Device keys live in the Secure Enclave (iPhone) or the Android Keystore (StrongBox or TEE). They cannot be read out, and every use is unlocked with your face, fingerprint or passcode.</P>
      <P>• Approving a share, adding or revoking a device and creating a paper key always ask for Face ID / fingerprint, even if Sealed was just unlocked.</P>
      <P>• Received files are stored encrypted, each under a key wrapped to the hardware key. Opening or saving one asks for Face ID / fingerprint. Copies you save elsewhere are ordinary files Sealed cannot recall.</P>
      <P>• If you change your enrolled fingerprints or face, the keys are invalidated by design. Use another device or your paper key to add this phone again.</P>
      <P>• Contacts are stored on this phone (encrypted), not on the relay.</P>
      <H2>Offline modes</H2>
      <P>
        Secure offline streams are encrypted to the receiving device's key, scanned from its screen, so filming the stream reveals nothing. Broadcasts are open by design: anyone in view can decode them. A
        signature tells you who published a broadcast only if you have paired with them.
      </P>
    </Screen>
  );
}
