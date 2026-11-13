'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { db, newId, type DraftRecord, type CaseRecord, type ManifestRecord } from '@/lib/db';
import { buildManifest, buildCloudPayload, type EgressEntry, type EgressManifest } from '@/lib/egress';
import { warmDeviceModel } from '@/lib/hybrid-llm';
import { createReceipt, sha256Hex } from '@/lib/receipt';
import { StatusBar } from '@/components/StatusBar';
import { TopBar } from '@/components/TopBar';
import { useI18n } from '@/lib/i18n';

function EgressPage() {
  const search = useSearchParams();
  const draftId = search.get('draft') ?? '';
  const router = useRouter();
  const { t } = useI18n();

  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [kase, setKase] = useState<CaseRecord | null>(null);
  const [manifest, setManifest] = useState<EgressManifest | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const d = await db.drafts.get(draftId);
        if (!d) { setBuildError('Draft not found'); return; }
        setDraft(d);
        const c = (await db.cases.get(d.caseId)) ?? null;
        setKase(c);
        // Prefer the manifest built on the draft page (it had a real user gesture,
        // so the on-device classifier could run). Fall back to building here.
        const stored = await db.manifests.where('draftId').equals(d.id).sortBy('createdAt');
        const fresh = stored.at(-1);
        if (fresh && Date.now() - fresh.createdAt < 10 * 60 * 1000) {
          setManifest(fresh);
          return;
        }
        const evidence = await db.evidence.where('caseId').equals(d.caseId).toArray();
        const notes = evidence.filter((e) => e.kind === 'note' && e.text).map((e) => e.text!);
        const m = await buildManifest({
          caseId: d.caseId,
          draftId: d.id,
          caseNo: c?.caseNo ?? 'SN-2411-0087',
          site: c?.site ?? '',
          draftFields: d.fields,
          notes,
        });
        setManifest(m);
        console.info(
          `[egress] manifest entries=${m.entries.length} send=${m.entries.filter((e) => e.decision === 'send' && e.cloudText.trim()).length} bytes=${m.cloudBytes} classifier=${m.classifier}`,
        );
      } catch (e) {
        setBuildError((e as Error).message);
      }
    })();
  }, [draftId]);

  // A `send` decision with no text is not an item that leaves: keep the count,
  // the button, the manifest and the payload on the same definition.
  const sendEntries = useMemo(
    () => manifest?.entries.filter((e) => e.decision === 'send' && e.cloudText.trim()) ?? [],
    [manifest],
  );
  const stayEntries = useMemo(
    () => manifest?.entries.filter((e) => !(e.decision === 'send' && e.cloudText.trim())) ?? [],
    [manifest],
  );
  const sendChars = sendEntries.reduce((n, e) => n + e.cloudChars, 0);
  // UTF-8 bytes of the exact JSON payload — never the character count.
  const payloadBytes = useMemo(
    () => (manifest ? new TextEncoder().encode(JSON.stringify(buildCloudPayload(manifest))).length : 0),
    [manifest],
  );

  /**
   * Blocking never destroys the redacted text: `decision` is the only switch.
   * Otherwise "Allow again" would resurrect an empty cloudText and send nothing.
   */
  function block(id: string, blockIt: boolean) {
    setManifest((m) => {
      if (!m) return m;
      return {
        ...m,
        entries: m.entries.map((e) =>
          e.id === id
            ? { ...e, decision: blockIt ? 'stay' : 'send', cloudChars: blockIt ? 0 : e.cloudText.length }
            : e,
        ),
      };
    });
    setNotice(null);
  }

  async function approveAndSend() {
    if (!manifest || !draft || !kase) return;
    const approved = manifest.entries.filter((e) => e.decision === 'send' && e.cloudText);
    if (approved.length === 0) {
      setNotice(t('egress.noneSelected'));
      return;
    }
    setBusy(true);
    try {
      // Same user gesture as the click: prime the on-device model so the first
      // citation check on the next screen does not fall back to rules-only.
      const warm = warmDeviceModel();
      const payload = buildCloudPayload(manifest);
      const payloadText = JSON.stringify(payload);

      const items = await Promise.all(
        approved.map(async (e) => ({ field: e.key, chars: e.cloudChars, sha256: await sha256Hex(e.cloudText) })),
      );

      const { receipt, id } = await createReceipt({
        caseId: draft.caseId,
        caseNo: kase.caseNo,
        manifestId: manifest.id,
        destination: manifest.destination,
        items,
        cloudPayload: payloadText,
      });

      const record: ManifestRecord = { ...manifest, approvedIds: approved.map((e) => e.id) };
      await db.manifests.put(record);
      await db.cases.update(kase.id, { status: 'review', updatedAt: Date.now() });

      console.info(
        `[egress] approved=${approved.length} of ${manifest.entries.length} chars=${sendChars} payload_bytes=${new TextEncoder().encode(payloadText).length} classifier=${manifest.classifier}`,
      );
      console.info(
        `[receipt] short=${receipt.short} seq=${receipt.payload.seq} alg=${receipt.alg} destination="${receipt.payload.destination}" hash=${receipt.hash.slice(0, 16)} prev=${receipt.payload.prev.slice(0, 16)}`,
      );

      void warm.catch(() => {});
      router.push(`/review?id=${id}`);
    } catch (e) {
      setBuildError((e as Error).message);
      setBusy(false);
    }
  }

  function keepEverything() {
    if (!manifest) return;
    setManifest({ ...manifest, entries: manifest.entries.map((e) => ({ ...e, decision: 'stay' as const, cloudChars: 0 })) });
    setNotice(t('egress.blockedAll'));
  }

  const removedLabel = (e: EgressEntry) =>
    e.removed.length ? e.removed.map((r) => `${t(`pii.${r.kind}`)} ×${r.count}`).join(' · ') : '—';

  return (
    <div className="shell">
      <TopBar tagKey="app.tagDraft" />
      <StatusBar />

      <section className="panel" style={{ marginTop: 12 }}>
        <h2>{t('egress.title')}</h2>
        <p className="why">
          {manifest
            ? t('egress.whyN', { n: sendEntries.length })
            : t('egress.why').replace('N', '…')}
        </p>
        <p className="hint" style={{ marginTop: 6 }}>{t('egress.subtitle')}</p>
        <div className="destline">
          <span className="badge cloud">{t('egress.destination')}: {t('egress.destValue')}</span>
          {manifest && <span className="badge">{t('egress.classifiedBy', { src: manifest.classifier === 'nano' ? t('egress.srcNano') : t('egress.srcRules') })}</span>}
          {manifest && <span className="badge">{t('egress.summary', { out: sendEntries.length, total: manifest.entries.length, chars: sendChars, bytes: payloadBytes })}</span>}
        </div>
        {!manifest && !buildError && <p className="hint">{t('common.loading')}</p>}
        {buildError && <p className="hint" style={{ color: 'var(--red)' }}>{buildError}</p>}
      </section>

      {manifest && (
        <div className="grid" style={{ gridTemplateColumns: '1fr 1.25fr' }}>
          <section className="panel">
            <h2>{t('egress.stays', { n: stayEntries.length })}</h2>
            <div className="evidence">
              {stayEntries.map((e) => (
                <div className="ev stay" key={e.id}>
                  <div>
                    <div className="label">{t(e.labelKey)}</div>
                    <div className="meta">{e.cloudText.trim() ? t('egress.notSentZero') : t('egress.nothingToSend')}</div>
                  </div>
                  {e.cloudText.trim() && (
                    <button className="mini" onClick={() => block(e.id, false)}>{t('egress.unblock')}</button>
                  )}
                </div>
              ))}
            </div>
            <p className="hint">{t('egress.footer')}</p>
          </section>

          <section className="panel">
            <h2>{t('egress.sends', { n: sendEntries.length })}</h2>
            <div className="evidence">
              {sendEntries.map((e) => (
                <div className="ev send" key={e.id}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="label">{t(e.labelKey)}</div>
                    <div className="meta">
                      {t('egress.chars', { a: e.originalChars, b: e.cloudChars })} · {t('egress.whyTag')}: {t(e.whyKey)}
                    </div>
                    {e.removed.length > 0 && (
                      <div className="meta" style={{ marginTop: 4 }}>
                        <strong>{t('egress.removed')}:</strong> {removedLabel(e)}
                      </div>
                    )}
                    <pre className="payload">{e.cloudText}</pre>
                  </div>
                  <button className="mini" onClick={() => block(e.id, true)}>{t('egress.block')}</button>
                </div>
              ))}
              {sendEntries.length === 0 && <p className="hint">{t('egress.noneSelected')}</p>}
            </div>
          </section>
        </div>
      )}

      {manifest && (
        <div className="footer-actions">
          <button className="big secondary" onClick={keepEverything}>{t('egress.keepAll')}</button>
          <button className="big primary" onClick={approveAndSend} disabled={busy || sendEntries.length === 0}>
            {busy ? t('common.loading') : t('egress.approve', { n: sendEntries.length })}
          </button>
        </div>
      )}
      {notice && <p className="notice">{notice}</p>}
      {draft && <p className="hint"><Link href={`/draft?id=${draft.id}`}>{t('common.back')}</Link></p>}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="shell"><p className="hint">Loading…</p></div>}>
      <EgressPage />
    </Suspense>
  );
}
