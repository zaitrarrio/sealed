// Parallel Reed-Solomon syndrome computation over GF(256) (ADR-0011).

struct RsParams {
  n: u32,
  nroots: u32,
  _pad: vec2<u32>,
}

@group(0) @binding(0) var<storage, read> codeword: array<u32>;
@group(0) @binding(1) var<storage, read> gf_exp: array<u32>;
@group(0) @binding(2) var<storage, read> gf_log: array<u32>;
@group(0) @binding(3) var<storage, read_write> syndromes: array<u32>;
@group(0) @binding(4) var<uniform> params: RsParams;

fn gf_mul(a: u32, b: u32) -> u32 {
  if (a == 0u || b == 0u) {
    return 0u;
  }
  let la = gf_log[a];
  let lb = gf_log[b];
  return gf_exp[(la + lb) % 255u];
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s_i = gid.x;
  if (s_i >= params.nroots) {
    return;
  }
  // S_i = sum_j codeword[j] * alpha^{(i+1)*j}
  var acc = 0u;
  var alpha_pow = 1u; // alpha^0
  let root = gf_exp[s_i + 1u];
  for (var j = 0u; j < params.n; j++) {
    let c = codeword[j] & 0xffu;
    acc = acc ^ gf_mul(c, alpha_pow);
    alpha_pow = gf_mul(alpha_pow, root);
  }
  syndromes[s_i] = acc;
}
