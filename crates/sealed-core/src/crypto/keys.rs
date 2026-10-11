//! Device key types (spec §5.2). Hardware keys are supplied by the platform KeyStore trait.

use p256::ecdsa::{SigningKey, VerifyingKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::SecretKey;
use rand_core::OsRng;
use thiserror::Error;

use crate::crypto::primitives::sha256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyProtection {
    Software,
    Tee,
    Strongbox,
    SecureEnclave,
}

impl KeyProtection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Software => "software",
            Self::Tee => "tee",
            Self::Strongbox => "strongbox",
            Self::SecureEnclave => "secure_enclave",
        }
    }

    pub fn is_hardware(self) -> bool {
        !matches!(self, Self::Software)
    }
}

#[derive(Debug, Error)]
pub enum KeyError {
    #[error("invalid key encoding")]
    Encoding,
    #[error("signature verification failed")]
    Verify,
}

/// Software P-256 agreement key (ECDH).
pub struct AgreementKey {
    pub secret: SecretKey,
    pub public: Vec<u8>,
    pub protection: KeyProtection,
}

impl AgreementKey {
    pub fn generate() -> Self {
        let secret = SecretKey::random(&mut OsRng);
        let public = secret.public_key().to_encoded_point(false).as_bytes().to_vec();
        Self {
            secret,
            public,
            protection: KeyProtection::Software,
        }
    }

    pub fn public_key(&self) -> &[u8] {
        &self.public
    }
}

/// Software P-256 signing key (ECDSA).
pub struct DeviceSigningKey {
    pub signing: SigningKey,
    pub public: Vec<u8>,
    pub protection: KeyProtection,
}

impl DeviceSigningKey {
    pub fn generate() -> Self {
        let signing = SigningKey::random(&mut OsRng);
        let verifying = VerifyingKey::from(&signing);
        let public = verifying.to_encoded_point(false).as_bytes().to_vec();
        Self {
            signing,
            public,
            protection: KeyProtection::Software,
        }
    }

    pub fn public_key(&self) -> &[u8] {
        &self.public
    }
}

pub struct DeviceKeys {
    pub agreement: AgreementKey,
    pub signing: DeviceSigningKey,
}

impl DeviceKeys {
    pub fn generate() -> Self {
        Self {
            agreement: AgreementKey::generate(),
            signing: DeviceSigningKey::generate(),
        }
    }
}

/// Compress an uncompressed P-256 point to 33 bytes (spec keyid).
pub fn compress_public(uncompressed: &[u8]) -> Result<Vec<u8>, KeyError> {
    if uncompressed.len() != 65 || uncompressed[0] != 0x04 {
        return Err(KeyError::Encoding);
    }
    let mut out = vec![0u8; 33];
    out[0] = if uncompressed[64] & 1 == 1 { 0x03 } else { 0x02 };
    out[1..33].copy_from_slice(&uncompressed[1..33]);
    Ok(out)
}

pub fn identity_fingerprint(genesis_link: &[u8]) -> [u8; 32] {
    sha256(genesis_link)
}
