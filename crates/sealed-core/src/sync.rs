//! Encrypted contacts sync blob (spec §6.3.4, §12). Ciphertext is opaque to the relay.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::crypto::primitives::{aes_gcm_open, aes_gcm_seal, hkdf_sha256, random_bytes, CryptoError};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContactRecord {
    pub fingerprint: String,
    pub display_name: String,
    pub paired_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncBlob {
    pub version: u32,
    pub contacts: Vec<ContactRecord>,
    pub updated_at: u64,
}

#[derive(Debug, Error)]
pub enum SyncError {
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    #[error("cbor: {0}")]
    Cbor(String),
}

/// Derive a sync key from the identity seed (32 bytes).
pub fn derive_sync_key(identity_seed: &[u8; 32]) -> Result<[u8; 32], SyncError> {
    let okm = hkdf_sha256(identity_seed, b"sealed", b"sealed/v1/sync-key", 32)?;
    let mut key = [0u8; 32];
    key.copy_from_slice(&okm);
    Ok(key)
}

/// Seal a sync blob: nonce (12) || ciphertext.
pub fn seal_sync_blob(key: &[u8; 32], blob: &SyncBlob) -> Result<Vec<u8>, SyncError> {
    let mut plain = Vec::new();
    ciborium::into_writer(blob, &mut plain).map_err(|e| SyncError::Cbor(e.to_string()))?;
    let nonce_bytes = random_bytes(12);
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&nonce_bytes);
    let ct = aes_gcm_seal(key, &nonce, &plain, b"sealed/v1/sync")?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn open_sync_blob(key: &[u8; 32], sealed: &[u8]) -> Result<SyncBlob, SyncError> {
    if sealed.len() < 12 + 16 {
        return Err(SyncError::Cbor("truncated".into()));
    }
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&sealed[..12]);
    let plain = aes_gcm_open(key, &nonce, &sealed[12..], b"sealed/v1/sync")?;
    ciborium::from_reader(plain.as_slice()).map_err(|e| SyncError::Cbor(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_blob_roundtrip() {
        let seed = [7u8; 32];
        let key = derive_sync_key(&seed).unwrap();
        let blob = SyncBlob {
            version: 1,
            contacts: vec![ContactRecord {
                fingerprint: "abc".into(),
                display_name: "Ada".into(),
                paired_at: 1,
            }],
            updated_at: 2,
        };
        let sealed = seal_sync_blob(&key, &blob).unwrap();
        let opened = open_sync_blob(&key, &sealed).unwrap();
        assert_eq!(opened, blob);
    }
}
