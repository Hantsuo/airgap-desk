import { db, newId, type SigningKeyRecord } from './db';

/**
 * Egress receipt.
 *
 *   canonical JSON  -> SHA-256 -> hash chain (prev) -> Ed25519 signature
 *
 * The private key is generated on this device and stored only in IndexedDB.
 * A receipt carries its own public key so a third party can verify it in a
 * private window with no account and no backend.
 */

export interface ReceiptItem {
  field: string;
  chars: number;
  sha256: string;
}

export interface ReceiptPayload {
  v: 1;
  caseNo: string;
  seq: number;
  prev: string;
  signedAt: string;
  destination: string;
  manifestId: string;
  cloudPayloadSha256: string;
  items: ReceiptItem[];
}

export interface Receipt {
  payload: ReceiptPayload;
  hash: string;
  sig: string;
  pub: string;
  alg: 'Ed25519';
  short: string;
}

export interface CreatedReceipt {
  receipt: Receipt;
  id: string;
}

const KEY_ID = 'device-signing-key-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string) => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const hex = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/** Deterministic JSON: object keys sorted at every level, no whitespace. */
export function canonicalize(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = walk((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  return hex(await crypto.subtle.digest('SHA-256', data as unknown as BufferSource));
}

/* --------------------------------------------------------------- key material */

interface Signer {
  alg: 'Ed25519-webcrypto' | 'Ed25519-noble';
  publicRaw: Uint8Array;
  sign(msg: Uint8Array): Promise<Uint8Array>;
}

async function webcryptoSupported() {
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' } as unknown as AlgorithmIdentifier, true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function noble(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ed: any = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha2.js');
  ed.hashes.sha512 = sha512;
  return ed;
}

let signerCache: Signer | null = null;

async function nobleSigner(priv: Uint8Array): Promise<Signer> {
  const ed = await noble();
  return {
    alg: 'Ed25519-noble',
    publicRaw: ed.getPublicKey(priv),
    sign: async (msg: Uint8Array) => ed.sign(msg, priv),
  };
}

async function loadSigner(): Promise<Signer> {
  if (signerCache) return signerCache;

  const existing = await db.keys.get(KEY_ID);

  if (existing?.alg === 'Ed25519-webcrypto' && existing.keyPair) {
    signerCache = {
      alg: 'Ed25519-webcrypto',
      publicRaw: fromB64url(existing.publicRaw),
      sign: async (msg) =>
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'Ed25519' } as unknown as AlgorithmIdentifier,
            existing.keyPair!.privateKey,
            msg as unknown as BufferSource,
          ),
        ),
    };
    return signerCache;
  }

  if (existing?.alg === 'Ed25519-noble' && existing.privateRaw) {
    signerCache = await nobleSigner(fromB64url(existing.privateRaw));
    return signerCache;
  }

  if (await webcryptoSupported()) {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' } as unknown as AlgorithmIdentifier, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const rec: SigningKeyRecord = {
      id: KEY_ID,
      alg: 'Ed25519-webcrypto',
      publicRaw: b64url(publicRaw),
      keyPair: kp,
      createdAt: Date.now(),
    };
    await db.keys.put(rec);
    signerCache = {
      alg: 'Ed25519-webcrypto',
      publicRaw,
      sign: async (msg) =>
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'Ed25519' } as unknown as AlgorithmIdentifier,
            kp.privateKey,
            msg as unknown as BufferSource,
          ),
        ),
    };
    return signerCache;
  }

  const ed = await noble();
  const priv: Uint8Array = ed.randomSecretKey();
  const rec: SigningKeyRecord = {
    id: KEY_ID,
    alg: 'Ed25519-noble',
    publicRaw: b64url(ed.getPublicKey(priv)),
    privateRaw: b64url(priv),
    createdAt: Date.now(),
  };
  await db.keys.put(rec);
  signerCache = await nobleSigner(priv);
  return signerCache;
}

export async function publicKeyRaw(): Promise<Uint8Array> {
  return (await loadSigner()).publicRaw;
}

/* -------------------------------------------------------------------- create */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function shortCode(hashHex: string): string {
  const first = parseInt(hashHex.slice(0, 8), 16);
  let n = first >>> 2;
  let out = '';
  for (let i = 0; i < 6; i++) {
    out = CROCKFORD[n & 31] + out;
    n >>>= 5;
  }
  return out;
}

