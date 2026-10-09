# Abstract

Handing a file to the person standing in front of you is still surprisingly hard. It usually means exchanging an email address or phone number, sending a link that can be forwarded indefinitely, or relying on a proximity feature that works within one ecosystem. Each of those options also places trust in a provider that can read the file, or in a network that may not be available.

Sealed takes a different approach: **the screen is the handshake.** One device shows a code; another scans it. The file is encrypted on the sender's device before it leaves, the recipient's key is bound to their phone's secure hardware, and the sender approves with a biometric after both screens show the same check code. When a network is available, the code is only a handshake and the file moves at network speed through a relay that stores nothing it can read. When no network is available, or none is permitted, the same screen streams the file itself through light, using a purpose-built screen-to-camera codec.

This paper describes the problem, the principles behind Sealed, its five modes of use, how the system works, its security properties and limits, and how it compares with existing tools.

# 1. The problem

## 1.1 Sharing with someone nearby still routes through strangers

Most file sharing is designed for distance. Email, cloud links and messaging apps assume the two people are somewhere else, and they resolve that by inserting identifiers (an address, a number, an account) and intermediaries (a mail server, a cloud provider, a messaging service). When the two people are in the same room, that machinery is pure overhead: they must exchange personal identifiers they may not want to share, and the file passes through a provider that can usually read it.

Proximity features address part of this. Apple's AirDrop is excellent between Apple devices. Since late 2025, Google's Quick Share can interoperate with AirDrop on supported Android phones, but only when the iPhone is set to receive from "Everyone for 10 minutes," an open discovery mode, rather than from contacts. Apple introduced that 10-minute limit globally in iOS 16.2 in December 2022 precisely because open discovery invites unsolicited and unwanted transfers. Cross-platform sharing has improved, but it has done so by depending on the least-authenticated setting.

## 1.2 File transfer infrastructure is a recurring breach target

Systems built to move files between organizations have repeatedly been the point of failure. The 2023 MOVEit Transfer exploitation affected roughly 2,773 organizations and about 96 million individuals by mid-2024 according to Emsisoft's tracking. Accellion's file-transfer appliance and Cleo's file-transfer software were exploited in similar campaigns. Verizon's 2025 Data Breach Investigations Report found third-party involvement in 30% of breaches, double the prior year. IBM's 2025 Cost of a Data Breach study put the average breach in the United States at a record $10.22 million.

The common factor is that these systems hold plaintext, or the keys to it, on servers. Whoever compromises the server compromises the files.

## 1.3 Providers increasingly want rights to the content

In July 2025, WeTransfer's updated terms of service granted it a broad licence over user content, including language covering machine learning; the company revised the terms within weeks after public backlash. Whatever the intent, the episode illustrated that when a provider can read files, users depend on the provider's policies rather than on the technology.

## 1.4 Some places cannot use networks at all

Secure facilities, regulated environments, field operations and disaster zones routinely have no network, or prohibit connecting to one. Removable media is the usual workaround, and it has its own history: in 2008 the US Department of Defense banned thumb drives on its networks after the Agent.btz worm spread through them, an incident the Deputy Secretary of Defense later described as the most significant breach of US military computers at the time. Dedicated one-way hardware ("data diodes") and accredited cross-domain systems solve this for institutions that can afford them, but not for a field team, a clinic, or a person moving a key to an offline wallet.

# 2. Design principles

**Possession is the credential.** Being physically in front of a screen, and confirming a six-digit check code that both devices show, is stronger evidence of who you are dealing with than an email address. Sealed uses physical presence to establish trust, and never needs identifiers from the recipient.

**The relay is blind.** Every file is encrypted on the sender's device under a fresh key. That key leaves the device only wrapped to the recipient device's public key. The relay stores ciphertext, routes messages and cannot decrypt anything, even if fully compromised.

**Keys live in hardware.** Recipient keys are generated inside the phone's secure hardware (Apple's Secure Enclave, Android StrongBox or TEE) and cannot be exported. Using them requires the owner's face, fingerprint or passcode.

**Network first, light second.** The same encrypted file format travels over a server, a direct peer-to-peer connection, or a stream of on-screen frames. Users get speed when a network exists and continuity when it does not.

