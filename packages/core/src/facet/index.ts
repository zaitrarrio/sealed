/**
 * Facet optical codec (spec §7) and the optical transfer flows (spec §6.5–6.6).
 */
export * from "./types";
export { DEFAULT_QR_STREAM, QR_HOLDS, QR_PROFILES, T0_MAX_SYMBOL, describeQrStream, isDefaultQrStream, qrStreamSetting, type QrStreamSetting, TIERS, TIER_REQUIREMENTS, chooseTier, isT0SymbolSize, planStreamOti, type TierSpec, type TierRequirement } from "./tiers";
export { FacetSender, type FacetSenderOptions } from "./sender";
export { FacetReceiver, type FacetReceiverOptions } from "./receiver";
export {
  createReverseKeyOffer,
  prepareAirgapStream,
  prepareBroadcastStream,
  airgapReceiverSas,
  openOpticalEnvelope,
  OpticalError,
  type BroadcastPublisher,
  type QrStreamOptions,
  type OpenedOptical,
} from "./optical";
export { qrFrameBytes, qrFrameText, QR_FRAME_BYTES, QR_VERSION } from "./qr";
export { base45Decode, base45Encode } from "./base45";
export {
  BENCHMARK_SIZES,
  BenchmarkMeter,
  benchmarkFileName,
  benchmarkPayload,
  formatBenchmarkReport,
  parseBenchmarkFileName,
  prepareBenchmarkStream,
  type BenchmarkReport,
  type BenchmarkStage,
  type BenchmarkStream,
} from "./bench";
export { BrightnessGate, LossEstimator, RATE_LADDER, ReceiverRateController, TORCH_DONE_MS, TORCH_GAP_MS, TORCH_PULSE_MS, TorchDecoder, TorchPlayer, adaptQrRate, rateIndex, torchSchedule, type QrRate, type TorchMessage, type TorchStep } from "./backchannel";
export { BACKGROUND as FACET_BACKGROUND, PALETTE_8 as FACET_PALETTE } from "./palette";
