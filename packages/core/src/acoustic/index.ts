/**
 * Acoustic transport (ADR-0024): speaker → microphone file transfer, plus paired call frame crypto.
 */
export {
  PROFILE_A0,
  PROFILE_A1,
  ACOUSTIC_PROFILES,
  acousticProfile,
  isAcousticProfileId,
  bitsPerSymbol,
  rawByteRate,
  type AcousticProfile,
  type AcousticProfileId,
} from "./profiles";
export { crc32 } from "./crc32";
export {
  ACOUSTIC_MAGIC,
  ACOUSTIC_VERSION,
  PACKET_HEADER_BYTES,
  encodePacket,
  decodePacket,
  fragmentPayload,
  defragmentPayload,
  type AcousticPacket,
  type AcousticPacketType,
} from "./packet";
export { modulatePacket, demodulateAt, demodulateStream, findPreamble, concatenatePcm } from "./modem";
export { applyAcousticChannel, type AcousticChannelOptions } from "./channel";
export {
  AcousticSender,
  AcousticReceiver,
  estimateAcousticSeconds,
  type AcousticSenderOptions,
  type AcousticProgress,
} from "./transfer";
export {
  AcousticError,
  ACOUSTIC_SIZE_WARN_BYTES,
  prepareAirgapAcousticStream,
  prepareBroadcastAcousticStream,
  airgapAcousticReceiverSas,
  openAcousticEnvelope,
  type OpenedAcoustic,
} from "./flows";
export {
  CALL_KEY_BYTES,
  CALL_NONCE_BYTES,
  createCallKeyMaterial,
  unwrapCallKey,
  callNonce,
  sealCallFrame,
  openCallFrame,
  encodeCallOffer,
  decodeCallOffer,
  callInfoBytes,
} from "./call";
