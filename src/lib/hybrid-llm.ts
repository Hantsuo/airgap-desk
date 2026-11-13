import type { DraftField } from './db';

/**
 * HybridLLM — one interface, three implementations.
 *
 *   nano  : Chrome on-device model through Firebase AI Logic (PREFER_ON_DEVICE)
 *   cloud : Gemini through Firebase AI Logic (PREFER_IN_CLOUD)
 *   mock  : deterministic local extractor, no network, no model
 *
 * The rest of the app never talks to Firebase directly. That keeps the egress
 * policy in one place: only `cloud` can leave the device.
 */
export type LlmId = 'nano' | 'cloud' | 'mock';

export interface ExtractInput {
  caseNo: string;
  site: string;
  notes: string[];
  transcript?: string;
}

export interface ExtractResult {
  fields: DraftField[];
  source: LlmId;
  latencyMs: number;
  raw: string;
}

export interface HybridLLM {
  id: LlmId;
  label: string;
  /** True when this implementation can run right now on this device. */
  probe(): Promise<boolean>;
  extract(input: ExtractInput): Promise<ExtractResult>;
}

const FIELDS = [
  { key: 'incidentTime', label: '事故时间' },
  { key: 'location', label: '事故地点' },
  { key: 'waterDepthCm', label: '水位（cm）' },
  { key: 'injury', label: '伤情' },
  { key: 'policyNo', label: '保单号' },
  { key: 'cause', label: '初判原因' },
] as const;

const PROMPT = (input: ExtractInput) => `You are an insurance claims assistant. Extract fields from the field notes below. Never invent values.
Return JSON with exactly these keys: ${FIELDS.map((f) => f.key).join(', ')}.
Use an empty string when a field is not present. Write values in English.

Case number: ${input.caseNo}
Site: ${input.site}
Field notes:
${input.notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}
${input.transcript ? `Interview transcript:\n${input.transcript}` : ''}

Return only JSON.`;

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toFields(obj: Record<string, unknown> | null, basis: string): DraftField[] {
  return FIELDS.map((f) => {
    const raw = obj?.[f.key];
    const value = raw == null ? '' : String(raw);
    return {
      key: f.key,
      label: f.label,
      value,
      basis,
      confidence: value ? 'medium' : 'low',
    } satisfies DraftField;
  });
}

/**
 * Chrome suspends the on-device session when it idles. The first call after a
 * pause can hang instead of failing; a fresh session plus one retry recovers.
 */
async function generateWithRetry(model: any, prompt: string): Promise<any> {
  try {
    return await withTimeout(model.generateContent(prompt), 12000, 'generateContent');
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code !== 'device/generate-timeout') throw e;
    console.info('[nano] first call hung, re-opening the device session and retrying');
    deviceInitAt = 0;
    await withTimeout(ensureDeviceModel(model), DEVICE_INIT_TIMEOUT_MS, 'initializeDeviceModel');
    return await withTimeout(model.generateContent(prompt), 45000, 'generateContent');
  }
}

/* ------------------------------------------------------------------ firebase */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const modelCache = new Map<string, any>();

async function firebaseModel(mode: 'only_on_device' | 'prefer_in_cloud') {
  const cached = modelCache.get(mode);
  if (cached) return cached;
  const { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } = await import('firebase/ai');
  const { getFirebaseApp } = await import('./firebase');
  const app = getFirebaseApp();
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  const model = getGenerativeModel(ai, {
    // The capture path must never leak to the cloud by accident: if the device
    // model is not ready we want an error, not a silent cloud fallback.
    mode: mode === 'only_on_device' ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.PREFER_IN_CLOUD,
  });
  modelCache.set(mode, model);
  return model;
}

const DEVICE_INIT_TIMEOUT_MS = 25_000;
const DEVICE_INIT_MAX_AGE_MS = 30_000;
let deviceInit: Promise<void> | null = null;
let deviceInitAt = 0;

/**
 * Chrome suspends the on-device session when it sits idle; the next
 * generateContent then hangs instead of failing. Re-priming is cheap when the
 * model is already downloaded, so refresh the session if it is older than 30s.
 */
function ensureDeviceModel(model: { initializeDeviceModel(cb?: (p: number) => void): Promise<void> }): Promise<void> {
  if (!deviceInit || Date.now() - deviceInitAt > DEVICE_INIT_MAX_AGE_MS) {
    deviceInitAt = Date.now();
    deviceInit = model.initializeDeviceModel(() => {});
  }
  return deviceInit;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        const err = new Error(`${label} timed out after ${ms}ms`) as Error & { code?: string };
        err.code = label === 'generateContent' ? 'device/generate-timeout' : 'device/init-timeout';
        reject(err);
      }, ms),
    ),
  ]);
}

/* --------------------------------------------------------------------- nano */

