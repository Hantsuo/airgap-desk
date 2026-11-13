'use client';

import { useEffect, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { db, type DraftField, type DraftRecord, type CaseRecord } from '@/lib/db';
import { buildManifest } from '@/lib/egress';
import { StatusBar } from '@/components/StatusBar';
import { TopBar } from '@/components/TopBar';
import { useI18n } from '@/lib/i18n';

const SOURCE_KEY: Record<DraftRecord['source'], string> = {
  nano: 'draft.basisModel',
  cloud: 'draft.basisCloud',
  mock: 'draft.basisRules',
};

const FIELD_LABEL: Record<string, string> = {
  incidentTime: 'Incident time',
  location: 'Location',
  waterDepthCm: 'Water depth (cm)',
  injury: 'Injury',
  policyNo: 'Policy no.',
  cause: 'Probable cause',
};

function DraftPage() {
  const search = useSearchParams();
  const draftId = search.get('id') ?? '';
  const router = useRouter();
  const { t } = useI18n();
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [kase, setKase] = useState<CaseRecord | null>(null);
  const [fields, setFields] = useState<DraftField[]>([]);
  const [saved, setSaved] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const d = await db.drafts.get(draftId);
      if (!d) return;
      setDraft(d);
      setFields(d.fields);
      setKase((await db.cases.get(d.caseId)) ?? null);
    })();
  }, [draftId]);

  function update(key: string, value: string) {
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, value } : f)));
    setSaved(false);
  }

  async function save() {
    if (!draft) return;
    await db.drafts.update(draft.id, { fields });
    setSaved(true);
  }

  async function openEgress() {
    if (!draft || !kase) return;
    setBuilding(true);
    setSaved(false);
    try {
      const evidence = await db.evidence.where('caseId').equals(draft.caseId).toArray();
      const notes = evidence.filter((e) => e.kind === 'note' && e.text).map((e) => e.text!);
      // Built here, on a real user gesture, so the on-device classifier can run.
      const m = await buildManifest({
        caseId: draft.caseId,
        draftId: draft.id,
        caseNo: kase.caseNo,
        site: kase.site,
        draftFields: fields,
        notes,
      });
      await db.manifests.put({ ...m, approvedIds: [] });
      router.push(`/egress?draft=${draft.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="shell">
      <TopBar tagKey="app.tagDraft" />
      <StatusBar />

      <div className="grid">
        <section className="panel">
          <h2>{t('draft.title')}</h2>
          {!draft && <p className="hint">{t('common.loading')}</p>}
          {draft && (
            <>
              <p className="hint" style={{ marginTop: 0 }}>
                {kase?.caseNo} · {t('draft.meta', { source: t(SOURCE_KEY[draft.source]), ms: draft.latencyMs })}
              </p>
              {fields.map((f) => (
                <div className="field" key={f.key}>
                  <span className="flabel">{FIELD_LABEL[f.key] ?? f.label}</span>
                  <input value={f.value} onChange={(e) => update(f.key, e.target.value)} />
                  <span className="fbasis">{f.value ? t(SOURCE_KEY[f.basis as DraftRecord['source']] ?? 'draft.basisRules') : '—'}</span>
                </div>
              ))}
              <p className="hint">{t('draft.editHint')}</p>
              {error && <p className="hint" style={{ color: 'var(--red)' }}>{error}</p>}
              <div className="toolbar">
                <button onClick={save}>{t('draft.save')}</button>
                <button className="primary" onClick={openEgress} disabled={building}>
                  {building ? t('egress.building') : t('draft.egress')}
                </button>
                <Link href="/capture"><button>{t('draft.back')}</button></Link>
                {saved && <span className="pill">{t('draft.saved')}</span>}
              </div>
            </>
          )}
          {!draft && <p className="hint">{t('draft.notFound')}</p>}
        </section>

        <section className="panel">
          <h2>{t('review.sentPayload')}</h2>
          <p className="hint" style={{ marginTop: 0 }}>{t('draft.editHint')}</p>
          <dl className="kv">
            <dt>Bytes out</dt><dd>0</dd>
            <dt>Next step</dt><dd>Egress manifest</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="shell"><p className="hint">Loading…</p></div>}>
      <DraftPage />
    </Suspense>
  );
}
