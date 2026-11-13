'use client';

import { useEffect, useState } from 'react';
import { nanoLLM } from '@/lib/hybrid-llm';
import { useI18n } from '@/lib/i18n';

type Mode = 'hybrid' | 'airgap' | 'degraded' | 'readonly';

export function StatusBar() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('airgap');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const compute = async () => {
      const nano = await nanoLLM.probe();
      if (!alive) return;
      const online = navigator.onLine;
      setMode(nano ? (online ? 'hybrid' : 'airgap') : online ? 'degraded' : 'readonly');
      setReady(true);
    };
    void compute();
    window.addEventListener('online', compute);
    window.addEventListener('offline', compute);
    return () => {
      alive = false;
      window.removeEventListener('online', compute);
      window.removeEventListener('offline', compute);
    };
  }, []);

  return (
    <div className={`statusbar ${mode}`} role="status">
      <span className="dot" />
      <div>
        <div className="name">{ready ? t(`status.${mode}`) : t('status.checking')}</div>
        <div className="detail">{ready ? t(`status.${mode}.detail`) : t('status.checkingDetail')}</div>
      </div>
    </div>
  );
}