export const nanoLLM: HybridLLM = {
  id: 'nano',
  label: '本机 Gemini Nano',
  async probe() {
    if (typeof window === 'undefined') return false;
    const LM = (window as unknown as { LanguageModel?: { availability(): Promise<string> } }).LanguageModel;
    if (!LM) return false;
    try {
      return (await LM.availability()) === 'available';
    } catch {
      return false;
    }
  },
  async extract(input) {
    const t0 = performance.now();
    const model = await firebaseModel('only_on_device');
    // initializeDeviceModel() must follow a user gesture; callers invoke this from a click.
    await withTimeout(ensureDeviceModel(model), DEVICE_INIT_TIMEOUT_MS, 'initializeDeviceModel');
    const result = await generateWithRetry(model, PROMPT(input));
    const raw = result.response.text();
    const ms = Math.round(performance.now() - t0);
    return { fields: toFields(parseJsonLoose(raw), 'nano'), source: 'nano', latencyMs: ms, raw };
  },
};

/* -------------------------------------------------------------------- cloud */

export const cloudLLM: HybridLLM = {
  id: 'cloud',
  label: '云端 Gemini',
  async probe() {
    return typeof window !== 'undefined' && navigator.onLine;
  },
  async extract(input) {
    const t0 = performance.now();
    const model = await firebaseModel('prefer_in_cloud');
    const result = await model.generateContent(PROMPT(input));
    const raw = result.response.text();
    const ms = Math.round(performance.now() - t0);
    return { fields: toFields(parseJsonLoose(raw), 'cloud'), source: 'cloud', latencyMs: ms, raw };
  },
};

/** One single-turn call on the device model. Used by the egress classifier and the citation checker. */
export async function runOnDevice(prompt: string): Promise<string> {
  const model = await firebaseModel('only_on_device');
  await withTimeout(ensureDeviceModel(model), DEVICE_INIT_TIMEOUT_MS, 'initializeDeviceModel');
  const result = await generateWithRetry(model, prompt);
  return result.response.text();
}

/** One single-turn cloud call. Only the egress gate may build its prompt. */
export async function runInCloud(prompt: string): Promise<string> {
  const model = await firebaseModel('prefer_in_cloud');
  const result = await model.generateContent(prompt);
  return result.response.text();
}

/**
 * Prime the on-device model inside a real user gesture.
 * Safe to call repeatedly: the init promise is shared and bounded by a timeout.
 */
export async function warmDeviceModel(): Promise<boolean> {
  try {
    const model = await firebaseModel('only_on_device');
    await withTimeout(ensureDeviceModel(model), DEVICE_INIT_TIMEOUT_MS, 'initializeDeviceModel');
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------- mock */

/** Offline fallback. Deterministic, no model, no network — keeps the main path walkable. */
export const mockLLM: HybridLLM = {
  id: 'mock',
  label: '本机规则（离线兜底）',
  async probe() {
    return true;
  },
  async extract(input) {
    const t0 = performance.now();
    const text = [...input.notes, input.transcript ?? ''].join('\n');

    const dt = text.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})[日]?\s*(\d{1,2}:\d{2})?/);
    const depth = text.match(/(\d{1,3})\s*(?:cm|厘米|公分)/i);
    const policy = text.match(/[A-Z]{1,3}-?\d{3,4}-?\d{3,4}/);
    const injury = /(骨折|挫伤|软组织|擦伤|扭伤|烧伤|无伤|fracture|sprain|burn|concussion|injury)/i.exec(text)?.[1] ?? '';
    const cause = /(水淹|泡水|涉水|暴雨|洪水|碰撞|追尾|flood|water damage|collision|rear-end)/i.exec(text)?.[1] ?? '';

    const obj: Record<string, string> = {
      incidentTime: dt ? `${dt[1]}-${String(dt[2]).padStart(2, '0')}-${String(dt[3]).padStart(2, '0')}${dt[4] ? ' ' + dt[4] : ''}` : '',
      location: input.site,
      waterDepthCm: depth ? depth[1] : '',
      injury,
      policyNo: policy ? policy[0] : '',
      cause,
    };
    const ms = Math.round(performance.now() - t0);
    return {
      fields: toFields(obj, 'mock'),
      source: 'mock',
      latencyMs: ms,
      raw: JSON.stringify(obj),
    };
  },
};

/* ------------------------------------------------------------------ resolve */

export const ALL_LLMS: HybridLLM[] = [nanoLLM, cloudLLM, mockLLM];

/**
 * Preference order for the capture path: on-device first, mock last.
 * Cloud is never chosen implicitly — sending needs an explicit user action (P2).
 */
export async function resolveCaptureLLM(): Promise<HybridLLM> {
  if (await nanoLLM.probe()) return nanoLLM;
  return mockLLM;
}
