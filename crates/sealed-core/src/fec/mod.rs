//! Forward error correction: RaptorQ (RFC 6330) via the reference crate.

use raptorq::{Encoder, ObjectTransmissionInformation};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FecError {
    #[error("encode failed")]
    Encode,
    #[error("decode incomplete")]
    Incomplete,
}

/// Encode `data` with RaptorQ; returns OTI bytes and serialized encoding packets (all source blocks).
pub fn encode(data: &[u8], symbol_size: u16) -> Result<(Vec<u8>, Vec<Vec<u8>>), FecError> {
    let config = ObjectTransmissionInformation::with_defaults(data.len() as u64, symbol_size);
    let encoder = Encoder::new(data, config);
    let mut packets = Vec::new();
    for block in encoder.get_block_encoders() {
        for p in block.source_packets() {
            packets.push(p.serialize());
        }
    }
    Ok((config.serialize().to_vec(), packets))
}

/// Decode using OTI + packets. Returns the reconstructed object (padded to symbol alignment).
pub fn decode(oti_bytes: &[u8], packets: &[Vec<u8>]) -> Result<Vec<u8>, FecError> {
    if oti_bytes.len() != 12 {
        return Err(FecError::Encode);
    }
    let mut oti_arr = [0u8; 12];
    oti_arr.copy_from_slice(oti_bytes);
    let oti = ObjectTransmissionInformation::deserialize(&oti_arr);
    let mut decoder = raptorq::Decoder::new(oti);
    for p in packets {
        let pkt = raptorq::EncodingPacket::deserialize(p);
        if let Some(data) = decoder.decode(pkt) {
            return Ok(data);
        }
    }
    Err(FecError::Incomplete)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raptorq_roundtrip() {
        let data = b"facet optical payload for sealed";
        let (oti, pkts) = encode(data, 64).unwrap();
        let out = decode(&oti, &pkts).unwrap();
        assert_eq!(&out[..data.len()], data.as_slice());
    }
}
