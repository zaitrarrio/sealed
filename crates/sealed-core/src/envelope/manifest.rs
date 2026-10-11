//! Envelope manifest (spec §8.2). Compression value 1 = zstd (spec); 2 = DEFLATE kept for TS interop.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SEGMENT_SIZE: usize = 1024 * 1024;
pub const ENVELOPE_VERSION: u8 = 1;
pub const MAGIC: &[u8; 4] = b"SLD1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Compression {
    None = 0,
    Zstd = 1,
    Deflate = 2,
}

impl Compression {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::None),
            1 => Some(Self::Zstd),
            2 => Some(Self::Deflate),
            _ => None,
        }
    }

    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub media_type: String,
    pub sha256: [u8; 32],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u8,
    pub transfer_id: [u8; 16],
    pub created: u64,
    pub expires: u64,
    pub files: Vec<FileEntry>,
    pub compression: u8,
    pub segment_size: u32,
    pub segment_count: u32,
    pub payload_length: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("invalid path")]
    Path,
    #[error("empty envelope")]
    Empty,
    #[error("too many files")]
    TooMany,
    #[error("size mismatch")]
    Size,
    #[error("cbor: {0}")]
    Cbor(String),
}

pub fn validate_path(path: &str) -> Result<String, ManifestError> {
    let normalized = path.replace('\\', "/");
    let segs: Vec<&str> = normalized
        .split('/')
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .collect();
    if segs.is_empty() {
        return Err(ManifestError::Path);
    }
    Ok(segs.join("/"))
}

/// Size bucket: next power-of-two ceiling from 64 KiB (spec §8.3).
pub fn size_bucket(total: usize) -> usize {
    let mut b = 64 * 1024;
    while b < total {
        b = b.saturating_mul(2);
        if b == 0 {
            return usize::MAX;
        }
    }
    b
}
