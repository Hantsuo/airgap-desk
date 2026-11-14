'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { db, newId, type ManifestRecord } from '@/lib/db';
import { buildCloudPayload } from '@/lib/egress';
import type { Receipt } from '@/lib/receipt';
import { receiptToFragment } from '@/lib/receipt';
import { checkConclusion, runCloudReview, type CheckedConclusion, type CloudResult, type Conclusion } from '@/lib/review';
import { StatusBar } from '@/components/StatusBar';
import { TopBar } from '@/components/TopBar';
import { useI18n } from '@/lib/i18n';

function ReviewPage() {
  const search = useSearchParams();
  const receiptId = search.get('id') ?? '';
  const { t } = useI18n();

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [manifest, setManifest] = useState<ManifestRecord | null>(null);
  const [result, setResult] = useState<CloudResult | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testRan, setTestRan] = useState(false);
  const [report, setReport] = useState<{ accepted: unknown[]; returned: unknown[] } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    (async () => {
      const rec = await db.receipts.get(receiptId);
      if (!rec) return;
      const r = JSON.parse(rec.json) as Receipt;
      setReceipt(r);
      const m = await db.manifests.get(r.payload.manifestId);
      if (m) {
        setManifest(m);
        if (!started.current) {
          started.current = true;
          void send(m);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptId]);

  async function persistReport(conclusions: CheckedConclusion[], m: ManifestRecord) {
    const accepted = conclusions
      .filter((c) => !c.test && c.verdict === 'pass')
      .map((c) => ({ id: c.id, text: c.text, section: c.citation.section, page: c.citation.page, quote: c.citation.quote }));
    const returned = conclusions
      .filter((c) => !c.test && c.verdict === 'fail')
      .map((c) => ({ id: c.id, text: c.text, reason: c.reason }));
    setReport({ accepted, returned });
    await db.reports.put({
      id: newId('rp'),
      caseId: m.caseId,
      receiptId: receiptId,
      createdAt: Date.now(),
      accepted,
      returned,
    });
    console.info(`[report] saved draft: accepted=${accepted.length} returned=${returned.length}`);
  }

  async function send(m: ManifestRecord) {
    setRunning(true);
    const payload = buildCloudPayload(m);
    console.info(`[cloud] sending ${m.approvedIds.length} approved items, ${new TextEncoder().encode(JSON.stringify(payload)).length} bytes`);
    const res = await runCloudReview(payload);
    console.info(`[cloud] returned ${res.conclusions.length} conclusions in ${res.latencyMs}ms${res.cloudError ? ` error=${res.cloudError}` : ''}`);
    for (const c of res.conclusions) {
      console.info(`[check] ${c.id} verdict=${c.verdict} by=${c.checkedBy} section=${c.citation.section} p.${c.citation.page} reason=${c.reason}`);
    }
    setResult(res);
    setRunning(false);
    await persistReport(res.conclusions, m);
  }

  async function recheck(id: string) {
    if (!result || !manifest) return;
    const target = result.conclusions.find((c) => c.id === id);
    if (!target) return;
    setChecking(id);
    const fresh = await checkConclusion(target);
    const next = result.conclusions.map((c) => (c.id === id ? fresh : c));
    setResult({ ...result, conclusions: next });
    setChecking(null);
    await persistReport(next, manifest);
    console.info(`[check] rechecked ${id} verdict=${fresh.verdict} by=${fresh.checkedBy}`);
  }

  /**
   * Deliberately bad citation. This is a demo control, clearly labelled: the
   * conclusion below is synthetic and never came from the cloud.
   */
  async function runTestCitation() {
    if (!manifest) return;
    setTesting(true);
    const synthetic: Conclusion = {
      id: 'test-citation',
      text: 'Test: a synthetic conclusion that cites a clause which does not exist in this policy.',
      basis: 'demo control — not cloud output',
      citation: {
        section: '9.9.9',
        page: 99,
        quote: 'The insurer waives every exclusion for vehicles parked in basements.',
      },
    };
    const checked = await checkConclusion(synthetic);
    checked.test = true;
    setTestRan(true);
    setResult((prev) =>
      prev
        ? { ...prev, conclusions: [...prev.conclusions.filter((c) => c.id !== checked.id), checked] }
        : { conclusions: [checked], payload: '', latencyMs: 0 },
    );
    setTesting(false);
    console.info(`[test] deliberately bad citation -> verdict=${checked.verdict} by=${checked.checkedBy} reason=${checked.reason}`);
  }

  async function copyReceipt() {
    if (!receipt) return;
    await navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  const approved = manifest?.entries.filter((e) => e.decision === 'send' && e.cloudText) ?? [];
  const conclusions = (result?.conclusions ?? []).filter((c) => !c.test);
  const okDevice = conclusions.filter((c) => c.verdict === 'pass' && c.checkedBy === 'nano').length;
  const okRules = conclusions.filter((c) => c.verdict === 'pass' && c.checkedBy === 'rules').length;
  const bad = conclusions.filter((c) => c.verdict === 'fail').length;

  return (
    <div className="shell">
      <TopBar tagKey="app.tagReceipt" badge={receipt ? `RECEIPT ${receipt.short} · SENT` : undefined} />
      <StatusBar />

      <div className="grid" style={{ gridTemplateColumns: '0.95fr 1.35fr' }}>
        <section>
          <div className="panel">
            <h2>{t('receipt.title')}</h2>
            {!receipt && <p className="hint">{t('common.loading')}</p>}
            {receipt && (
              <div className="receipt-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div>
                    <div className="hint" style={{ margin: 0 }}>{t('receipt.shortCode')}</div>
                    <div className="code">{receipt.short}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="hint" style={{ margin: 0 }}>{t('receipt.seq')}</div>
                    <div className="mono">#{receipt.payload.seq}</div>
                  </div>
                </div>
                <dl className="kv" style={{ marginTop: 12 }}>
                  <dt>{t('verify.case')}</dt><dd>{receipt.payload.caseNo}</dd>
                  <dt>{t('receipt.destination')}</dt><dd>{receipt.payload.destination}</dd>
                  <dt>{t('receipt.time')}</dt><dd className="mono">{receipt.payload.signedAt}</dd>
                  <dt>{t('receipt.algo')}</dt><dd className="mono">{receipt.alg}</dd>
                  <dt>{t('receipt.chain')}</dt><dd className="mono">{receipt.payload.prev === 'genesis' ? t('verify.genesis') : receipt.payload.prev.slice(0, 16) + '…'}</dd>
                </dl>
                <div className="toolbar">
                  <button onClick={copyReceipt}>{copied ? t('receipt.copied') : t('receipt.copy')}</button>
                  <a href={`/verify#r=${receiptToFragment(receipt)}`} target="_blank" rel="noreferrer">
                    <button className="primary">{t('receipt.openVerify')}</button>
                  </a>
                </div>
                <p className="hint">{t('receipt.incognitoHint')}</p>
              </div>
            )}
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <h2>{t('review.sentPayload')}</h2>
            <div className="evidence">
              {approved.map((e) => (
                <div className="ev" key={e.id}>
                  <div>
                    <div className="label">{t(e.labelKey)}</div>
                    <div className="meta">{e.cloudChars} chars · {e.removed.length ? e.removed.map((r) => `${t(`pii.${r.kind}`)} ×${r.count}`).join(' · ') : '—'}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>{t('review.title')}</h2>
          <p className="hint" style={{ marginTop: 0 }}>{t('review.subtitle')}</p>

          {running && <p className="hint" style={{ color: 'var(--blue)' }}>{t('review.running')} {t('review.verifying')}</p>}

          {result?.cloudError && (
            <div className="verdict bad">{t('review.cloudError')}: {result.cloudError}</div>
          )}

          {result && !result.cloudError && (
            <>
              <p className="hint">{t('review.summary', { okDevice, okRules, bad })}</p>
              {result.conclusions.map((c) => (
                <div className={`concl ${c.verdict}`} key={c.id}>
                  <div className="ctext">
                    {c.test && <span className="badge muted" style={{ marginRight: 8 }}>{t('review.testBadge')}</span>}
                    {c.text}
                  </div>
                  <div className="hint" style={{ margin: '0 0 4px' }}>
                    {t('review.citation')}: §{c.citation.section} · p.{c.citation.page}
                  </div>
                  <div className="quote">“{c.citation.quote}”</div>
                  <div className="meta">
                    {c.verdict === 'pass' ? `✓ ${t('review.pass')}` : `✕ ${t('review.fail')}`} · {c.checkedBy === 'nano' ? t('review.onDevice') : t('review.rulesOnly')} · {t('review.reason')}: {c.reason}
                  </div>
                  <div className="meta" style={{ color: c.verdict === 'pass' ? 'var(--green)' : 'var(--red)' }}>
                    {c.verdict === 'pass'
                      ? t('review.inReport')
                      : c.test
                        ? t('review.testNotSent')
                        : t('review.returned')}
                  </div>
                  {c.verdict === 'fail' && (
                    <div className="toolbar" style={{ marginTop: 8 }}>
                      <button className="mini" onClick={() => recheck(c.id)} disabled={checking === c.id}>
                        {checking === c.id ? t('common.loading') : t('review.recheck')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              <div className="toolbar">
                <button onClick={() => manifest && send(manifest)} disabled={running}>{t('review.retry')}</button>
              </div>
            </>
          )}

          <div className="panel" style={{ marginTop: 12, background: '#0e151c' }}>
            <h2>{t('review.testTitle')}</h2>
            <p className="hint" style={{ marginTop: 0 }}>{t('review.testBody')}</p>
            <div className="toolbar" style={{ marginTop: 0 }}>
              <button className="mini" onClick={runTestCitation} disabled={testing || !manifest}>
                {testing ? t('common.loading') : t('review.testButton')}
              </button>
            </div>
          </div>

          {report && (
            <div className="panel" style={{ marginTop: 12, background: '#0e151c' }}>
              <h2>{t('review.reportTitle')}</h2>
              <p className="hint" style={{ marginTop: 0 }}>
                {t('review.reportMeta', { ok: report.accepted.length, bad: report.returned.length })}
                {testRan ? ` ${t('review.testExcluded')}` : ''}
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {(report.accepted as Array<{ id: string; text: string; section: string; page: number }>).map((c) => (
                  <li key={c.id} style={{ marginBottom: 6 }}>
                    {c.text} <span className="mono" style={{ color: 'var(--dim)' }}>§{c.section} p.{c.page}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!result && !running && <p className="hint"><Link href="/capture">{t('common.back')}</Link></p>}
        </section>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="shell"><p className="hint">Loading…</p></div>}>
      <ReviewPage />
    </Suspense>
  );
}
