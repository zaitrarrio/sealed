//! Short authentication strings (spec §5.6) — six decimal digits shown as a "safety code" in the UI.

use crate::crypto::primitives::hkdf_sha256;

fn digits6(bytes: &[u8]) -> String {
    let mut n = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 1_000_000;
    let mut out = String::with_capacity(6);
    for _ in 0..6 {
        out.insert(0, char::from(b'0' + (n % 10) as u8));
        n /= 10;
    }
    out
}

/// Claim SAS: HKDF(cs, transfer_id ∥ receiver_pub, "sealed/v1/claim-sas", 4) → 6 digits.
pub fn claim_sas(claim_secret: &[u8; 16], transfer_id: &[u8; 16], receiver_pub: &[u8]) -> String {
    let mut salt = transfer_id.to_vec();
    salt.extend_from_slice(receiver_pub);
    let okm = hkdf_sha256(claim_secret, &salt, b"sealed/v1/claim-sas", 4).expect("hkdf");
    digits6(&okm)
}

/// Air-gap SAS.
pub fn airgap_sas(nonce: &[u8; 16], stream_id: &[u8; 4], receiver_pub: &[u8], sender_pub: &[u8]) -> String {
    let mut info = b"sealed/v1/airgap".to_vec();
    info.extend_from_slice(receiver_pub);
    info.extend_from_slice(sender_pub);
    let okm = hkdf_sha256(nonce, stream_id, &info, 4).expect("hkdf");
    digits6(&okm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_sas_is_six_digits() {
        let s = claim_sas(&[1u8; 16], &[2u8; 16], &[4u8; 65]);
        assert_eq!(s.len(), 6);
        assert!(s.chars().all(|c| c.is_ascii_digit()));
    }
}
