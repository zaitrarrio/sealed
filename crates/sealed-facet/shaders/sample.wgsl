// Sub-pixel cell grid sampling and nearest-centroid color classification (ADR-0011).

struct SampleParams {
  grid: u32,
  palette_size: u32,
  dst_size: vec2<u32>,
}

@group(0) @binding(0) var<storage, read> rectified: array<u32>;
@group(0) @binding(1) var<storage, read> centroids: array<vec3<f32>>;
@group(0) @binding(2) var<storage, read_write> symbols: array<u32>;
@group(0) @binding(3) var<uniform> params: SampleParams;

fn unpack_rgb(p: u32) -> vec3<f32> {
  let r = f32(p & 0xffu) / 255.0;
  let g = f32((p >> 8u) & 0xffu) / 255.0;
  let b = f32((p >> 16u) & 0xffu) / 255.0;
  return vec3<f32>(r, g, b);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.grid || gid.y >= params.grid) {
    return;
  }
  let cell_w = f32(params.dst_size.x) / f32(params.grid);
  let cell_h = f32(params.dst_size.y) / f32(params.grid);
  let cx = u32((f32(gid.x) + 0.5) * cell_w);
  let cy = u32((f32(gid.y) + 0.5) * cell_h);
  let idx = cy * params.dst_size.x + cx;
  let rgb = unpack_rgb(rectified[idx]);
  var best = 0u;
  var best_d = 1e9;
  for (var i = 0u; i < params.palette_size; i++) {
    let d = distance(rgb, centroids[i]);
    if (d < best_d) {
      best_d = d;
      best = i;
    }
  }
  symbols[gid.y * params.grid + gid.x] = best;
}
