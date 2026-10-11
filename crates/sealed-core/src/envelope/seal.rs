//! Contiguous Envelope seal/open with zstd compression (spec §8).

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::bytes::concat;
use crate::crypto::primitives::{aes_gcm_open, aes_gcm_seal, hkdf_sha256, random_bytes, segment_nonce, CryptoError};
use crate::envelope::manifest::{
    size_bucket, validate_path, Compression, FileEntry, Manifest, ManifestError, ENVELOPE_VERSION, MAGIC, SEGMENT_SIZE,
};

#[derive(Debug, Error)]
pub enum EnvelopeError {
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    #[error("authentication failed")]
    Auth,
    #[error("truncated")]
    Truncated,
    #[error("zstd: {0}")]
    Zstd(String),
}

pub struct EnvelopeInput {
    pub path: String,
    pub media_type: String,
    pub data: Vec<u8>,
    pub mtime: Option<u64>,
}

pub struct OpenedFile {
    pub entry: FileEntry,
    pub data: Vec<u8>,
}

struct EnvelopeKeys {
    payload_key: [u8; 32],
    manifest_key: [u8; 32],
}

fn derive_keys(cek: &[u8; 32], transfer_id: &[u8; 16]) -> Result<EnvelopeKeys, CryptoError> {
    let pk = hkdf_sha256(cek, transfer_id, b"sealed/v1/payload", 32)?;
    let mk = hkdf_sha256(cek, transfer_id, b"sealed/v1/manifest", 32)?;
    let mut payload_key = [0u8; 32];
    let mut manifest_key = [0u8; 32];
    payload_key.copy_from_slice(&pk);
    manifest_key.copy_from_slice(&mk);
    Ok(EnvelopeKeys { payload_key, manifest_key })
}

fn encode_header(transfer_id: &[u8; 16], manifest_len: u32, signed: bool) -> Vec<u8> {
    let mut h = Vec::with_capacity(26);
    h.extend_from_slice(MAGIC);
    h.push(ENVELOPE_VERSION);
    h.push(if signed { 1 } else { 0 });
    h.extend_from_slice(transfer_id);
    h.extend_from_slice(&manifest_len.to_be_bytes());
    h
}

