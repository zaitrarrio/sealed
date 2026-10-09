/**
 * Systematic Reed-Solomon code RS(n, k) over GF(256) (field polynomial 0x11D, alpha = 2).
 *
 * - Generator polynomial g(x) = prod_{i=0}^{n-k-1} (x - alpha^i), i.e. first consecutive root 0.
 * - Codeword layout: k data bytes followed by n-k parity bytes. Byte j of the codeword is the
 *   coefficient of x^(n-1-j), so position j has error locator X_j = alpha^(n-1-j).
 * - Decoding handles e errors and f erasures whenever 2e + f <= n - k, using Forney syndromes
 *   (erasure-modified syndromes) + Berlekamp-Massey, Chien search and the Forney algorithm.
 *   After correcting, syndromes are recomputed; if they are not all zero the word is reported as
 *   uncorrectable (null) instead of being mis-corrected.
 */
import { GF256_EXP, GF256_MUL, GF256_INV } from "./gf256";

function gmul(a: number, b: number): number {
  return GF256_MUL[(a << 8) | b] as number;
}

/** Evaluate polynomial p (ascending coefficients) at x. */
function evalAsc(p: Uint8Array, len: number, x: number): number {
  let acc = 0;
  for (let i = len - 1; i >= 0; i--) acc = gmul(acc, x) ^ (p[i] as number);
  return acc;
}

export class ReedSolomon {
  readonly n: number;
  readonly k: number;
  /** Number of parity symbols n - k. */
  readonly parity: number;
  /** Generator polynomial, descending coefficients, g[0] = 1, length parity + 1. */
  private readonly gen: Uint8Array;

  constructor(n: number, k: number) {
    if (!Number.isInteger(n) || !Number.isInteger(k)) throw new RangeError("n and k must be integers");
    if (n < 2 || n > 255) throw new RangeError(`n must be in 2..255, got ${n}`);
    if (k < 1 || k >= n) throw new RangeError(`k must be in 1..n-1, got k=${k} n=${n}`);
    this.n = n;
    this.k = k;
    this.parity = n - k;
    // g(x) = prod (x - alpha^i), built in descending-coefficient form.
    let g = new Uint8Array([1]);
    for (let i = 0; i < this.parity; i++) {
      const root = GF256_EXP[i] as number;
      const next = new Uint8Array(g.length + 1);
      for (let j = 0; j < g.length; j++) {
        const c = g[j] as number;
        next[j] = (next[j] as number) ^ c;
        next[j + 1] = (next[j + 1] as number) ^ gmul(c, root);
      }
      g = next;
    }
    this.gen = g;
  }

  /** Encode k data bytes into an n-byte systematic codeword (data then parity). */
  encode(data: Uint8Array): Uint8Array {
    if (data.length !== this.k) throw new RangeError(`expected ${this.k} data bytes, got ${data.length}`);
    const m = this.parity;
    const out = new Uint8Array(this.n);
    out.set(data, 0);
    const par = new Uint8Array(m);
    const g = this.gen;
    for (let i = 0; i < this.k; i++) {
      const fb = (data[i] as number) ^ (par[0] as number);
      par.copyWithin(0, 1);
      par[m - 1] = 0;
      if (fb !== 0) {
        const base = fb << 8;
        for (let j = 0; j < m; j++) par[j] = (par[j] as number) ^ (GF256_MUL[base | (g[j + 1] as number)] as number);
      }
    }
    out.set(par, this.k);
    return out;
  }

  /** Syndromes S_i = c(alpha^i), i = 0..parity-1. Returns true if all zero. */
  private syndromes(cw: Uint8Array, out: Uint8Array): boolean {
    let allZero = true;
    const n = this.n;
    for (let i = 0; i < this.parity; i++) {
      const x = GF256_EXP[i] as number;
      let acc = 0;
      if (i === 0) {
        for (let j = 0; j < n; j++) acc ^= cw[j] as number;
      } else {
        const base = x;
        for (let j = 0; j < n; j++) acc = (GF256_MUL[(acc << 8) | base] as number) ^ (cw[j] as number);
      }
      out[i] = acc;
      if (acc !== 0) allZero = false;
    }
    return allZero;
  }

