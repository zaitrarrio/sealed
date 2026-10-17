//! Facet optical codec, native grid-frame decoder (ADR-0023).
//!
//! A port of the JavaScript decoder in `packages/core/src/facet` (the reference and test oracle), module for
//! module, so the two stay comparable: the fixtures under `fixtures/` (made by `pnpm fixtures:grid` in
//! `packages/core`) hold the JavaScript result of every stage for simulated captures.
//!
//! Pipeline per camera frame (`receiver::GridDecoder::push`):
//! luma → detect anchors → coarse homography → sub-cell refine → sample cells → colour-correct → decode header
//! strips (RS(20,12)) → joint colour/shape ML data detection with interference cancellation → RS(255,207) per
//! codeword → payload whose header CRC matches. Output is header ∥ payload bytes, which `FacetReceiver` on the
//! JavaScript side consumes like a QR frame (`pushFrameBytes`).

#![deny(unsafe_code)]
#![allow(clippy::too_many_arguments)]

pub mod calibrate;
pub mod decode;
pub mod detect;
pub mod equalize;
pub mod gf256;
pub mod glyphs;
pub mod grid;
pub mod header;
pub mod homography;
pub mod layout;
pub mod model;
pub mod palette;
pub mod random;
pub mod refine;
pub mod rs;
pub mod sample;
pub mod types;
pub mod vamp;
