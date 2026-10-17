//! C ABI over linear memory (ADR-0023): the contract shared by the WebAssembly build (driven by
//! `packages/core/src/facet/native.ts`) and the native libraries the phones link. Keep in step with that file.
//!
//! Handles are raw pointers to boxed decoders; the host owns every buffer it passes in and frees what it
//! allocated with `facet_alloc` via `facet_free`. Nothing here panics across the boundary: bad handles or sizes
//! return 0.
#![allow(unsafe_code)]
#![allow(clippy::missing_safety_doc)]

use crate::receiver::GridDecoder;
use crate::types::RgbaImage;

pub const ABI_VERSION: u32 = 1;

#[unsafe(no_mangle)]
pub extern "C" fn facet_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn facet_alloc(len: u32) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut v: Vec<u8> = Vec::with_capacity(len as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn facet_free(ptr: *mut u8, len: u32) {
    if ptr.is_null() || len == 0 {
        return;
    }
    // SAFETY: `ptr` came from `facet_alloc(len)` and has not been freed (the host's contract).
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len as usize)) };
}

#[unsafe(no_mangle)]
pub extern "C" fn facet_decoder_new(tiers_mask: u32) -> *mut GridDecoder {
    match GridDecoder::new(tiers_mask as u8) {
        Some(d) => Box::into_raw(Box::new(d)),
        None => std::ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn facet_decoder_free(dec: *mut GridDecoder) {
    if !dec.is_null() {
        // SAFETY: `dec` came from `facet_decoder_new` and is freed once (the host's contract).
        unsafe { drop(Box::from_raw(dec)) };
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn facet_decoder_push(dec: *mut GridDecoder, ptr: *const u8, width: u32, height: u32, stride: u32) -> u32 {
    if dec.is_null() || ptr.is_null() || width == 0 || height == 0 || stride < width * 4 {
        return 0;
    }
    let len = stride as usize * height as usize;
    // SAFETY: the host passes a buffer of at least stride × height bytes that outlives this call.
    let (dec, data) = unsafe { (&mut *dec, std::slice::from_raw_parts(ptr, len)) };
    let img = RgbaImage { width: width as usize, height: height as usize, stride: stride as usize, data };
    dec.push(&img).len() as u32
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn facet_decoder_frame_len(dec: *const GridDecoder, i: u32) -> u32 {
    if dec.is_null() {
        return 0;
    }
    // SAFETY: valid handle (the host's contract).
    let dec = unsafe { &*dec };
    dec.frames().get(i as usize).map_or(0, |f| f.len() as u32)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn facet_decoder_frame_copy(dec: *const GridDecoder, i: u32, out: *mut u8, cap: u32) -> u32 {
    if dec.is_null() || out.is_null() {
        return 0;
    }
    // SAFETY: valid handle; `out` has room for `cap` bytes (the host's contract).
    let dec = unsafe { &*dec };
    let Some(f) = dec.frames().get(i as usize) else { return 0 };
    let n = f.len().min(cap as usize);
    unsafe { std::ptr::copy_nonoverlapping(f.as_ptr(), out, n) };
    n as u32
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn facet_decoder_pixels_per_cell(dec: *const GridDecoder) -> f32 {
    if dec.is_null() {
        return 0.0;
    }
    // SAFETY: valid handle (the host's contract).
    unsafe { &*dec }.pixels_per_cell()
}
