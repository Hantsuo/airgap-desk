import { runInCloud, runOnDevice } from './hybrid-llm';

/**
 * Cloud read-back + on-device citation check.
 *
 * The cloud gets only the approved, redacted fields. Every conclusion it returns
 * must carry a citation that exists in the policy text. The check runs on this
 * device with a single-turn prompt; a failed conclusion is returned and never
 * written into the report.
 */

export const POLICY_TEXT = `SYNTHETIC POLICY — Motor Comprehensive, form MC-2026 (demo only)

SECTION 3.1 (page 7)
Insured events. We cover direct physical loss to the insured vehicle caused by collision, overturning, fire, explosion, theft, flood, typhoon, or falling objects.

SECTION 3.4 (page 9)
Exclusions. We do not cover loss caused by the insured deliberately driving into standing water, by racing, or by use of the vehicle outside the declared purpose.

SECTION 4.2.1 (page 12)
Flood and water damage. We cover direct physical loss caused by flood, surface water, or water that escapes from a plumbing system, up to the sum insured. Water damage to the interior is covered when the water line is recorded at or above the sill of the driver door.

SECTION 4.2.3 (page 13)
Betterment. Where a repair restores the vehicle to a condition better than before the loss, we pay the depreciated value of the damaged parts only.

SECTION 6.1 (page 21)
Claim notice. The insured must notify us within 48 hours of discovering the loss, and must not move the vehicle before we authorise removal, unless it is unsafe to leave it in place.

SECTION 7.5 (page 24)
Subrogation. After we pay, we take over the insured's right to recover the loss from a third party, and the insured must assist us with that recovery.`;

export interface Citation {
  section: string;
  page: number;
  quote: string;
}

export interface Conclusion {
  id: string;
  text: string;
  citation: Citation;
  basis: string;
}

export interface CheckedConclusion extends Conclusion {
  verdict: 'pass' | 'fail';
  reason: string;
  checkedBy: 'nano' | 'rules';
  /** Injected by the demo control, never returned by the cloud. */
  test?: boolean;
}

export interface CloudResult {
  conclusions: CheckedConclusion[];
  payload: string;
  latencyMs: number;
  cloudError?: string;
}

const norm = (s: string) =>
  s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

function parseJsonArray(text: string): unknown[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown[];
  } catch {
    return null;
  }
}

const CLOUD_PROMPT = (payloadText: string) => `You are an insurance clause checker. You receive only redacted field values.
Read the policy text and return at most 3 conclusions that matter for this claim.

Hard rules:
- Every conclusion MUST carry a citation whose "quote" is copied CHARACTER FOR CHARACTER from the policy text. Do not paraphrase, do not shorten with ellipses, do not invent a section.
- Write every conclusion and every "basis" value in English only. Do not use Chinese characters.
- If you cannot cite an exact sentence, do not return that conclusion.
- Return ONLY JSON: {"conclusions":[{"id":"c1","text":"...","basis":"which field","citation":{"section":"4.2.1","page":12,"quote":"exact sentence"}}]}

POLICY TEXT:
${POLICY_TEXT}

CLAIM FIELDS (already approved and redacted):
${payloadText}`;

async function nanoSupports(conclusion: Conclusion, clause: string): Promise<{ ok: boolean; reason: string } | null> {
  try {
    const prompt = `Decide whether the conclusion is supported by the quoted clause sentence.
Answer ONLY JSON: {"supported":true|false,"reason":"short"}
CLAUSE SENTENCE: ${conclusion.citation.quote}
CONCLUSION: ${conclusion.text}
CITED FROM: ${clause.slice(0, 600)}`;
    const text = await runOnDevice(prompt);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1)) as { supported?: boolean; reason?: string };
    if (typeof parsed.supported !== 'boolean') return null;
    return { ok: parsed.supported, reason: parsed.reason ?? '' };
  } catch {
    return null;
  }
}

/** Deterministic + on-device check of one conclusion. */
export async function checkConclusion(c: Conclusion): Promise<CheckedConclusion> {
  const quote = norm(c.citation?.quote ?? '');
  if (!quote) {
    return { ...c, verdict: 'fail', reason: 'No citation quote returned.', checkedBy: 'rules' };
  }

  const policy = norm(POLICY_TEXT);
  const exact = policy.includes(quote);

  const sectionLine = `SECTION ${c.citation.section}`;
  const sectionExists = policy.includes(norm(sectionLine));
  const pageExists = new RegExp(`\\(page ${c.citation.page}\\)`).test(policy);

  if (!exact) {
    return {
      ...c,
      verdict: 'fail',
      reason: `Quote is not verbatim in the policy text (${quote.slice(0, 60)}…).`,
      checkedBy: 'rules',
    };
  }
  if (!sectionExists || !pageExists) {
    return {
      ...c,
      verdict: 'fail',
      reason: `Citation points to ${sectionLine} page ${c.citation.page}, which does not exist in this policy.`,
      checkedBy: 'rules',
    };
  }

  const semantic = await nanoSupports(c, POLICY_TEXT);
  if (!semantic) {
    return {
      ...c,
      verdict: 'pass',
      reason: 'Quote matched verbatim; semantic check skipped (on-device model unavailable, rules-only).',
      checkedBy: 'rules',
    };
  }
  if (!semantic.ok) {
    return {
      ...c,
      verdict: 'fail',
      reason: `On-device check: the quote does not support the conclusion. ${semantic.reason}`.trim(),
      checkedBy: 'nano',
    };
  }
  return {
    ...c,
    verdict: 'pass',
    reason: 'Quote matched verbatim and the on-device check agrees.',
    checkedBy: 'nano',
  };
}

export async function runCloudReview(cloudPayload: unknown): Promise<CloudResult> {
  const payloadText = JSON.stringify(cloudPayload, null, 2);
  const t0 = performance.now();
  try {
    const raw = await runInCloud(CLOUD_PROMPT(payloadText));
    const parsed = parseJsonArray(raw);
    if (!parsed) {
      return { conclusions: [], payload: payloadText, latencyMs: Math.round(performance.now() - t0), cloudError: 'Cloud did not return JSON.' };
    }
    const conclusions = parsed
      .map((v, i) => {
        const o = v as Record<string, any>;
        return {
          id: String(o.id ?? `c${i + 1}`),
          text: String(o.text ?? ''),
          basis: String(o.basis ?? ''),
          citation: {
            section: String(o.citation?.section ?? ''),
            page: Number(o.citation?.page ?? 0),
            quote: String(o.citation?.quote ?? ''),
          },
        } satisfies Conclusion;
      })
      .filter((c) => c.text)
      // The cloud must answer in English; never render a Chinese token in the English UI.
      .filter((c) => !/[\u3400-\u9FFF]/.test(c.text) && !/[\u3400-\u9FFF]/.test(c.basis));

    if (conclusions.length === 0) {
      return {
        conclusions: [],
        payload: payloadText,
        latencyMs: Math.round(performance.now() - t0),
        cloudError: 'Cloud returned no English conclusions. Re-run the check.',
      };
    }

    const checked: CheckedConclusion[] = [];
    for (const c of conclusions) checked.push(await checkConclusion(c));

    return { conclusions: checked, payload: payloadText, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) {
    const err = e as Error & { code?: string };
    return {
      conclusions: [],
      payload: payloadText,
      latencyMs: Math.round(performance.now() - t0),
      cloudError: `${err.code ?? err.name}: ${err.message}`,
    };
  }
}
