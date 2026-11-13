'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { db, newId, type CaseRecord, type EvidenceRecord } from '@/lib/db';
import { resolveCaptureLLM, mockLLM } from '@/lib/hybrid-llm';
import { StatusBar } from '@/components/StatusBar';
import { TopBar } from '@/components/TopBar';
import { useI18n } from '@/lib/i18n';

/** Synthetic, English, deliberately full of identifiers the egress gate must catch. */
const SEED_NOTE = `On 2026-11-13 at 09:20 a vehicle was flooded in the underground car park B2 of Riverside Garden, 18 Harbor Road. The water line was about 40 cm and the driver footwell was flooded. The insured, Daniel Reyes, ID 310101199003074512, phone 13800138000, reports a left ankle fracture and was taken to Mercy General Hospital. Policy P-8823-1170. Bank statement on file.`;

export default function CapturePage() {
  const router = useRouter();
  const { t } = useI18n();
  const [kase, setKase] = useState<CaseRecord | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestDraft, setLatestDraft] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        let c = await db.cases.orderBy('updatedAt').last();
        if (!c) {
          c = {
            id: newId('case'),
            caseNo: 'SN-2411-0087',
            title: 'Flooded underground car park · single vehicle',
            site: 'Riverside Garden, 18 Harbor Road, car park B2',
            status: 'capture',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await db.cases.add(c);
        }
        setKase(c);
        setEvidence(await db.evidence.where('caseId').equals(c.id).sortBy('createdAt'));
        const drafts = await db.drafts.where('caseId').equals(c.id).sortBy('createdAt');
        setLatestDraft(drafts.at(-1)?.id ?? null);
      } catch (e) {
        setError(`${t('capture.dbError')}: ${(e as Error).message}`);
      }
    })();
  }, [t]);

  async function refresh(caseId: string) {
    setEvidence(await db.evidence.where('caseId').equals(caseId).sortBy('createdAt'));
  }

  async function addNote() {
    if (!kase || !note.trim()) return;
    await db.evidence.add({
      id: newId('ev'),
      caseId: kase.id,
      kind: 'note',
      label: note.trim().slice(0, 28) + (note.length > 28 ? '…' : ''),
      text: note.trim(),
      bytes: new Blob([note]).size,
      createdAt: Date.now(),
      piiFlags: [],
    });
    setNote('');
    await refresh(kase.id);
  }

  async function addPhoto(file: File) {
    if (!kase) return;
    await db.evidence.add({
      id: newId('ev'),
      caseId: kase.id,
      kind: 'photo',
      label: file.name,
      blob: file,
      bytes: file.size,
      createdAt: Date.now(),
      piiFlags: [],
    });
    await refresh(kase.id);
  }

  async function seedAndExtract() {
    if (!kase) return;
    setBusy(true);
    setError(null);
    try {
      const all = await db.evidence.where('caseId').equals(kase.id).toArray();
      if (all.filter((e) => e.kind === 'note' && e.text).length === 0) {
        await db.evidence.add({
          id: newId('ev'),
          caseId: kase.id,
          kind: 'note',
          label: 'Field note',
          text: SEED_NOTE,
          bytes: new Blob([SEED_NOTE]).size,
          createdAt: Date.now(),
          piiFlags: [],
        });
      }
      const fresh = await db.evidence.where('caseId').equals(kase.id).toArray();
      const notes = fresh.filter((e) => e.kind === 'note' && e.text).map((e) => e.text!);

      const preferred = await resolveCaptureLLM();
      let result;
      try {
        result = await preferred.extract({ caseNo: kase.caseNo, site: kase.site, notes });
      } catch (e) {
        const err = e as Error & { code?: string };
        setError(`${t('status.degraded')} (${err.code ?? err.name})`);
        result = await mockLLM.extract({ caseNo: kase.caseNo, site: kase.site, notes });
      }

      const draft = {
        id: newId('draft'),
        caseId: kase.id,
        fields: result.fields,
        source: result.source,
        latencyMs: result.latencyMs,
        createdAt: Date.now(),
        egressEstimate: notes.join('\n').length,
      };
      await db.drafts.add(draft);
      await db.cases.update(kase.id, { status: 'draft', updatedAt: Date.now() });
      router.push(`/draft?id=${draft.id}`);
    } catch (e) {
      const err = e as Error & { code?: string };
      setError(`${err.name}${err.code ? ` / ${err.code}` : ''}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <TopBar />
      <StatusBar />

      <div className="grid">
        <section className="panel">
          <h2>{t('capture.title')}</h2>
          {kase ? (
            <dl className="kv">
              <dt>{t('capture.caseNo')}</dt><dd>{kase.caseNo}</dd>
              <dt>{t('capture.type')}</dt><dd>{kase.title}</dd>
              <dt>{t('capture.site')}</dt><dd>{kase.site}</dd>
              <dt>{t('capture.status')}</dt><dd>{kase.status}</dd>
            </dl>
          ) : <p className="hint">{t('common.loading')}</p>}

          <h2 style={{ marginTop: 20 }}>{t('capture.evidence')} · {evidence.length}</h2>
          <div className="evidence">
            {evidence.length === 0 && <p className="hint">{t('capture.empty')}</p>}
            {evidence.map((e) => (
              <div className="ev" key={e.id}>
                <div>
                  <div className="kind">{e.kind}</div>
                  <div className="label">{e.kind === 'note' ? e.text?.slice(0, 70) : e.label}</div>
                </div>
                <div className="meta">{(e.bytes / 1024).toFixed(1)} KB</div>
              </div>
            ))}
          </div>

          <h2 style={{ marginTop: 20 }}>{t('capture.addNote')}</h2>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('capture.notePlaceholder')} />
          <div className="toolbar">
            <button onClick={addNote} disabled={!note.trim()}>{t('capture.saveLocal')}</button>
            <button onClick={() => fileRef.current?.click()}>{t('capture.addPhoto')}</button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void addPhoto(f); e.target.value = ''; }}
            />
          </div>
          <p className="hint">{t('capture.localHint')}</p>
        </section>

        <section className="panel">
          <h2>{t('capture.draftTitle')}</h2>
          <p className="hint" style={{ marginTop: 0 }}>{t('capture.draftHint')}</p>
          <div className="toolbar">
            <button className="primary" onClick={seedAndExtract} disabled={busy || !kase}>
              {busy ? t('capture.generating') : t('capture.generate')}
            </button>
            {latestDraft && !busy && (
              <Link href={`/draft?id=${latestDraft}`}><button>{t('capture.openLatest')}</button></Link>
            )}
          </div>
          {error && <p className="hint" style={{ color: 'var(--red)' }}>{error}</p>}
          <p className="hint">{t('capture.afterDraft')}</p>
        </section>
      </div>
    </div>
  );
}