**Open when intended, authentic always.** Some files should reach everyone present, such as evacuation maps or meeting handouts. Sealed supports deliberate open broadcasts, and lets publishers sign them so receivers can tell an official broadcast from an impostor.

**Standards, not inventions.** Sealed uses IETF and NIST primitives with published test vectors: HPKE (RFC 9180) for key encapsulation, AES-256-GCM, ECDSA and HKDF over P-256 and SHA-256, and RaptorQ (RFC 6330) fountain codes for optical transfer. These algorithms are also compatible with FIPS 140-3 validated modules, which matters for government use.

# 3. Five modes

Sealed presents five modes, each answering a different everyday situation. Underneath, they are combinations of two building blocks: how the encrypted bytes move (relay storage, a live peer-to-peer link, or light) and how the recipient gets the key (a scanned claim, a previous pairing, a key shown back to the sender, or deliberately no restriction).

## 3.1 Direct: hand a file to the person in front of you

You select a contract, a set of photos or a Google Drive folder and tap Share. Your screen shows a code. The other person scans it with their camera. Both phones show the same six digits; you confirm and approve with Face ID. The file arrives on their phone, encrypted to that phone alone. There is no email address, no phone number and no link. A photograph of your screen is useless, because the code can be used only once and only with your approval.

## 3.2 Room: share with everyone present

A presenter puts one code on the projector. Everyone in the room scans it during a set window. The presenter approves devices individually, in batches, or automatically, and can revoke any device afterwards. Each attendee's copy is encrypted to their own device, so the presenter can see who received the material without collecting anyone's email address and without posting a link that circulates indefinitely.

## 3.3 Paired: a private channel with people you trust

Two people meet once and scan each other's codes, as you might verify a contact in Signal. From then on they can send each other files from anywhere, at any time, without scanning again. If both are online, files travel directly between their devices; if not, encrypted files wait in the recipient's mailbox. The pairing covers each person's other devices too, and survives a new phone. Because trust came from meeting in person, an impostor cannot insert themselves later.

## 3.4 Air-gap: move files where networks are not allowed

The receiving device stays offline. It displays a small code containing its public key; the sender's camera scans it, and both screens show a check code. The sender's screen then streams the file as a sequence of dense color frames, and the receiver records them with its camera until the progress display reaches 100%. Anyone else filming the stream captures only ciphertext. No network connection, cable or USB drive is involved.

## 3.5 Broadcast: data with no connectivity at all

A screen loops a file as a stream of frames. Anyone who points a phone at it receives the file, and can join at any moment. This mode is deliberately open: it is for maps, forms and instructions that should reach everyone present when networks are down, overloaded or censored. Publishers can sign broadcasts so that receivers see "Signed by" a verified name.

# 4. How it works

## 4.1 The encrypted envelope

Every transfer is packaged as an **Envelope**: a manifest describing the files, followed by the content in 1 MiB segments. The sender's device generates a random 256-bit key, compresses the content, and encrypts each segment with AES-256-GCM in a construction that prevents segments from being reordered, duplicated or truncated without detection. The manifest is encrypted too, so even file names are hidden from the relay. Ciphertext sizes are padded to fixed buckets to limit what size reveals.

The Envelope is identical regardless of transport. A file received through light is byte-for-byte the same as one downloaded from the relay.

## 4.2 Claim and approve

A displayed code in Direct mode contains a transfer identifier and a one-time **claim secret**. The secret sits in the part of the web address that browsers never send to servers, and the relay stores only its hash. When a phone scans the code, it submits the secret together with its own hardware-bound public key. The relay accepts exactly one claim.

Both devices then compute a six-digit check code from the claim secret and the receiver's public key. The relay never learns the claim secret, so if it tried to substitute its own key, the two screens would show different digits. The sender compares, approves with a biometric, and only then does the sender's device wrap the file key to the receiver's public key using HPKE. The receiver downloads, unwraps with its own biometric, and decrypts.

## 4.3 Identity and pairing

People have several devices and replace them. Sealed represents a person as a **signed chain of devices**: an append-only log in which each new device is added by a signature from an existing one, and lost devices are revoked the same way. A person's identity fingerprint is the hash of the first entry. During pairing, each person scans the other's fingerprint, both devices verify each other's chains, and both confirm a shared check code.

