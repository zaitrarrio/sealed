//! CEK wraps (spec §5.4): HPKE encapsulation of the content encryption key.

use thiserror::Error;

use crate::bytes::concat;
use crate::crypto::hpke::{open_base, seal_base, HpkeError};
use crate::crypto::keys::AgreementKey;

#[derive(Debug, Clone)]
pub enum WrapContext {
    Direct { transfer_id: [u8; 16] },
    Paired { transfer_id: [u8; 16], prekey_id: [u8; 8] },
    Airgap { stream_id: [u8; 4] },
    Local { file_id: Vec<u8> },
}

impl WrapContext {
    pub fn info(&self) -> Vec<u8> {
        match self {
            Self::Direct { transfer_id } => concat(&[b"sealed/v1/wrap/direct", transfer_id]),
            Self::Paired { transfer_id, prekey_id } => {
                concat(&[b"sealed/v1/wrap/paired", transfer_id, prekey_id])
            }
            Self::Airgap { stream_id } => concat(&[b"sealed/v1/wrap/airgap", stream_id]),
            Self::Local { file_id } => concat(&[b"sealed/v1/wrap/local", file_id]),
        }
    }
}

#[derive(Debug, Error)]
pub enum WrapError {
    #[error(transparent)]
    Hpke(#[from] HpkeError),
    #[error("malformed wrap")]
    Malformed,
}

/// Wraps a 32-byte CEK to `recipient_pub` (uncompressed P-256). Returns enc || ciphertext.
pub fn wrap_key(cek: &[u8; 32], recipient_pub: &[u8], ctx: &WrapContext) -> Result<Vec<u8>, WrapError> {
    let info = ctx.info();
    let (enc, ct) = seal_base(recipient_pub, &info, b"", cek)?;
    Ok(concat(&[&enc, &ct]))
}

/// Unwraps with the recipient agreement key.
pub fn unwrap_key(wrap: &[u8], recipient: &AgreementKey, ctx: &WrapContext) -> Result<[u8; 32], WrapError> {
    if wrap.len() < 65 + 16 {
        return Err(WrapError::Malformed);
    }
    let enc = &wrap[..65];
    let ct = &wrap[65..];
    let info = ctx.info();
    let pt = open_base(&recipient.secret, enc, &info, b"", ct)?;
    if pt.len() != 32 {
        return Err(WrapError::Malformed);
    }
    let mut cek = [0u8; 32];
    cek.copy_from_slice(&pt);
    Ok(cek)
}
