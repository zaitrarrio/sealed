//! Sealed core: Envelope, cryptography, protocol state machines, and FEC.
//!
//! Platform IO (network, camera, keystore) stays outside this crate. State machines are sans-IO:
//! they consume events and emit commands (ADR-0011).

#![deny(unsafe_code)]

pub mod bytes;
pub mod crypto;
pub mod envelope;
pub mod fec;
pub mod paper;
pub mod protocol;
pub mod sync;

pub use bytes::{from_b64url, to_b64url};
pub use crypto::primitives::{random_bytes, sha256};
pub use envelope::manifest::{Compression, Manifest};
pub use paper::{mnemonic_from_secret, secret_from_mnemonic};

/// Hex encode (used by wasm bindings).
pub mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let bytes = bytes.as_ref();
        let mut s = String::with_capacity(bytes.len() * 2);
        for &b in bytes {
            s.push(HEX[(b >> 4) as usize] as char);
            s.push(HEX[(b & 0xf) as usize] as char);
        }
        s
    }
}
