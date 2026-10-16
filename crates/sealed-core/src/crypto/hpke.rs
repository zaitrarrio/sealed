//! HPKE Base/Auth with DHKEM(P-256), HKDF-SHA256, AES-256-GCM (RFC 9180 suite 0x0010/0x0001/0x0002).

use hkdf::Hkdf;
use p256::ecdh::EphemeralSecret;
use p256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use p256::{EncodedPoint, PublicKey, SecretKey};
use rand_core::OsRng;
use sha2::Sha256;
use thiserror::Error;

use crate::crypto::primitives::{aes_gcm_open, aes_gcm_seal, sha256};

#[derive(Debug, Error)]
pub enum HpkeError {
    #[error("invalid public key")]
    PublicKey,
    #[error("decapsulation failed")]
    Decap,
    #[error("aead failed")]
    Aead,
}

const KEM_ID: u16 = 0x0010;
const KDF_ID: u16 = 0x0001;
const AEAD_ID: u16 = 0x0002;

fn suite_id() -> Vec<u8> {
    let mut s = b"HPKE".to_vec();
    s.extend_from_slice(&KEM_ID.to_be_bytes());
    s.extend_from_slice(&KDF_ID.to_be_bytes());
    s.extend_from_slice(&AEAD_ID.to_be_bytes());
    s
}

fn labeled_extract(salt: &[u8], label: &[u8], ikm: &[u8]) -> [u8; 32] {
    let mut labeled = b"HPKE-v1".to_vec();
    labeled.extend_from_slice(&suite_id());
    labeled.extend_from_slice(label);
    labeled.extend_from_slice(ikm);
    let hk = Hkdf::<Sha256>::new(Some(salt), &labeled);
    let mut okm = [0u8; 32];
    hk.expand(&[], &mut okm).expect("hkdf");
    okm
}

fn labeled_expand(prk: &[u8], label: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let mut labeled = Vec::new();
    labeled.extend_from_slice(&(len as u16).to_be_bytes());
    labeled.extend_from_slice(b"HPKE-v1");
    labeled.extend_from_slice(&suite_id());
    labeled.extend_from_slice(label);
    labeled.extend_from_slice(info);
    let hk = Hkdf::<Sha256>::from_prk(prk).expect("prk");
    let mut okm = vec![0u8; len];
    hk.expand(&labeled, &mut okm).expect("expand");
    okm
}

fn parse_public(bytes: &[u8]) -> Result<PublicKey, HpkeError> {
    let ep = EncodedPoint::from_bytes(bytes).map_err(|_| HpkeError::PublicKey)?;
    PublicKey::from_encoded_point(&ep)
        .into_option()
        .ok_or(HpkeError::PublicKey)
}

/// HPKE Base mode seal: returns (enc, ciphertext).
pub fn seal_base(recipient_pub: &[u8], info: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), HpkeError> {
    let pk_r = parse_public(recipient_pub)?;
    let sk_e = EphemeralSecret::random(&mut OsRng);
    let enc_point = sk_e.public_key().to_encoded_point(false);
    let enc = enc_point.as_bytes().to_vec();
    let shared = sk_e.diffie_hellman(&pk_r);
    let dh = shared.raw_secret_bytes();

    let kem_context = {
        let mut c = enc.clone();
        c.extend_from_slice(recipient_pub);
        c
    };
    let eae_prk = labeled_extract(b"", b"eae_prk", &dh[..]);
    let shared_secret = labeled_expand(&eae_prk, b"shared_secret", &kem_context, 32);

    let key_schedule_context = {
        let psk_id_hash = labeled_extract(b"", b"psk_id_hash", b"");
        let info_hash = labeled_extract(b"", b"info_hash", info);
        let mut ctx = vec![0u8]; // mode Base = 0
        ctx.extend_from_slice(&psk_id_hash);
        ctx.extend_from_slice(&info_hash);
        ctx
    };
    let secret = labeled_extract(&shared_secret, b"secret", b"");
    let key_bytes = labeled_expand(&secret, b"key", &key_schedule_context, 32);
    let base_nonce = labeled_expand(&secret, b"base_nonce", &key_schedule_context, 12);

    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&base_nonce);
    let ct = aes_gcm_seal(&key, &nonce, plaintext, aad).map_err(|_| HpkeError::Aead)?;
    let _ = sha256; // keep import used for future Auth mode
    Ok((enc, ct))
}

/// HPKE Base mode open.
pub fn open_base(recipient_secret: &SecretKey, enc: &[u8], info: &[u8], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, HpkeError> {
    let pk_e = parse_public(enc)?;
    let pk_r = recipient_secret.public_key();
    let pk_r_bytes = pk_r.to_encoded_point(false).as_bytes().to_vec();

    // Reconstruct DH with static secret × ephemeral public.
    let sk = p256::ecdh::diffie_hellman(recipient_secret.to_nonzero_scalar(), pk_e.as_affine());
    let dh = sk.raw_secret_bytes();

    let kem_context = {
        let mut c = enc.to_vec();
        c.extend_from_slice(&pk_r_bytes);
        c
    };
    let eae_prk = labeled_extract(b"", b"eae_prk", &dh[..]);
    let shared_secret = labeled_expand(&eae_prk, b"shared_secret", &kem_context, 32);

    let key_schedule_context = {
        let psk_id_hash = labeled_extract(b"", b"psk_id_hash", b"");
        let info_hash = labeled_extract(b"", b"info_hash", info);
        let mut ctx = vec![0u8];
        ctx.extend_from_slice(&psk_id_hash);
        ctx.extend_from_slice(&info_hash);
        ctx
    };
    let secret = labeled_extract(&shared_secret, b"secret", b"");
    let key_bytes = labeled_expand(&secret, b"key", &key_schedule_context, 32);
    let base_nonce = labeled_expand(&secret, b"base_nonce", &key_schedule_context, 12);
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&base_nonce);
    aes_gcm_open(&key, &nonce, ciphertext, aad).map_err(|_| HpkeError::Decap)
}
