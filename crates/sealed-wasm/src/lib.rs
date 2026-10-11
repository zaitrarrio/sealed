//! WebAssembly bindings for `@sealed/core` (ADR-0011). Runs in a Worker with zero-copy typed arrays.

use wasm_bindgen::prelude::*;

use sealed_core::envelope::manifest::Compression;
use sealed_core::envelope::seal::{open_envelope, seal_envelope, EnvelopeInput};
use sealed_core::paper::{mnemonic_from_secret, secret_from_mnemonic};
use sealed_core::{from_b64url, to_b64url};
use sealed_facet::types::{Anchors, CapabilityTier, RgbaImage};
use sealed_facet::FacetDecoder;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn sha256_hex(data: &[u8]) -> String {
    let h = sealed_core::sha256(data);
    hex::encode(h)
}

#[wasm_bindgen]
pub struct WasmFacetDecoder {
    inner: FacetDecoder,
}

#[wasm_bindgen]
impl WasmFacetDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new(tier: u8) -> WasmFacetDecoder {
        let tier = match tier {
            0 => CapabilityTier::T0,
            2 => CapabilityTier::T2,
            3 => CapabilityTier::T3,
            _ => CapabilityTier::T1,
        };
        Self {
            inner: FacetDecoder::new(tier),
        }
    }

    /// Push RGBA pixels (`width * height * 4`) plus four corner anchors as `[x0,y0, x1,y1, x2,y2, x3,y3]`.
    pub fn push_frame(&mut self, width: u32, height: u32, rgba: &[u8], anchors8: &[f32]) -> Result<js_sys::Object, JsValue> {
        if anchors8.len() < 8 {
            return Err(JsValue::from_str("anchors need 8 floats"));
        }
        let image = RgbaImage {
            width,
            height,
            data: rgba.to_vec(),
        };
        let anchors = Anchors {
            points: [
                [anchors8[0], anchors8[1]],
                [anchors8[2], anchors8[3]],
                [anchors8[4], anchors8[5]],
                [anchors8[6], anchors8[7]],
            ],
        };
        let p = self.inner.push_frame(&image, &anchors).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"framesSeen".into(), &JsValue::from(p.frames_seen))?;
        js_sys::Reflect::set(&obj, &"fraction".into(), &JsValue::from_f64(p.fraction as f64))?;
        js_sys::Reflect::set(&obj, &"complete".into(), &JsValue::from_bool(p.complete))?;
        Ok(obj)
    }
}

#[wasm_bindgen]
pub fn seal_files_zstd(paths: js_sys::Array, payloads: js_sys::Array, transfer_id_b64: &str, cek_b64: &str) -> Result<js_sys::Uint8Array, JsValue> {
    let transfer_id: [u8; 16] = from_b64url(transfer_id_b64)
        .map_err(|e| JsValue::from_str(&e.to_string()))?
        .try_into()
        .map_err(|_| JsValue::from_str("transfer_id"))?;
    let cek: [u8; 32] = from_b64url(cek_b64)
        .map_err(|e| JsValue::from_str(&e.to_string()))?
        .try_into()
        .map_err(|_| JsValue::from_str("cek"))?;
    let mut inputs = Vec::new();
    for i in 0..paths.length() {
        let path = paths.get(i).as_string().ok_or_else(|| JsValue::from_str("path"))?;
        let buf = js_sys::Uint8Array::new(&payloads.get(i));
        let mut data = vec![0u8; buf.length() as usize];
        buf.copy_to(&mut data);
        inputs.push(EnvelopeInput {
            path,
            media_type: "application/octet-stream".into(),
            data,
            mtime: None,
        });
    }
    let (bytes, _) = seal_envelope(&inputs, transfer_id, cek, 3600, Compression::Zstd).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(js_sys::Uint8Array::from(bytes.as_slice()))
}

#[wasm_bindgen]
pub fn open_files_zstd(envelope: &[u8], cek_b64: &str, transfer_id_b64: &str) -> Result<js_sys::Array, JsValue> {
    let cek: [u8; 32] = from_b64url(cek_b64)
        .map_err(|e| JsValue::from_str(&e.to_string()))?
        .try_into()
        .map_err(|_| JsValue::from_str("cek"))?;
    let transfer_id: [u8; 16] = from_b64url(transfer_id_b64)
        .map_err(|e| JsValue::from_str(&e.to_string()))?
        .try_into()
        .map_err(|_| JsValue::from_str("transfer_id"))?;
    let (_m, files) = open_envelope(envelope, &cek, Some(&transfer_id)).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let out = js_sys::Array::new();
    for f in files {
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"path".into(), &JsValue::from_str(&f.entry.path))?;
        js_sys::Reflect::set(&obj, &"data".into(), &js_sys::Uint8Array::from(f.data.as_slice()))?;
        out.push(&obj);
    }
    Ok(out)
}

#[wasm_bindgen]
pub fn bip39_from_secret(secret_b64: &str) -> Result<String, JsValue> {
    let secret: [u8; 32] = from_b64url(secret_b64)
        .map_err(|e| JsValue::from_str(&e.to_string()))?
        .try_into()
        .map_err(|_| JsValue::from_str("secret length"))?;
    mnemonic_from_secret(&secret).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn bip39_to_secret(phrase: &str) -> Result<String, JsValue> {
    let s = secret_from_mnemonic(phrase).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(to_b64url(&s))
}

use sealed_core::hex;
