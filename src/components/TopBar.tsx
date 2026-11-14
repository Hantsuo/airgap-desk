'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';

export function TopBar({ tagKey = 'app.tag', badge }: { tagKey?: string; badge?: string }) {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="topbar">
      <Link href="/capture" className="brand" style={{ color: 'inherit' }}>
        <span className="dot" />
        {t('app.name')} <small>{t(tagKey)}</small>
      </Link>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="badge local">{badge ?? t('app.localOnly')}</span>
        <span className="badge warn">{t('app.synthetic')}</span>
        <button className="lang" onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}>
          {t('common.lang')}
        </button>
      </div>
    </div>
  );
}
