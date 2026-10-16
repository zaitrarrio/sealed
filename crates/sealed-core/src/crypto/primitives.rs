//! SHA-256, HKDF, AES-256-GCM, and CSPRNG (spec §5.1).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use rand_core::RngCore;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("aes-gcm authentication failed")]
    Authentication,
    #[error("hkdf expand failed")]
    Hkdf,
    #[error("invalid nonce length")]
    Nonce,
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut out = vec![0u8; n];
    rand_core::OsRng.fill_bytes(&mut out);
    out
}

pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], len: usize) -> Result<Vec<u8>, CryptoError> {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut okm = vec![0u8; len];
    hk.expand(info, &mut okm).map_err(|_| CryptoError::Hkdf)?;
    Ok(okm)
}

pub fn aes_gcm_seal(key: &[u8; 32], nonce: &[u8; 12], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::Authentication)?;
    cipher
        .encrypt(&Nonce::from(*nonce), Payload { msg: plaintext, aad })
        .map_err(|_| CryptoError::Authentication)
}

pub fn aes_gcm_open(key: &[u8; 32], nonce: &[u8; 12], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::Authentication)?;
    cipher
        .decrypt(&Nonce::from(*nonce), Payload { msg: ciphertext, aad })
        .map_err(|_| CryptoError::Authentication)
}

/// STREAM-style segment nonce: 11-byte big-endian counter || last flag (spec §8.1).
pub fn segment_nonce(index: u32, last: bool) -> [u8; 12] {
    let mut n = [0u8; 12];
    let mut v = index as u64;
    for i in (0..=10).rev() {
        n[i] = (v % 256) as u8;
        v /= 256;
    }
    n[11] = if last { 1 } else { 0 };
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aes_gcm_roundtrip() {
        let key: [u8; 32] = sha256(b"test-key");
        let nonce = [0u8; 12];
        let ct = aes_gcm_seal(&key, &nonce, b"hello", b"aad").unwrap();
        let pt = aes_gcm_open(&key, &nonce, &ct, b"aad").unwrap();
        assert_eq!(pt, b"hello");
    }

    #[test]
    fn segment_nonce_flags_last() {
        let a = segment_nonce(0, false);
        let b = segment_nonce(0, true);
        assert_eq!(a[11], 0);
        assert_eq!(b[11], 1);
        assert_eq!(&a[0..11], &b[0..11]);
    }
}
