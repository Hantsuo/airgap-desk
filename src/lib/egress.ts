import type { DraftField } from './db';

/**
 * Egress Gate.
 *
 * Two layers, on purpose:
 *   1. deterministic rules  — decide what a PII pattern is; authoritative for redaction
 *   2. on-device model      — may only *raise* sensitivity (send -> stay), never lower it
 *
 * The cloud never sees anything this module did not produce as `cloudText`.
 */

export type EgressDecision = 'stay' | 'send';
export type PiiKind = 'name' | 'id' | 'phone' | 'address' | 'account' | 'medical' | 'hospital';

export interface RemovedBit {
  kind: PiiKind;
  count: number;
}

export interface EgressEntry {
  id: string;
  key: string;
  labelKey: string;
  decision: EgressDecision;
  originalChars: number;
  cloudChars: number;
  /** The exact text the cloud will receive. Empty when decision === 'stay'. */
  cloudText: string;
  removed: RemovedBit[];
  whyKey: string;
  destination: string;
  /** field-level sensitivity verdict from the local classifier */
  classifiedBy: 'nano' | 'rules';
}

export interface EgressManifest {
  id: string;
  caseId: string;
  draftId: string;
  caseNo: string;
  createdAt: number;
  entries: EgressEntry[];
  originalBytes: number;
  cloudBytes: number;
  classifier: 'nano' | 'rules';
  destination: string;
}

export const DESTINATION = 'Google (US servers)';

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;

/* ------------------------------------------------------------------ patterns */

const PATTERNS: Array<{ kind: PiiKind; re: RegExp; mask: string }> = [
  // 18-digit PRC ID, then 15-digit legacy
  { kind: 'id', re: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, mask: '[ID]' },
  { kind: 'id', re: /\b\d{15}\b/g, mask: '[ID]' },
  // CN mobile
  { kind: 'phone', re: /\b1[3-9]\d{9}\b/g, mask: '[PHONE]' },
  // international phone with separators
  { kind: 'phone', re: /\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}/g, mask: '[PHONE]' },
  // card / bank account
  { kind: 'account', re: /\b(?:\d[ -]?){15,19}\b/g, mask: '[ACCOUNT]' },
  // EN street address
  { kind: 'address', re: /\b\d{1,5}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,3}\s+(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Boulevard|Blvd\.?)\b/g, mask: '[ADDRESS]' },
  // CN address
  { kind: 'address', re: /[\u4e00-\u9fa5]{2,10}(?:小区|花园|大厦|公寓)[\u4e00-\u9fa5A-Za-z0-9]{0,12}(?:\d+栋)?(?:\d+单元)?(?:\d+室)?/g, mask: '[ADDRESS]' },
  { kind: 'address', re: /[\u4e00-\u9fa5]{2,10}(?:路|街|巷)\d{1,4}号/g, mask: '[ADDRESS]' },
  // hospital names
  { kind: 'hospital', re: /\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}\s+(?:Hospital|Medical Center|Clinic)\b/g, mask: '[HOSPITAL]' },
  { kind: 'hospital', re: /[\u4e00-\u9fa5]{2,8}(?:医院|卫生院|诊所)/g, mask: '[HOSPITAL]' },
];

/** Synthetic demo names. A real build would use an on-device NER pass; the rule keeps the demo deterministic. */
const KNOWN_NAMES = ['Daniel Reyes', 'Maria Chen', 'Wei Zhang', 'Anna Kovacs', 'Liam O\u2019Connor', 'Sofia Alvarez'];

export function scanPii(text: string): { masked: string; removed: RemovedBit[] } {
  const counts = new Map<PiiKind, number>();
  let masked = text;

  const bump = (k: PiiKind) => counts.set(k, (counts.get(k) ?? 0) + 1);

  for (const name of KNOWN_NAMES) {
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    masked = masked.replace(re, () => { bump('name'); return '[NAME]'; });
  }
  // "Mr. Chen" / "车主 王先生" style single surnames are handled as names too.
  masked = masked.replace(/\b(?:Mr|Ms|Mrs|Dr)\.?\s+([A-Z][a-z]{2,})\b/g, (_m, _n) => { bump('name'); return '[NAME]'; });

  for (const p of PATTERNS) {
    masked = masked.replace(p.re, () => { bump(p.kind); return p.mask; });
  }

  const removed = [...counts.entries()].map(([kind, count]) => ({ kind, count }));
  return { masked, removed };
}

/* --------------------------------------------------------------- classifier */

interface NanoVerdict {
  key: string;
  send: boolean;
  why: string;
}

/**
 * One single-turn call, JSON out, input never leaves the device.
 * Returns null when the on-device model is not usable — the rules still decide.
 */
