// Fit per-channel gain/offset from calibration swatches (ADR-0011).

struct CalibParams {
  swatch_count: u32,
  _pad: vec3<u32>,
}

struct Swatch {
  // expected RGB in linear 0..1, then sampled mean RGB
  expected: vec3<f32>,
  sampled: vec3<f32>,
}

@group(0) @binding(0) var<storage, read> swatches: array<Swatch>;
@group(0) @binding(1) var<storage, read_write> out_gain: array<f32>;
@group(0) @binding(2) var<storage, read_write> out_offset: array<f32>;
@group(0) @binding(3) var<uniform> params: CalibParams;

@compute @workgroup_size(1)
fn main() {
  // Least-squares gain/offset per channel: expected ≈ gain * sampled + offset
  // Simplified: gain = mean(expected)/mean(sampled), offset = 0 for bootstrap.
  var sum_e = vec3<f32>(0.0);
  var sum_s = vec3<f32>(0.0);
  let n = params.swatch_count;
  for (var i = 0u; i < n; i++) {
    sum_e += swatches[i].expected;
    sum_s += swatches[i].sampled;
  }
  let nf = f32(max(n, 1u));
  let mean_e = sum_e / nf;
  let mean_s = sum_s / nf;
  out_gain[0] = select(1.0, mean_e.r / mean_s.r, mean_s.r > 1e-4);
  out_gain[1] = select(1.0, mean_e.g / mean_s.g, mean_s.g > 1e-4);
  out_gain[2] = select(1.0, mean_e.b / mean_s.b, mean_s.b > 1e-4);
  out_offset[0] = 0.0;
  out_offset[1] = 0.0;
  out_offset[2] = 0.0;
}