export async function createReceipt(input: {
  caseId: string;
  caseNo: string;
  manifestId: string;
  destination: string;
  items: ReceiptItem[];
  cloudPayload: string;
}): Promise<CreatedReceipt> {
  const signer = await loadSigner();

  const prior = await db.receipts.where('caseId').equals(input.caseId).sortBy('createdAt');
  const last = prior.at(-1);
  const prev = last ? (JSON.parse(last.json) as Receipt).hash : 'genesis';

  const payload: ReceiptPayload = {
    v: 1,
    caseNo: input.caseNo,
    seq: prior.length + 1,
    prev,
    signedAt: new Date().toISOString(),
    destination: input.destination,
    manifestId: input.manifestId,
    cloudPayloadSha256: await sha256Hex(input.cloudPayload),
    items: input.items,
  };

  const canonical = canonicalize(payload);
  const hash = await sha256Hex(canonical);
  const sig = await signer.sign(enc.encode(canonical));

  const receipt: Receipt = {
    payload,
    hash,
    sig: b64url(sig),
    pub: b64url(signer.publicRaw),
    alg: 'Ed25519',
    short: shortCode(hash),
  };

  const recordId = newId('rc');
  await db.receipts.add({
    id: recordId,
    caseId: input.caseId,
    manifestId: input.manifestId,
    short: receipt.short,
    json: JSON.stringify(receipt),
    createdAt: Date.now(),
  });

  return { receipt, id: recordId };
}

/* -------------------------------------------------------------------- verify */

export interface VerifyResult {
  ok: boolean;
  parsed: boolean;
  hashOk: boolean;
  sigOk: boolean;
  receipt?: Receipt;
  error?: string;
}

export async function verifyReceipt(input: string | Receipt): Promise<VerifyResult> {
  let receipt: Receipt;
  try {
    receipt = typeof input === 'string' ? (JSON.parse(input) as Receipt) : input;
  } catch (e) {
    return { ok: false, parsed: false, hashOk: false, sigOk: false, error: (e as Error).message };
  }
  if (!receipt?.payload || !receipt.hash || !receipt.sig || !receipt.pub) {
    return { ok: false, parsed: false, hashOk: false, sigOk: false, error: 'missing fields' };
  }

  const canonical = canonicalize(receipt.payload);
  const hash = await sha256Hex(canonical);
  const hashOk = hash === receipt.hash;

  let sigOk = false;
  try {
    const pub = fromB64url(receipt.pub);
    const sig = fromB64url(receipt.sig);
    if (await webcryptoSupported()) {
      const key = await crypto.subtle.importKey(
        'raw',
        pub as unknown as BufferSource,
        { name: 'Ed25519' } as unknown as AlgorithmIdentifier,
        false,
        ['verify'],
      );
      sigOk = await crypto.subtle.verify(
        { name: 'Ed25519' } as unknown as AlgorithmIdentifier,
        key,
        sig as unknown as BufferSource,
        enc.encode(canonical) as unknown as BufferSource,
      );
    } else {
      const ed = await noble();
      sigOk = await ed.verifyAsync(sig, enc.encode(canonical), pub);
    }
  } catch (e) {
    return { ok: false, parsed: true, hashOk, sigOk: false, receipt, error: (e as Error).message };
  }

  return { ok: hashOk && sigOk, parsed: true, hashOk, sigOk, receipt };
}

export const receiptToJson = (r: Receipt) => JSON.stringify(r, null, 2);export const receiptToFragment = (r: Receipt) => b64url(enc.encode(JSON.stringify(r)));
export const fragmentToReceipt = (f: string) => dec.decode(fromB64url(f));

export { b64url, fromB64url, hex };


/* ----------------------------------------------------------------- migration */

/**
 * Re-sign every stored receipt with the current destination label.
 * The chain is rebuilt in order so prev hashes stay consistent.
 * Only needed because the demo database predates the label change.
 */
export async function resignAllReceipts(destination: string): Promise<number> {
  const rows = await db.receipts.orderBy('createdAt').toArray();
  const signer = await loadSigner();
  let prev = 'genesis';
  let changed = 0;

  for (const row of rows) {
    const old = JSON.parse(row.json) as Receipt;
    const payload: ReceiptPayload = { ...old.payload, destination, prev };
    const canonical = canonicalize(payload);
    const hash = await sha256Hex(canonical);
    const sig = await signer.sign(enc.encode(canonical));
    const next: Receipt = {
      payload,
      hash,
      sig: b64url(sig),
      pub: b64url(signer.publicRaw),
      alg: 'Ed25519',
      short: shortCode(hash),
    };
    prev = hash;
    if (row.json !== JSON.stringify(next)) {
      await db.receipts.update(row.id, { json: JSON.stringify(next), short: next.short });
      changed++;
    }
  }
  return changed;
}
