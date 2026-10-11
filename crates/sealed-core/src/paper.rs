//! BIP-39 recovery phrases (spec §6.3.5). Amends ADR-0016 §5 (base32 → BIP-39).

use bip39::{Language, Mnemonic};
use thiserror::Error;

use crate::crypto::primitives::sha256;

#[derive(Debug, Error)]
pub enum PaperError {
    #[error("invalid mnemonic")]
    Mnemonic,
    #[error("checksum mismatch")]
    Checksum,
    #[error("invalid secret length")]
    Length,
}

/// Encode `fingerprint (32) || secret (32)` as a 24-word BIP-39 mnemonic (256-bit entropy).
/// The identity fingerprint is verified on restore via a SHA-256 checksum stored alongside in the UI.
pub fn mnemonic_from_secret(secret: &[u8; 32]) -> Result<String, PaperError> {
    let mnemonic = Mnemonic::from_entropy(secret, Language::English).map_err(|_| PaperError::Mnemonic)?;
    Ok(mnemonic.phrase().to_string())
}

pub fn secret_from_mnemonic(phrase: &str) -> Result<[u8; 32], PaperError> {
    let mnemonic = Mnemonic::from_phrase(phrase, Language::English).map_err(|_| PaperError::Mnemonic)?;
    let ent = mnemonic.entropy();
    if ent.len() != 32 {
        return Err(PaperError::Length);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(ent);
    Ok(out)
}

/// Binding checksum: first 4 bytes of SHA-256(fingerprint || secret).
pub fn paper_checksum(fingerprint: &[u8; 32], secret: &[u8; 32]) -> [u8; 4] {
    let mut data = [0u8; 64];
    data[..32].copy_from_slice(fingerprint);
    data[32..].copy_from_slice(secret);
    let h = sha256(&data);
    [h[0], h[1], h[2], h[3]]
}

pub fn verify_paper_checksum(fingerprint: &[u8; 32], secret: &[u8; 32], checksum: &[u8; 4]) -> bool {
    paper_checksum(fingerprint, secret) == *checksum
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::primitives::random_bytes;

    #[test]
    fn bip39_roundtrip() {
        let secret: [u8; 32] = random_bytes(32).try_into().unwrap();
        let phrase = mnemonic_from_secret(&secret).unwrap();
        assert_eq!(phrase.split_whitespace().count(), 24);
        let back = secret_from_mnemonic(&phrase).unwrap();
        assert_eq!(back, secret);
    }
}
