'use client';

import { useEffect, useState } from 'react';
import { verifyReceipt, fragmentToReceipt, type VerifyResult } from '@/lib/receipt';
import { useI18n } from '@/lib/i18n';

export default function VerifyPage() {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    const m = /[#&]r=([^&]+)/.exec(hash);
    if (m) {
      try {
        const json = fragmentToReceipt(m[1]);
        setText(JSON.stringify(JSON.parse(json), null, 2));
      } catch {
        /* ignore malformed fragment */
      }
    }
  }, []);

  useEffect(() => {
    if (!text.trim()) { setResult(null); return; }
    let alive = true;
    const id = setTimeout(async () => {
      setBusy(true);
      const r = await verifyReceipt(text);
      if (alive) { setResult(r); setBusy(false); }
    }, 250);
    return () => { alive = false; clearTimeout(id); };
  }, [text]);

  const ok = result?.ok === true;

  return (
    <div className="shell" style={{ maxWidth: 900 }}>
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          {t('app.name')} <small>{t('verify.title')}</small>
        </div>
        <span className="badge">{t('app.synthetic')}</span>
      </div>

      <section className="panel" style={{ marginTop: 12 }}>
        <h2>{t('verify.title')}</h2>
        <p className="hint" style={{ marginTop: 0 }}>{t('verify.subtitle')}</p>
        <p className="hint">{t('verify.tamperHint')}</p>

        <textarea
          className="verifybox"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('verify.placeholder')}
          spellCheck={false}
        />

        {busy && <p className="hint">{t('common.loading')}</p>}

        {result && !result.parsed && (
          <div className="verdict bad">{t('verify.parsing')}{result.error ? ` · ${result.error}` : ''}</div>
        )}

        {result?.parsed && (
          <>
            <div className={`verdict ${ok ? 'ok' : 'bad'}`}>
              <span>{ok ? '✓' : '✕'}</span>
              <span>{ok ? t('verify.valid') : t('verify.invalid')}</span>
            </div>
            <div className="checkline">
              <div>{result.hashOk ? '✓' : '✕'} {result.hashOk ? t('verify.hashOk') : t('verify.hashBad')}</div>
              <div>{result.sigOk ? '✓' : '✕'} {result.sigOk ? t('verify.sigOk') : t('verify.sigBad')}</div>
            </div>

            {result.receipt && (
              <dl className="kv" style={{ marginTop: 14 }}>
                <dt>{t('receipt.shortCode')}</dt><dd className="mono">{result.receipt.short}</dd>
                <dt>{t('verify.case')}</dt><dd>{result.receipt.payload.caseNo}</dd>
                <dt>{t('verify.time')}</dt><dd className="mono">{result.receipt.payload.signedAt}</dd>
                <dt>{t('receipt.chain')}</dt><dd className="mono">{result.receipt.payload.prev === 'genesis' ? t('verify.genesis') : result.receipt.payload.prev.slice(0, 20) + '…'}</dd>
                <dt>{t('verify.items')}</dt>
                <dd>
                  {result.receipt.payload.items.map((i) => `${i.field} (${i.chars})`).join(' · ')}
                </dd>
                <dt>{t('receipt.key')}</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{result.receipt.pub.slice(0, 44)}…</dd>
              </dl>
            )}
          </>
        )}

        {!text && <p className="hint">{t('verify.openFromReceipt')}</p>}
      </section>
    </div>
  );
}