async function nanoClassify(fields: Array<{ key: string; text: string }>): Promise<NanoVerdict[] | null> {
  try {
    const { nanoLLM, runOnDevice } = await import('./hybrid-llm');
    if (!(await nanoLLM.probe())) return null;
    const prompt = `You are a privacy classifier. For each field decide if it may be sent to a cloud LLM for insurance clause matching.
Rules: identity, contact, address, bank and medical-record data must NOT be sent. Incident facts may be sent.
Return ONLY JSON: {"fields":[{"key":"...","send":true,"why":"clause|fraud|pii|medical|contact"}]}

${fields.map((f) => `- ${f.key}: ${f.text.replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')}`;
    const text = await runOnDevice(prompt);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1)) as { fields?: NanoVerdict[] };
    return Array.isArray(parsed.fields) ? parsed.fields : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ builder */

const WHY: Record<string, string> = {
  clause: 'egress.why.clause',
  fraud: 'egress.why.fraud',
  identity: 'egress.why.identity',
  contact: 'egress.why.contact',
  medical: 'egress.why.medical',
  injury: 'egress.why.injury',
  address: 'egress.why.address',
  account: 'egress.why.account',
};

const HARD_STAY: PiiKind[] = ['id', 'phone', 'account', 'name'];

export async function buildManifest(input: {
  caseId: string;
  draftId: string;
  caseNo: string;
  site: string;
  draftFields: DraftField[];
  notes: string[];
  transcript?: string;
}): Promise<EgressManifest> {
  const get = (k: string) => input.draftFields.find((f) => f.key === k)?.value ?? '';

  const narrativeRaw = [...input.notes].join('\n\n') || '';
  const narrative = scanPii(narrativeRaw);
  const injuryRaw = get('injury');
  const injury = scanPii(injuryRaw);
  const locationRaw = get('location') || input.site;
  const location = scanPii(locationRaw);

  // Coarse the location: keep the street, drop house number, unit, floor, room.
  const locationCoarse = locationRaw
    .replace(/\b(?:unit|apt|apartment|floor|room)\s*[\w-]+/gi, '')
    .replace(/\b\d{1,5}\s+(?=[A-Z])/g, '')
    .replace(/(?:\d+单元)?(?:\d+室)?(?:\d+层)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
  const locationRemoved: RemovedBit[] = /\b\d{1,5}\b|单元|室|层/.test(locationRaw)
    ? [{ kind: 'address', count: 1 }]
    : [];

  const entries: EgressEntry[] = [];
  const destination = DESTINATION;

  const push = (
    key: string,
    labelKey: string,
    decision: EgressDecision,
    original: string,
    cloudText: string,
    removed: RemovedBit[],
    whyKey: string,
  ) => {
    entries.push({
      id: `eg_${key}`,
      key,
      labelKey,
      decision,
      originalChars: original.length,
      cloudChars: decision === 'send' ? cloudText.length : 0,
      cloudText: decision === 'send' ? cloudText : '',
      removed,
      whyKey,
      destination,
      classifiedBy: 'rules',
    });
  };

  // 1. incident facts — no PII, needed for the clause window
  const facts = [get('incidentTime'), get('cause'), get('waterDepthCm')].filter(Boolean).join(' · ');
  push('facts', 'field.facts', 'send', facts, facts, [], WHY.clause);

  // 2. location — street only, house number and unit removed
  push('location', 'field.location', 'send', locationRaw, locationCoarse, locationRemoved, WHY.address);

  // 3. narrative — redacted copy may go up; the verbatim notes stay
  push('narrative', 'field.narrative', 'send', narrativeRaw, narrative.masked, narrative.removed, WHY.clause);

  // 4. policy number — needed to fetch the clause set; not personal data
  push('policyNo', 'field.policyNo', 'send', get('policyNo'), get('policyNo'), [], WHY.clause);

  // 5. injury summary — hospital stripped, body part kept
  push('injury', 'field.injury', 'send', injuryRaw, injury.masked, injury.removed, WHY.injury);

  // 6. things that never go up
  push('notes_verbatim', 'field.notesVerbatim', 'stay', narrativeRaw, '', narrative.removed, WHY.identity);
  push('medical_record', 'field.medicalRecord', 'stay', injuryRaw, '', injury.removed, WHY.medical);
  push('identity', 'field.identity', 'stay', `${get('policyNo')} · insured identity block`, '', [{ kind: 'id', count: 1 }, { kind: 'name', count: 1 }], WHY.identity);
  push('bank_statement', 'field.bankStatement', 'stay', 'Bank statement (12 pages, synthetic)', '', [{ kind: 'account', count: 3 }], WHY.account);

  // Hard rule: any field that still carries a hard identifier may not be sent.
  for (const e of entries) {
    if (e.decision !== 'send') continue;
    const hard = e.removed.some((r) => HARD_STAY.includes(r.kind));
    const stillMasked = /\[(ID|PHONE|ACCOUNT|NAME)\]/.test(e.cloudText);
    if (hard && !stillMasked) {
      // identifier was present but somehow not masked: fail closed
      e.decision = 'stay';
      e.cloudChars = 0;
      e.cloudText = '';
      e.whyKey = WHY.identity;
    }
  }

  // On-device second opinion: may only turn send -> stay.
  let classifier: 'nano' | 'rules' = 'rules';
  const verdicts = await nanoClassify(entries.map((e) => ({ key: e.key, text: e.cloudText || e.key })));
  if (verdicts?.length) {
    classifier = 'nano';
    for (const v of verdicts) {
      const e = entries.find((x) => x.key === v.key);
      if (!e) continue;
      e.classifiedBy = 'nano';
      if (e.decision === 'send' && v.send === false) {
        e.decision = 'stay';
        e.cloudChars = 0;
        e.cloudText = '';
        e.whyKey = WHY[v.why] ?? WHY.identity;
      }
    }
  }

  const originalBytes = entries.reduce((n, e) => n + bytes(e.cloudText || '') + e.originalChars, 0);
  const cloudBytes = entries.filter((e) => e.decision === 'send').reduce((n, e) => n + bytes(e.cloudText), 0);

  return {
    id: `mf_${Date.now().toString(36)}`,
    caseId: input.caseId,
    draftId: input.draftId,
    caseNo: input.caseNo,
    createdAt: Date.now(),
    entries,
    originalBytes,
    cloudBytes,
    classifier,
    destination,
  };
}

/** The exact payload the cloud is allowed to see. */
export function buildCloudPayload(manifest: EgressManifest, extra: Record<string, string> = {}) {
  const sent = manifest.entries.filter((e) => e.decision === 'send' && e.cloudText);
  return {
    caseNo: manifest.caseNo,
    ...extra,
    fields: sent.map((e) => ({ key: e.key, text: e.cloudText })),
  };
}