After pairing, Sealed accepts changes to a contact's device list only if every entry verifies back to the fingerprint that was scanned in person. A new phone shows a notice; a forged or forked chain blocks sending and shows a warning. Recovery uses a printed paper key created at setup; Sealed staff cannot add devices to anyone's identity, which is what keeps the relay blind.

For files that wait in a mailbox, Sealed uses one-time **prekeys** that recipient devices publish in advance and delete after use. If a phone's long-term key were later compromised, past files already received through one-time prekeys would remain protected.

## 4.4 The optical channel

Standard QR codes are designed for print. Animated QR codes with fountain coding have been demonstrated for years and are the established method for moving transaction data to offline cryptocurrency wallets, but they typically achieve only tens of kilobytes per second. Research on screen-to-camera communication, and the open-source libcimbar project in particular, has shown that codecs designed for screens can do much better: libcimbar reports roughly 106 KB/s on a mid-range phone using colored shapes in a dense grid.

Sealed's codec, **Facet**, follows this line of work and is designed for Sealed's own receivers:

- **Color and shape.** Each cell carries a color from a calibrated palette and one of 16 shapes. Shapes survive blur; colors survive scale.
- **Calibration.** The stream begins, and periodically repeats, with a frame of reference swatches. Each receiver learns how its particular camera sees that particular screen, then locks focus, exposure and white balance.
- **Two layers of error correction.** Within each frame, interleaved Reed-Solomon codes repair scattered errors such as glare or misread cells. Across frames, RaptorQ fountain codes mean any sufficient set of frames, in any order, reconstructs the file. Missed frames simply do not matter, and a broadcast receiver can join at any moment.
- **Record, then decode.** Native receivers capture raw frames at high frame rates and decode them on the GPU from a buffer, rather than racing to decode each frame in real time. A lightweight live pass shows progress so the user knows when to stop.
- **Tiers.** Receivers report their capability, and the sender adapts density. Design targets range from about 60 KB/s for browser receivers to about 240 KB/s for native receivers on high-frame-rate cameras, with a standard QR fallback that any device can read. At about 100 KB/s, a 10 MB file transfers in under two minutes.

These targets are validated against a corpus of real captures across phones and displays before Air-gap mode is released.

## 4.5 Bringing files from cloud drives

Sealed can share files the user keeps in Google Drive and similar services. The user picks files in Google's own picker, which grants Sealed access only to those items (the `drive.file` scope). The sender's device downloads them, encrypts them and uploads only ciphertext. Sealed's servers never receive Google credentials or file contents.

# 5. Security properties

| Property | How Sealed provides it |
|---|---|
| Confidentiality from the relay | Content encrypted on the sender's device; keys wrapped only to recipient hardware keys |
| Recipient authenticity | Check code derived from a secret the relay never sees; sender approval with biometric |
| Resistance to screen photography | One-time claim secrets; approval required; stream content is ciphertext in Air-gap |
| Device theft resistance | Non-exportable hardware keys; biometric required to unwrap each transfer; remote revocation |
| Integrity | Per-segment authentication; signed manifests where a sender identity exists |
| Forward secrecy for stored deliveries | One-time prekeys deleted after use |
| Authenticity of open broadcasts | Publisher signatures verified against pinned or fetched identity chains |
| Abuse resistance | No public download links; sender accounts; size, time and rate limits; recipient reporting |

## 5.1 What Sealed does not protect against

- **A compromised device.** Malware with control of the sender's or receiver's operating system can see plaintext. No end-to-end system can prevent that.
- **A recipient's later choices.** Once a file is decrypted on a recipient's device, the recipient can copy it. Revocation in Room mode stops future access only.
- **Users who skip the check code.** The check code is the defence against key substitution. Sealed makes it prominent, but cannot force attention.
- **Open broadcasts.** Broadcast mode is readable by anyone in view by design.
- **Metadata entirely.** The relay sees that a transfer occurred, its approximate size and time, and the accounts or device keys involved. Sealed minimizes, buckets and expires this data, but does not eliminate it.
- **Future quantum computers.** P-256 key wraps on stored ciphertext could in principle be broken by a large quantum computer. Short retention limits exposure, and the format carries algorithm identifiers so a hybrid post-quantum scheme can be added without a format change.

