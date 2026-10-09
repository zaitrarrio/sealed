/**
 * Facet optical codec (spec §7) and the optical transfer flows (spec §6.5–6.6).
 */
export * from "./types";
export { TIERS, TIER_REQUIREMENTS, chooseTier, planStreamOti, type TierSpec, type TierRequirement } from "./tiers";
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
  type OpenedOptical,
} from "./optical";
export { BACKGROUND as FACET_BACKGROUND, PALETTE_8 as FACET_PALETTE } from "./palette";