/// Seals files into a contiguous Envelope (zstd by default for compressible inputs).
pub fn seal_envelope(
    inputs: &[EnvelopeInput],
    transfer_id: [u8; 16],
    cek: [u8; 32],
    ttl_seconds: u64,
    compression: Compression,
) -> Result<(Vec<u8>, Manifest), EnvelopeError> {
    if inputs.is_empty() {
        return Err(ManifestError::Empty.into());
    }
    let keys = derive_keys(&cek, &transfer_id)?;
    let mut files = Vec::new();
    let mut payload = Vec::new();

    for input in inputs {
        let path = validate_path(&input.path)?;
        let mut hasher = Sha256::new();
        hasher.update(&input.data);
        let digest: [u8; 32] = hasher.finalize().into();
        files.push(FileEntry {
            path,
            size: input.data.len() as u64,
            media_type: if input.media_type.is_empty() {
                "application/octet-stream".into()
            } else {
                input.media_type.clone()
            },
            sha256: digest,
            mtime: input.mtime,
        });
        payload.extend_from_slice(&input.data);
    }

    let compressed = match compression {
        Compression::None => payload,
        Compression::Zstd => zstd::encode_all(payload.as_slice(), 3).map_err(|e| EnvelopeError::Zstd(e.to_string()))?,
        Compression::Deflate => {
            // Prefer zstd in the Rust core; Deflate reserved for TS interop readers.
            return Err(EnvelopeError::Zstd("deflate encoding is not produced by sealed-core; use zstd".into()));
        }
    };

    let mut segments = Vec::new();
    let mut index = 0u32;
    let mut offset = 0usize;
    while offset < compressed.len() || index == 0 {
        let end = (offset + SEGMENT_SIZE).min(compressed.len());
        let last = end >= compressed.len();
        let pt = if offset >= compressed.len() {
            Vec::new()
        } else {
            compressed[offset..end].to_vec()
        };
        let nonce = segment_nonce(index, last);
        let ct = aes_gcm_seal(&keys.payload_key, &nonce, &pt, MAGIC)?;
        segments.push(ct);
        index += 1;
        if last {
            break;
        }
        offset = end;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let manifest = Manifest {
        version: ENVELOPE_VERSION,
        transfer_id,
        created: now,
        expires: now + ttl_seconds,
        files,
        compression: compression.as_u8(),
        segment_size: SEGMENT_SIZE as u32,
        segment_count: index,
        payload_length: compressed.len() as u64,
        source: None,
    };

    let manifest_bytes = {
        let mut buf = Vec::new();
        ciborium::into_writer(&manifest, &mut buf).map_err(|e| ManifestError::Cbor(e.to_string()))?;
        buf
    };
    let header_aad = encode_header(&transfer_id, 0, false);
    let aad = &header_aad[..22.min(header_aad.len())];
    // AD is magic||version||flags||transfer_id (22 bytes) per ADR-0016 §4.
    let mut aad22 = [0u8; 22];
    aad22[0..4].copy_from_slice(MAGIC);
    aad22[4] = ENVELOPE_VERSION;
    aad22[5] = 0;
    aad22[6..22].copy_from_slice(&transfer_id);
    let _ = aad;
    let mct = aes_gcm_seal(&keys.manifest_key, &[0u8; 12], &manifest_bytes, &aad22)?;
    let header = encode_header(&transfer_id, mct.len() as u32, false);
    let mut body = concat(&[&header, &mct]);
    for s in &segments {
        body.extend_from_slice(s);
    }
    let pad_len = size_bucket(body.len()) - body.len();
    if pad_len > 0 {
        body.extend_from_slice(&random_bytes(pad_len));
    }
    Ok((body, manifest))
}

/// Opens a contiguous Envelope and verifies per-file hashes.
pub fn open_envelope(bytes: &[u8], cek: &[u8; 32], expected_transfer_id: Option<&[u8; 16]>) -> Result<(Manifest, Vec<OpenedFile>), EnvelopeError> {
    if bytes.len() < 26 + 16 {
        return Err(EnvelopeError::Truncated);
    }
    if &bytes[0..4] != MAGIC {
        return Err(EnvelopeError::Auth);
    }
    let mut transfer_id = [0u8; 16];
    transfer_id.copy_from_slice(&bytes[6..22]);
    if let Some(exp) = expected_transfer_id {
        if exp != &transfer_id {
            return Err(EnvelopeError::Auth);
        }
    }
    let manifest_len = u32::from_be_bytes(bytes[22..26].try_into().unwrap()) as usize;
    let end = 26 + manifest_len;
    if bytes.len() < end {
        return Err(EnvelopeError::Truncated);
    }
    let keys = derive_keys(cek, &transfer_id)?;
    let mut aad22 = [0u8; 22];
    aad22.copy_from_slice(&bytes[0..22]);
    let plain = aes_gcm_open(&keys.manifest_key, &[0u8; 12], &bytes[26..end], &aad22)?;
    let manifest: Manifest = ciborium::from_reader(plain.as_slice()).map_err(|e| ManifestError::Cbor(e.to_string()))?;

    let mut offset = end;
    let mut payload = Vec::new();
    for i in 0..manifest.segment_count {
        let last = i + 1 == manifest.segment_count;
        let remaining = manifest.payload_length as usize - payload.len();
        let plain_len = if last { remaining } else { SEGMENT_SIZE };
        let ct_len = plain_len + 16;
        if bytes.len() < offset + ct_len {
            return Err(EnvelopeError::Truncated);
        }
        let ct = &bytes[offset..offset + ct_len];
        let nonce = segment_nonce(i, last);
        let pt = aes_gcm_open(&keys.payload_key, &nonce, ct, MAGIC)?;
        payload.extend_from_slice(&pt);
        offset += ct_len;
    }

    let decompressed = match Compression::from_u8(manifest.compression) {
        Some(Compression::None) => payload,
        Some(Compression::Zstd) => zstd::decode_all(payload.as_slice()).map_err(|e| EnvelopeError::Zstd(e.to_string()))?,
        Some(Compression::Deflate) => {
            return Err(EnvelopeError::Zstd("deflate open not implemented in sealed-core yet".into()));
        }
        None => return Err(EnvelopeError::Auth),
    };

    let mut files = Vec::new();
    let mut off = 0usize;
    for entry in &manifest.files {
        let end = off + entry.size as usize;
        if decompressed.len() < end {
            return Err(EnvelopeError::Truncated);
        }
        let data = decompressed[off..end].to_vec();
        let mut hasher = Sha256::new();
        hasher.update(&data);
        let digest: [u8; 32] = hasher.finalize().into();
        if digest != entry.sha256 {
            return Err(EnvelopeError::Auth);
        }
        files.push(OpenedFile {
            entry: entry.clone(),
            data,
        });
        off = end;
    }
    Ok((manifest, files))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::primitives::random_bytes;

    #[test]
    fn zstd_roundtrip() {
        let transfer_id: [u8; 16] = random_bytes(16).try_into().unwrap();
        let cek: [u8; 32] = random_bytes(32).try_into().unwrap();
        let inputs = [EnvelopeInput {
            path: "hello.txt".into(),
            media_type: "text/plain".into(),
            data: b"hello sealed zstd".to_vec(),
            mtime: None,
        }];
        let (bytes, manifest) = seal_envelope(&inputs, transfer_id, cek, 3600, Compression::Zstd).unwrap();
        assert_eq!(manifest.compression, Compression::Zstd.as_u8());
        let (m, files) = open_envelope(&bytes, &cek, Some(&transfer_id)).unwrap();
        assert_eq!(m.files.len(), 1);
        assert_eq!(files[0].data, b"hello sealed zstd");
    }
}