## 5.2 Abuse

End-to-end encrypted file hosting can be abused; Mozilla shut down Firefox Send in 2020 after it was used to distribute malware. Sealed cannot scan content it cannot read and will not add a mechanism to do so. Instead, it removes the features that make anonymous mass distribution easy: there are no public download links, every transfer requires a scan and approval or an in-person pairing, senders hold verified accounts with conservative limits for new accounts, and recipients can report a transfer and voluntarily share its contents.

# 6. Comparison with existing approaches

| Approach | Works across iOS, Android, web | No identifiers exchanged | Provider cannot read | Works offline | Recipient bound to device |
|---|---|---|---|---|---|
| Email attachment | Yes | No | Usually no | No | No |
| Cloud link (Drive, Dropbox, WeTransfer) | Yes | Partly | No | No | No |
| AirDrop | Apple only | Yes (Everyone mode) | Yes | Local radio | No |
| Quick Share with AirDrop interop | Supported Android and Apple | Yes (Everyone mode) | Yes | Local radio | No |
| Encrypted messengers | Yes | No (phone number or username) | Yes | No | Partly |
| LocalSend and similar LAN tools | Yes | Yes | Yes | Same LAN required | No |
| Enterprise managed file transfer | Partly | No | Varies | No | No |
| Data diodes and cross-domain hardware | Fixed installations | n/a | n/a | Yes | n/a |
| Animated QR tools | Yes | Yes | n/a | Yes | Usually no encryption |
| **Sealed** | **Yes** | **Yes** | **Yes** | **Yes (optical)** | **Yes** |

# 7. Applications

**Everyday exchanges.** A buyer and seller swap a signed agreement at a meeting. A photographer hands a client full-resolution images. A parent sends a teacher a form. No one exchanges phone numbers.

**Professional relationships.** A lawyer and client pair once at intake, then exchange documents for months without email. An accountant collects tax documents from clients with confirmation on each phone.

**Teaching, events and sales.** A lecturer distributes slides to a hall of students. A conference speaker shares materials without collecting emails. A sales team leaves an encrypted, revocable leave-behind with each attendee.

**Field and emergency work.** A response team broadcasts maps, contact lists and forms from a laptop screen when cellular networks are overloaded. A rural clinic moves records between an offline machine and a phone.

**Secure and regulated environments.** An analyst moves an approved file to a device that must never touch a network. A crypto custodian moves signing data between online and offline machines with far higher throughput than animated QR codes provide.

# 8. Limitations and engineering risks

- **Optical throughput varies with hardware.** Older phones, low frame-rate cameras and small or dim screens fall to lower tiers. Sealed gates the Air-gap release on measured performance across a broad capture corpus.
- **Web receivers are weaker.** Browsers do not offer hardware-backed, biometric-gated keys equivalent to native apps, and iOS browsers expose limited camera controls. Sealed labels browser keys clearly and lets organizations require native apps.
- **Large cloud selections cost sender bandwidth,** because files must pass through the sender's device to be encrypted there.
- **Flashing content.** Optical streams can be uncomfortable to watch; Facet limits large luminance changes and respects reduced-motion settings.
- **Accreditation takes time.** Use of an optical channel inside classified or regulated environments depends on local policy and accreditation, which Sealed will pursue with partners rather than assume.

# 9. Roadmap

1. **Foundations and codec gate:** cryptographic core, Envelope format and Facet prototype validated against real captures.
2. **Direct and Paired** on iOS, Android and web, with an external cryptographic design review.
3. **Public launch** with Room mode, Google Drive sources, a public bug bounty and a completed penetration test.
4. **Teams** (administration, policies, single sign-on) and **Air-gap and Broadcast** beta.
5. **Government readiness:** self-hosted relay, FIPS-validated cryptographic module build, and pilots with regulated users.
6. **Post-quantum hybrid key encapsulation** and group sharing built on Messaging Layer Security (RFC 9420).

# 10. Conclusion

The people who most need to share a file are often standing next to each other, and the tools they reach for were built for distance. Sealed treats the screen between them as the trust anchor: a code that grants only the right to ask, a check code that exposes any substitution, a key that never leaves the recipient's hardware, and a relay that cannot read what it carries. When there is no network, the same screen becomes the channel. The result is file sharing that is fast when it can be, works when nothing else does, and in every case reveals the contents only to the device the sender approved.

