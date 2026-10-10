/**
 * Pairing ceremony (spec §3.5, §6.3.3, ADR-0006). Each side shows its pairing code and scans the other's. The
 * scanned identity's chain is fetched and verified against the fingerprint and head in the code; both screens
 * then show the pairing check code, and each user confirms on their own device before the contact is saved.
 *
 * Reached from Contacts, or from a phone camera that scanned a pairing code (the code arrives via `?ref=`).
 */
import { contactFromPeer, createPairingOffer, ctEqual, pairingCheckCode, verifyScannedPairingCode, type PairingOffer, type ScannedPeer } from "@sealed/core";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { QrCode } from "../src/components/QrCode";
import { Scanner } from "../src/components/Scanner";
import { takeCode } from "../src/lib/code-stash";
import { acceptedOrigins, codeOrigin } from "../src/lib/config";
import { getContact, recordFromContact, saveContact } from "../src/lib/contacts-store";
import { watchContacts } from "../src/lib/inbox";
import { expectCode, friendlyCodeError } from "../src/lib/routing";
import { session, useSession } from "../src/lib/session";
import { B, Button, Card, CheckCode, Disclosure, Field, Notice, P, Row, Screen, Segmented, Spinner, Title, errorMessage } from "../src/ui/kit";

export default function Pair() {
  const s = useSession();
  const { ref } = useLocalSearchParams<{ ref?: string }>();
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [peer, setPeer] = useState<ScannedPeer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [view, setView] = useState<"show" | "scan">("show");
  const landing = useRef<string | null | undefined>(undefined);
  if (landing.current === undefined) landing.current = takeCode(ref);

  const creatingOffer = useRef(false);
  useEffect(() => {
    if (!s.chain || offer || creatingOffer.current) return;
    creatingOffer.current = true;
    const fallback = s.chain;
    void session
      .refreshOwnChain()
      .catch(() => fallback)
      .then((chain) => setOffer(createPairingOffer(codeOrigin(), chain, s.profile.label)))
      .finally(() => {
        creatingOffer.current = false;
      });
  }, [s.chain, s.profile.label, offer]);

  const accept = async (text: string): Promise<string | null> => {
    let code;
    try {
      code = expectCode(text, "pair", acceptedOrigins());
    } catch (e) {
      return friendlyCodeError(e);
    }
    if (s.chain && ctEqual(code.fingerprint, s.chain.fingerprint)) return "That is your own pairing code. Scan the other person's code.";
    setChecking(true);
    try {
      const p = await verifyScannedPairingCode(s.client, code);
      setPeer(p);
      setName(p.label);
      return null;
    } catch (e) {
      return `This pairing code could not be verified: ${errorMessage(e)}`;
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    const code = landing.current;
    if (!code || !s.chain || peer) return;
    landing.current = null;
    void accept(code).then((err) => err && setError(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.chain]);

  if (!s.profile.fingerprint) return <Redirect href="/welcome" />;
  if (!s.chain) {
    return (
      <Screen>
        <Spinner label="Loading your identity…" />
      </Screen>
    );
  }

  const sas = offer && peer ? pairingCheckCode(offer.nonce, s.chain, peer) : null;

  return (
    <Screen>
      <Title eyebrow="Pair">Pair with someone in person</Title>
      <P>Show each other your codes and scan them. After pairing you can send files to each other from anywhere. Pairing only works face to face: that is what makes it trustworthy.</P>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!peer ? (
        <View style={{ gap: 12 }}>
          <Segmented
            label="Pairing step"
            value={view}
            onChange={setView}
            options={[
              ["show", "My code"],
              ["scan", "Scan theirs"],
            ]}
          />
          {view === "show" ? (
            offer ? (
              <View style={{ gap: 12 }}>
                <QrCode text={offer.code} label="Your pairing code" testID="pairing-code" />
                <P tone="subtle">Let them scan this, then scan theirs.</P>
              </View>
            ) : (
              <Spinner label="Preparing your code…" />
            )
          ) : (
            <Scanner label="Scan their pairing code" onCode={accept} />
          )}
          {checking ? <Spinner label="Verifying their identity…" /> : null}
        </View>
      ) : null}
      {peer && sas && offer ? (
        <>
          <Card>
            <P tone="default">
              Verified <B>{peer.label}</B>'s identity ({[...peer.chain.devices.values()].filter((d) => d.revokedSeq === undefined).length} active devices).
            </P>
            <CheckCode value={sas} label="Pairing check code" testID="pair-sas" />
            <P>Compare with their screen. Both of you must see the same six digits. If they differ, stop: someone is in the middle.</P>
            <P>Make sure they have scanned your code too, so they can confirm on their side.</P>
            <Disclosure title="Show my code again">
              <QrCode text={offer.code} label="Your pairing code" size={180} />
            </Disclosure>
          </Card>
          <Field label="Save as" value={name} maxLength={60} onChangeText={setName} testID="contact-name" />
          <Row>
            <Button
              title="The codes match — save contact"
              tone="primary"
              busy={saving}
              disabled={!name.trim()}
              testID="confirm-pair"
              onPress={() => {
                setSaving(true);
                setError(null);
                void (async () => {
                  try {
                    const contact = contactFromPeer(peer, name.trim());
                    // Cache exactly the links that were verified against the scanned code, not a second fetch.
                    const links = peer.links;
                    const existing = await getContact(recordFromContact(contact, links).id);
                    await saveContact({ ...recordFromContact(contact, links), ...(existing ? { pairedAt: existing.pairedAt } : {}) });
                    await watchContacts();
                    router.replace({ pathname: "/contacts", params: { paired: name.trim() } });
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setSaving(false);
                  }
                })();
              }}
            />
            <Button
              title="They do not match"
              tone="ghost"
              onPress={() => {
                setPeer(null);
                setOffer(null);
              }}
            />
          </Row>
        </>
      ) : null}
    </Screen>
  );
}
