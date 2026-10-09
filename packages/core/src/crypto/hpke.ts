/**
 * HPKE (RFC 9180) with KEM DHKEM(P-256, HKDF-SHA256) and KDF HKDF-SHA256, AEAD AES-128-GCM or AES-256-GCM.
 * Sealed uses suite 0x0010/0x0001/0x0002 (spec §5.1); AES-128-GCM is supported so the full CFRG vector set
 * for this KEM can be exercised. Private keys are reached only through `AgreementKey.dh`, so recipient keys
 * can live in the Secure Enclave, Android Keystore or a non-extractable WebCrypto key.
 */
import { concat, utf8 } from "../bytes";
import { AuthenticationError, P256, aesGcmOpenSync, aesGcmSealSync, hkdfExpand, hkdfExtract } from "./primitives";
import { SoftwareAgreementKey, type AgreementKey } from "./keys";

export const KEM_P256_SHA256 = 0x0010;
export const KDF_HKDF_SHA256 = 0x0001;
export const AEAD_AES128_GCM = 0x0001;
export const AEAD_AES256_GCM = 0x0002;

export enum HpkeMode {
  Base = 0x00,
  Psk = 0x01,
  Auth = 0x02,
  AuthPsk = 0x03,
}

const N_SECRET = 32;
const N_ENC = 65;
const N_SK = 32;
const N_H = 32;
const N_N = 12;

function i2osp(n: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = len - 1, v = n; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v & 0xff;
  return out;
}

const HPKE_V1 = utf8("HPKE-v1");
const KEM_SUITE = concat(utf8("KEM"), i2osp(KEM_P256_SHA256, 2));

function aeadKeyLength(aeadId: number): number {
  if (aeadId === AEAD_AES128_GCM) return 16;
  if (aeadId === AEAD_AES256_GCM) return 32;
  throw new Error(`unsupported HPKE AEAD id ${aeadId}`);
}

function hpkeSuite(aeadId: number): Uint8Array {
  return concat(utf8("HPKE"), i2osp(KEM_P256_SHA256, 2), i2osp(KDF_HKDF_SHA256, 2), i2osp(aeadId, 2));
}

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return hkdfExtract(salt, concat(HPKE_V1, suite, utf8(label), ikm));
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array {
  return hkdfExpand(prk, concat(i2osp(length, 2), HPKE_V1, suite, utf8(label), info), length);
}

/** RFC 9180 §7.1.3 DeriveKeyPair for P-256 (bitmask 0xff). */
export function deriveKeyPair(ikm: Uint8Array): SoftwareAgreementKey {
  const dkpPrk = labeledExtract(KEM_SUITE, new Uint8Array(0), "dkp_prk", ikm);
  for (let counter = 0; counter < 256; counter++) {
    const bytes = labeledExpand(KEM_SUITE, dkpPrk, "candidate", i2osp(counter, 1), N_SK);
    bytes[0] = (bytes[0] as number) & 0xff;
    if (P256.isValidSecretKey(bytes)) return new SoftwareAgreementKey(bytes);
  }
  throw new Error("DeriveKeyPairError");
}

function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const eaePrk = labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, eaePrk, "shared_secret", kemContext, N_SECRET);
}

function validatePublic(pk: Uint8Array): Uint8Array {
  if (pk.length !== N_ENC || !P256.isValidPublicKey(pk)) throw new Error("invalid P-256 public key for HPKE");
  return pk;
}

export interface EncapResult {
  sharedSecret: Uint8Array;
  enc: Uint8Array;
}

async function encap(pkR: Uint8Array, skS: AgreementKey | undefined, ephemeral?: AgreementKey): Promise<EncapResult> {
  validatePublic(pkR);
  const skE = ephemeral ?? new SoftwareAgreementKey();
  const enc = skE.publicKey;
  let dh = await skE.dh(pkR);
  let kemContext = concat(enc, pkR);
  if (skS) {
    dh = concat(dh, await skS.dh(pkR));
    kemContext = concat(kemContext, skS.publicKey);
  }
  return { sharedSecret: extractAndExpand(dh, kemContext), enc };
}

async function decap(enc: Uint8Array, skR: AgreementKey, pkS?: Uint8Array): Promise<Uint8Array> {
  validatePublic(enc);
  let dh = await skR.dh(enc);
  let kemContext = concat(enc, skR.publicKey);
  if (pkS) {
    validatePublic(pkS);
    dh = concat(dh, await skR.dh(pkS));
    kemContext = concat(kemContext, pkS);
  }
  return extractAndExpand(dh, kemContext);
}

export class HpkeContext {
  private seq = 0;

  constructor(
    readonly aeadId: number,
    readonly key: Uint8Array,
    readonly baseNonce: Uint8Array,
    readonly exporterSecret: Uint8Array,
  ) {}

  private nonce(): Uint8Array {
    if (this.seq >= Number.MAX_SAFE_INTEGER) throw new Error("HPKE message limit reached");
    const seqBytes = i2osp(this.seq, N_N);
    const out = new Uint8Array(N_N);
    for (let i = 0; i < N_N; i++) out[i] = (this.baseNonce[i] as number) ^ (seqBytes[i] as number);
    return out;
  }

  seal(aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const ct = aesGcmSealSync(this.key, this.nonce(), plaintext, aad);
    this.seq++;
    return ct;
  }

