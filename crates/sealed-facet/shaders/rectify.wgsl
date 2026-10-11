// Perspective inverse homography warp from corner anchors into normalized grid space (ADR-0011).

struct RectifyParams {
  // row-major 3x3 homography mapping output (u,v) -> source (x,y)
  h0: vec3<f32>,
  h1: vec3<f32>,
  h2: vec3<f32>,
  src_size: vec2<f32>,
  dst_size: vec2<u32>,
  _pad: vec2<u32>,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<uniform> params: RectifyParams;

fn pack_rgba8(c: vec4<f32>) -> u32 {
  let r = u32(clamp(c.r, 0.0, 1.0) * 255.0);
  let g = u32(clamp(c.g, 0.0, 1.0) * 255.0);
  let b = u32(clamp(c.b, 0.0, 1.0) * 255.0);
  let a = u32(clamp(c.a, 0.0, 1.0) * 255.0);
  return r | (g << 8u) | (b << 16u) | (a << 24u);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.dst_size.x || gid.y >= params.dst_size.y) {
    return;
  }
  let u = (f32(gid.x) + 0.5) / f32(params.dst_size.x);
  let v = (f32(gid.y) + 0.5) / f32(params.dst_size.y);
  let p = vec3<f32>(u, v, 1.0);
  let x = dot(params.h0, p);
  let y = dot(params.h1, p);
  let w = dot(params.h2, p);
  let src_uv = vec2<f32>(x / w, y / w) / params.src_size;
  let color = textureSampleLevel(src, src_sampler, src_uv, 0.0);
  let idx = gid.y * params.dst_size.x + gid.x;
  dst[idx] = pack_rgba8(color);
}