# References

1. Barnes, R., Bhargavan, K., Lipp, B., Wood, C. *Hybrid Public Key Encryption.* RFC 9180, 2022. [rfc-editor.org/rfc/rfc9180](https://www.rfc-editor.org/rfc/rfc9180)
2. Luby, M. et al. *RaptorQ Forward Error Correction Scheme for Object Delivery.* RFC 6330, 2011. [rfc-editor.org/rfc/rfc6330](https://www.rfc-editor.org/rfc/rfc6330)
3. Barnes, R. et al. *The Messaging Layer Security (MLS) Protocol.* RFC 9420, 2023. [rfc-editor.org/rfc/rfc9420](https://www.rfc-editor.org/rfc/rfc9420)
4. Krawczyk, H., Eronen, P. *HMAC-based Extract-and-Expand Key Derivation Function.* RFC 5869, 2010.
5. Hoang, V. T., Reyhanitabar, R., Rogaway, P., Vizár, D. *Online Authenticated-Encryption and its Nonce-Reuse Misuse-Resistance.* CRYPTO 2015.
6. sz3. *libcimbar: color icon matrix barcodes* (performance and design notes). [github.com/sz3/libcimbar](https://github.com/sz3/libcimbar)
7. Divan, I. *TXQR: animated QR data transfer with fountain codes.* [divan.dev/posts/fountaincodes](https://divan.dev/posts/fountaincodes/)
8. Blockchain Commons. *Uniform Resources (UR) and airgapped PSBTs.* [blockchaincommons.com](https://www.blockchaincommons.com/specifications/Blockchain-Commons-URs-Support-Airgapped-PSBTs/)
9. Hao, T., Zhou, R., Xing, G. *COBRA: Color Barcode Streaming for Smartphone Systems.* MobiSys 2012.
10. Hu, W. et al. *LightSync: Unsynchronized Visual Communication over Screen-Camera Links.* MobiCom 2013.
11. Signal. *Safety number updates.* 2016. [signal.org/blog/safety-number-updates](https://signal.org/blog/safety-number-updates/)
12. Apple. *About iMessage Contact Key Verification.* [support.apple.com/118246](https://support.apple.com/en-tj/118246)
13. Verizon. *2025 Data Breach Investigations Report.* [verizon.com](https://verizon.com/about/news/2025-data-breach-investigations-report)
14. IBM. *Cost of a Data Breach Report 2025* (summary via CyberScoop). [cyberscoop.com](https://cyberscoop.com/ibm-cost-data-breach-2025/)
15. Emsisoft. *Unpacking the MOVEit breach: statistics and analysis.* [emsisoft.com](https://emsisoft.com/en/blog/44123/unpacking-the-moveit-breach-statistics-and-analysis/)
16. AppleInsider. *iOS 16.2 implements 10-minute AirDrop time limit globally.* 2022. [appleinsider.com](https://appleinsider.com/articles/22/12/07/ios-162-implements-10-minute-airdrop-time-limit-globally)
17. Android Authority. *Quick Share works with AirDrop.* 2025. [androidauthority.com](https://www.androidauthority.com/quick-share-works-with-airdrop-3618023)
18. MediaNama. *WeTransfer terms of service backlash.* 2025. [medianama.com](https://www.medianama.com/2025/07/223-wetransfer-terms-of-service-backlash-ai-training/)
19. TechRadar. *Mozilla scraps encrypted Firefox file sharing tool after crooks use it to send malware.* 2020. [techradar.com](https://www.techradar.com/news/mozilla-scraps-encrypted-firefox-file-sharing-tool-after-crooks-use-it-to-send-malware)
20. Defense One. *DOD locks down removable media to fight virus attack.* 2008. [defenseone.com](https://www.defenseone.com/defense-systems/2008/11/dod-locks-down-removable-media-to-fight-virus-attack/187590/)
21. FIDO Alliance. *Accelerating global passkey adoption, World Passkey Day 2026.* [fidoalliance.org](https://fidoalliance.org/fido-alliance-reports-accelerating-global-passkey-adoption-on-world-passkey-day-2026/)
