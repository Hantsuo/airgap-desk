import Dexie, { type EntityTable } from 'dexie';
import type { EgressManifest } from './egress';

/** Everything in this DB stays on the device. There is no sync table by design. */
export interface CaseRecord {
  id: string;
  caseNo: string;
  title: string;
  site: string;
  status: 'capture' | 'draft' | 'egress' | 'review';
  createdAt: number;
  updatedAt: number;
}

export type EvidenceKind = 'photo' | 'note' | 'audio' | 'doc';

export interface EvidenceRecord {
  id: string;
  caseId: string;
  kind: EvidenceKind;
  label: string;
  /** Text body for notes / transcripts; binary stays in `blob`. */
  text?: string;
  blob?: Blob;
  bytes: number;
  createdAt: number;
  /** Set by the local PII pass; never leaves the device in the skeleton. */
  piiFlags: string[];
}

export interface DraftField {
  key: string;
  label: string;
  value: string;
  /** Where the value came from: an evidence id or 'model'. */
  basis: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface DraftRecord {
  id: string;
  caseId: string;
  fields: DraftField[];
  source: 'nano' | 'cloud' | 'mock';
  latencyMs: number;
  createdAt: number;
  /** Bytes that would leave the device once the egress gate ships (P2). */
  egressEstimate: number;
}

/** Ed25519 key material. The private half never leaves this table. */
export interface SigningKeyRecord {
  id: string;
  alg: 'Ed25519-webcrypto' | 'Ed25519-noble';
  publicRaw: string; // base64url raw public key
  keyPair?: CryptoKeyPair;
  privateRaw?: string; // base64url, noble fallback only
  createdAt: number;
}

export interface ManifestRecord extends EgressManifest {
  /** decisions frozen at approval time */
  approvedIds: string[];
}

export interface ReceiptRecord {
  id: string;
  caseId: string;
  manifestId: string;
  short: string;
  json: string;
  createdAt: number;
}

export interface SoakSample {
  id: string;
  ts: string;
  ok: boolean;
  ms: number;
  source: string;
  rows: number;
  heapMB: number | null;
  error?: string;
}

export interface ReportRecord {
  id: string;
  caseId: string;
  receiptId: string;
  createdAt: number;
  accepted: Array<{ id: string; text: string; section: string; page: number; quote: string }>;
  returned: Array<{ id: string; text: string; reason: string }>;
}

export const db = new Dexie('airgap-desk') as Dexie & {
  cases: EntityTable<CaseRecord, 'id'>;
  evidence: EntityTable<EvidenceRecord, 'id'>;
  drafts: EntityTable<DraftRecord, 'id'>;
  manifests: EntityTable<ManifestRecord, 'id'>;
  receipts: EntityTable<ReceiptRecord, 'id'>;
  keys: EntityTable<SigningKeyRecord, 'id'>;
  reports: EntityTable<ReportRecord, 'id'>;
  soakSamples: EntityTable<SoakSample, 'id'>;
};

db.version(1).stores({
  cases: 'id, caseNo, status, updatedAt',
  evidence: 'id, caseId, kind, createdAt',
  drafts: 'id, caseId, createdAt',
});

db.version(2).stores({
  cases: 'id, caseNo, status, updatedAt',
  evidence: 'id, caseId, kind, createdAt',
  drafts: 'id, caseId, createdAt',
  manifests: 'id, caseId, draftId, createdAt',
  receipts: 'id, caseId, createdAt',
  keys: 'id',
});

db.version(3).stores({
  reports: 'id, caseId, receiptId, createdAt',
});

db.version(4).stores({
  soakSamples: 'id, ts',
});

export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