  /**
   * Decode an n-byte (possibly corrupted) codeword. `erasures` lists codeword positions (0..n-1)
   * known to be unreliable. Returns the k corrected data bytes, or null if the word cannot be
   * corrected within the code's capability (2e + f <= n - k).
   */
  decode(codeword: Uint8Array, erasures: readonly number[] = []): Uint8Array | null {
    const n = this.n;
    const m = this.parity;
    if (codeword.length !== n) throw new RangeError(`expected ${n} codeword bytes, got ${codeword.length}`);
    const eraSet = new Set<number>();
    for (const e of erasures) {
      if (!Number.isInteger(e) || e < 0 || e >= n) throw new RangeError(`erasure position ${e} out of range 0..${n - 1}`);
      eraSet.add(e);
    }
    const f = eraSet.size;
    if (f > m) return null;

    const cw = Uint8Array.from(codeword);
    const S = new Uint8Array(m);
    if (this.syndromes(cw, S)) return cw.slice(0, this.k);

    // Erasure locator Gamma(x) = prod (1 - X_j x), ascending coefficients.
    const gamma = new Uint8Array(m + 1);
    gamma[0] = 1;
    let gammaDeg = 0;
    for (const pos of eraSet) {
      const X = GF256_EXP[n - 1 - pos] as number;
      for (let i = gammaDeg + 1; i >= 1; i--) gamma[i] = (gamma[i] as number) ^ gmul(gamma[i - 1] as number, X);
      gammaDeg++;
    }

    // Forney syndromes: T(x) = Gamma(x) S(x) mod x^m; T_f..T_{m-1} is an errors-only sequence.
    const T = new Uint8Array(m);
    for (let i = 0; i < m; i++) {
      let acc = 0;
      const lim = Math.min(i, gammaDeg);
      for (let j = 0; j <= lim; j++) acc ^= gmul(gamma[j] as number, S[i - j] as number);
      T[i] = acc;
    }

    // Berlekamp-Massey on s_r = T_{f + r}, r = 0..m-f-1.
    const N = m - f;
    const C = new Uint8Array(m + 1);
    const B = new Uint8Array(m + 1);
    const tmp = new Uint8Array(m + 1);
    C[0] = 1;
    B[0] = 1;
    let L = 0;
    let shift = 1;
    let b = 1;
    for (let r = 0; r < N; r++) {
      let d = T[f + r] as number;
      for (let i = 1; i <= L; i++) d ^= gmul(C[i] as number, T[f + r - i] as number);
      if (d === 0) {
        shift++;
        continue;
      }
      const coef = gmul(d, GF256_INV[b] as number);
      if (2 * L <= r) {
        tmp.set(C);
        for (let i = 0; i + shift <= m; i++) C[i + shift] = (C[i + shift] as number) ^ gmul(coef, B[i] as number);
        L = r + 1 - L;
        B.set(tmp);
        b = d;
        shift = 1;
      } else {
        for (let i = 0; i + shift <= m; i++) C[i + shift] = (C[i + shift] as number) ^ gmul(coef, B[i] as number);
        shift++;
      }
    }
    if (2 * L + f > m) return null;
    for (let i = L + 1; i <= m; i++) if (C[i] !== 0) return null;

    // Errata locator Lambda = C * Gamma.
    const lamDeg = L + gammaDeg;
    const lambda = new Uint8Array(lamDeg + 1);
    for (let i = 0; i <= L; i++) {
      const ci = C[i] as number;
      if (ci === 0) continue;
      for (let j = 0; j <= gammaDeg; j++) lambda[i + j] = (lambda[i + j] as number) ^ gmul(ci, gamma[j] as number);
    }

    // Chien search over the n valid positions.
    const positions: number[] = [];
    for (let pos = 0; pos < n; pos++) {
      const power = n - 1 - pos;
      const xinv = GF256_EXP[(255 - power) % 255] as number;
      if (evalAsc(lambda, lamDeg + 1, xinv) === 0) positions.push(pos);
    }
    if (positions.length !== lamDeg) return null;

    // Omega(x) = S(x) Lambda(x) mod x^m.
    const omega = new Uint8Array(m);
    for (let i = 0; i < m; i++) {
      let acc = 0;
      const lim = Math.min(i, lamDeg);
      for (let j = 0; j <= lim; j++) acc ^= gmul(lambda[j] as number, S[i - j] as number);
      omega[i] = acc;
    }
    // Formal derivative Lambda'(x): in characteristic 2 only odd-degree terms survive.
    const dlam = new Uint8Array(Math.max(lamDeg, 1));
    for (let i = 1; i <= lamDeg; i += 2) dlam[i - 1] = lambda[i] as number;

    // Forney with first consecutive root 0: e_j = X_j * Omega(X_j^-1) / Lambda'(X_j^-1).
    for (const pos of positions) {
      const power = n - 1 - pos;
      const X = GF256_EXP[power] as number;
      const xinv = GF256_EXP[(255 - power) % 255] as number;
      const num = evalAsc(omega, m, xinv);
      const den = evalAsc(dlam, dlam.length, xinv);
      if (den === 0) return null;
      const mag = gmul(gmul(X, num), GF256_INV[den] as number);
      cw[pos] = (cw[pos] as number) ^ mag;
    }

    if (!this.syndromes(cw, S)) return null;
    // Distance budget: the corrected word may differ from the input in at most L non-erased spots.
    let changedOutsideErasures = 0;
    for (let j = 0; j < n; j++) if (cw[j] !== codeword[j] && !eraSet.has(j)) changedOutsideErasures++;
    if (2 * changedOutsideErasures + f > m) return null;
    return cw.slice(0, this.k);
  }
}