  open(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const pt = aesGcmOpenSync(this.key, this.nonce(), ciphertext, aad);
    this.seq++;
    return pt;
  }

  export(exporterContext: Uint8Array, length: number): Uint8Array {
    return labeledExpand(hpkeSuite(this.aeadId), this.exporterSecret, "sec", exporterContext, length);
  }
}

function keySchedule(mode: HpkeMode, aeadId: number, sharedSecret: Uint8Array, info: Uint8Array, psk: Uint8Array, pskId: Uint8Array): HpkeContext {
  const gotPsk = psk.length > 0;
  const gotPskId = pskId.length > 0;
  if (gotPsk !== gotPskId) throw new Error("inconsistent PSK inputs");
  const needsPsk = mode === HpkeMode.Psk || mode === HpkeMode.AuthPsk;
  if (needsPsk !== gotPsk) throw new Error(needsPsk ? "missing PSK" : "PSK supplied for non-PSK mode");
  const suite = hpkeSuite(aeadId);
  const pskIdHash = labeledExtract(suite, new Uint8Array(0), "psk_id_hash", pskId);
  const infoHash = labeledExtract(suite, new Uint8Array(0), "info_hash", info);
  const ksContext = concat(new Uint8Array([mode]), pskIdHash, infoHash);
  const secret = labeledExtract(suite, sharedSecret, "secret", psk);
  const key = labeledExpand(suite, secret, "key", ksContext, aeadKeyLength(aeadId));
  const baseNonce = labeledExpand(suite, secret, "base_nonce", ksContext, N_N);
  const exporterSecret = labeledExpand(suite, secret, "exp", ksContext, N_H);
  return new HpkeContext(aeadId, key, baseNonce, exporterSecret);
}

export interface SetupSenderOptions {
  mode: HpkeMode;
  aeadId?: number;
  recipientPublicKey: Uint8Array;
  info: Uint8Array;
  senderKey?: AgreementKey;
  psk?: Uint8Array;
  pskId?: Uint8Array;
  /** Test hook: fixed ephemeral key (RFC vectors). Never set in production. */
  ephemeral?: AgreementKey;
}

export async function setupSender(o: SetupSenderOptions): Promise<{ enc: Uint8Array; context: HpkeContext; sharedSecret: Uint8Array }> {
  const auth = o.mode === HpkeMode.Auth || o.mode === HpkeMode.AuthPsk;
  if (auth !== Boolean(o.senderKey)) throw new Error(auth ? "Auth mode requires senderKey" : "senderKey only allowed in Auth modes");
  const { sharedSecret, enc } = await encap(o.recipientPublicKey, o.senderKey, o.ephemeral);
  const context = keySchedule(o.mode, o.aeadId ?? AEAD_AES256_GCM, sharedSecret, o.info, o.psk ?? new Uint8Array(0), o.pskId ?? new Uint8Array(0));
  return { enc, context, sharedSecret };
}

export interface SetupRecipientOptions {
  mode: HpkeMode;
  aeadId?: number;
  enc: Uint8Array;
  recipientKey: AgreementKey;
  info: Uint8Array;
  senderPublicKey?: Uint8Array;
  psk?: Uint8Array;
  pskId?: Uint8Array;
}

export async function setupRecipient(o: SetupRecipientOptions): Promise<HpkeContext> {
  const auth = o.mode === HpkeMode.Auth || o.mode === HpkeMode.AuthPsk;
  if (auth !== Boolean(o.senderPublicKey)) throw new Error(auth ? "Auth mode requires senderPublicKey" : "senderPublicKey only allowed in Auth modes");
  const sharedSecret = await decap(o.enc, o.recipientKey, o.senderPublicKey);
  return keySchedule(o.mode, o.aeadId ?? AEAD_AES256_GCM, sharedSecret, o.info, o.psk ?? new Uint8Array(0), o.pskId ?? new Uint8Array(0));
}

/** Single-shot seal (one message per context), suite 0x0010/0x0001/0x0002. */
export async function seal(params: {
  recipientPublicKey: Uint8Array;
  info: Uint8Array;
  aad?: Uint8Array;
  plaintext: Uint8Array;
  senderKey?: AgreementKey;
}): Promise<{ enc: Uint8Array; ciphertext: Uint8Array }> {
  const { enc, context } = await setupSender({
    mode: params.senderKey ? HpkeMode.Auth : HpkeMode.Base,
    recipientPublicKey: params.recipientPublicKey,
    info: params.info,
    ...(params.senderKey ? { senderKey: params.senderKey } : {}),
  });
  return { enc, ciphertext: context.seal(params.aad ?? new Uint8Array(0), params.plaintext) };
}

export async function open(params: {
  recipientKey: AgreementKey;
  enc: Uint8Array;
  info: Uint8Array;
  aad?: Uint8Array;
  ciphertext: Uint8Array;
  senderPublicKey?: Uint8Array;
}): Promise<Uint8Array> {
  const context = await setupRecipient({
    mode: params.senderPublicKey ? HpkeMode.Auth : HpkeMode.Base,
    enc: params.enc,
    recipientKey: params.recipientKey,
    info: params.info,
    ...(params.senderPublicKey ? { senderPublicKey: params.senderPublicKey } : {}),
  });
  try {
    return context.open(params.aad ?? new Uint8Array(0), params.ciphertext);
  } catch (e) {
    if (e instanceof AuthenticationError) throw new AuthenticationError("HPKE open failed");
    throw e;
  }
}
