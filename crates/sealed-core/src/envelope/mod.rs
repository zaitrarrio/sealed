//! Envelope format (spec §8).

pub mod manifest;
pub mod seal;

pub use manifest::{Compression, FileEntry, Manifest};
pub use seal::{open_envelope, seal_envelope, OpenedFile};
