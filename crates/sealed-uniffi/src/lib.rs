//! Native FFI surface for iOS / Android (ADR-0011).
//!
//! C-ABI API that UniFFI or cbindgen can wrap for Swift / Kotlin.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use sealed_core::paper::{mnemonic_from_secret, secret_from_mnemonic};
use sealed_core::sha256;
use sealed_facet::types::{Anchors, CapabilityTier, RgbaImage};
use sealed_facet::FacetDecoder;

/// SHA-256; writes 32 bytes into `out`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sealed_sha256(data: *const u8, len: usize, out: *mut u8) {
    unsafe {
        if data.is_null() || out.is_null() {
            return;
        }
        let slice = std::slice::from_raw_parts(data, len);
        let h = sha256(slice);
        std::ptr::copy_nonoverlapping(h.as_ptr(), out, 32);
    }
}

/// BIP-39 mnemonic from 32-byte secret. Caller frees with `sealed_string_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sealed_mnemonic_from_secret(secret: *const u8) -> *mut c_char {
    unsafe {
        if secret.is_null() {
            return std::ptr::null_mut();
        }
        let mut s = [0u8; 32];
        std::ptr::copy_nonoverlapping(secret, s.as_mut_ptr(), 32);
        match mnemonic_from_secret(&s) {
            Ok(phrase) => CString::new(phrase).map(|c| c.into_raw()).unwrap_or(std::ptr::null_mut()),
            Err(_) => std::ptr::null_mut(),
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sealed_string_free(s: *mut c_char) {
    unsafe {
        if !s.is_null() {
            drop(CString::from_raw(s));
        }
    }
}

/// Decode secret from mnemonic into 32-byte `out`. Returns 0 on success.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sealed_secret_from_mnemonic(phrase: *const c_char, out: *mut u8) -> i32 {
    unsafe {
        if phrase.is_null() || out.is_null() {
            return -1;
        }
        let Ok(text) = CStr::from_ptr(phrase).to_str() else {
            return -1;
        };
        match secret_from_mnemonic(text) {
            Ok(secret) => {
                std::ptr::copy_nonoverlapping(secret.as_ptr(), out, 32);
                0
            }
            Err(_) => -1,
        }
    }
}

pub struct NativeFacetDecoder {
    inner: FacetDecoder,
}

#[unsafe(no_mangle)]
pub extern "C" fn sealed_facet_decoder_new(tier: u8) -> *mut NativeFacetDecoder {
    let tier = match tier {
        0 => CapabilityTier::T0,
        2 => CapabilityTier::T2,
        3 => CapabilityTier::T3,
        _ => CapabilityTier::T1,
    };
    Box::into_raw(Box::new(NativeFacetDecoder {
        inner: FacetDecoder::new(tier),
    }))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sealed_facet_decoder_free(ptr: *mut NativeFacetDecoder) {
    unsafe {
        if !ptr.is_null() {
            drop(Box::from_raw(ptr));
        }
    }
}

/// Push a frame. Returns 1 when complete, 0 while in progress, -1 on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sealed_facet_push_frame(
    ptr: *mut NativeFacetDecoder,
    width: u32,
    height: u32,
    rgba: *const u8,
    rgba_len: usize,
    anchors8: *const f32,
) -> i32 {
    unsafe {
        if ptr.is_null() || rgba.is_null() || anchors8.is_null() {
            return -1;
        }
        let dec = &mut *ptr;
        let data = std::slice::from_raw_parts(rgba, rgba_len).to_vec();
        let a = std::slice::from_raw_parts(anchors8, 8);
        let image = RgbaImage { width, height, data };
        let anchors = Anchors {
            points: [[a[0], a[1]], [a[2], a[3]], [a[4], a[5]], [a[6], a[7]]],
        };
        match dec.inner.push_frame(&image, &anchors) {
            Ok(p) => i32::from(p.complete),
            Err(_) => -1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uniffi_sha256() {
        let input = b"hello sealed";
        let mut out = [0u8; 32];
        unsafe {
            sealed_sha256(input.as_ptr(), input.len(), out.as_mut_ptr());
        }
        let expected = sealed_core::sha256(input);
        assert_eq!(out, expected);
    }

    #[test]
    fn test_uniffi_mnemonic_roundtrip() {
        let secret = [42u8; 32];
        let ptr = unsafe { sealed_mnemonic_from_secret(secret.as_ptr()) };
        assert!(!ptr.is_null());

        let mut recovered = [0u8; 32];
        let res = unsafe { sealed_secret_from_mnemonic(ptr, recovered.as_mut_ptr()) };
        assert_eq!(res, 0);
        assert_eq!(recovered, secret);

        unsafe { sealed_string_free(ptr) };
    }

    #[test]
    fn test_uniffi_facet_lifecycle() {
        let dec = sealed_facet_decoder_new(1);
        assert!(!dec.is_null());

        let rgba = vec![128u8; 64 * 64 * 4];
        let anchors = [0.0f32, 0.0, 64.0, 0.0, 64.0, 64.0, 0.0, 64.0];
        let status = unsafe { sealed_facet_push_frame(dec, 64, 64, rgba.as_ptr(), rgba.len(), anchors.as_ptr()) };
        assert_eq!(status, 1);

        unsafe { sealed_facet_decoder_free(dec) };
    }
}
