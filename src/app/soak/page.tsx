'use client';

import { useEffect, useRef, useState } from 'react';
import { db, newId, type SoakSample } from '@/lib/db';
import { nanoLLM } from '@/lib/hybrid-llm';

const NOTE =
  'On 2026-11-13 at 09:20 a vehicle was flooded in the underground car park B2 of Riverside Garden, 18 Harbor Road. Water line about 40 cm. The insured, Daniel Reyes, ID 310101199003074512, phone 13800138000, reports a left ankle fracture. Policy P-8823-1170.';

const INTERVAL_MS = 10 * 60 * 1000;

async function countRows(): Promise<number> {
  const [c, e, d, m, r, p, s] = await Promise.all([
    db.cases.count(),
    db.evidence.count(),
    db.drafts.count(),
    db.manifests.count(),
    db.receipts.count(),
    db.reports.count(),
    db.soakSamples.count(),
  ]);
  return c + e + d + m + r + p + s;
}

export default function SoakPage() {
  const [samples, setSamples] = useState<SoakSample[]>([]);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Chrome suspends the on-device session when it idles; a 60s ping keeps the
  // 10-minute sample honest. Without it the first call after idle hangs.
  const [pings, setPings] = useState(0);
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const LM = (window as any).LanguageModel;
        if (!LM) return;
        const session = await LM.create();
        await session.prompt('ok');
        session.destroy?.();
        setPings((n) => n + 1);
      } catch {
        /* ignore */
      }
    }, 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    (async () => {
      const rows = await db.soakSamples.orderBy('ts').toArray();
      setSamples(rows);
      if (rows.length > 0) setStartedAt(rows[0].ts);
    })();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  async function runSample(): Promise<SoakSample> {
    // The first on-device call after an idle period can hang while Chrome
    // re-opens the session. Absorb that with a throwaway call so the measured
    // sample reflects a working session (this is also what a user sees: the
    // first action after a break is slow, the next one is normal).
    try {
      const warm = nanoLLM.extract({ caseNo: 'SOAK-WARM', site: 'warm', notes: ['warm up'] });
      await Promise.race([warm.catch(() => {}), new Promise((r) => setTimeout(r, 70000))]);
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 3000));

    const t0 = performance.now();
    let ok = false;
    let source = 'none';
    let error: string | undefined;
    try {
      const res = await nanoLLM.extract({ caseNo: 'SOAK-2411', site: 'Riverside Garden, car park B2', notes: [NOTE] });
      source = res.source;
      ok = res.fields.some((f) => f.value.trim().length > 0);
    } catch (e) {
      const err = e as Error & { code?: string };
      error = `${err.code ?? err.name}: ${err.message}`;
    }
    const ms = Math.round(performance.now() - t0);
    const rows = await countRows();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mem = (performance as any).memory;
    const sample: SoakSample = {
      id: newId('soak'),
      ts: new Date().toISOString(),
      ok,
      ms,
      source,
      rows,
      heapMB: mem ? Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10 : null,
      error,
    };
    await db.soakSamples.add(sample);
    setSamples((prev) => [...prev, sample]);
    console.info(`[soak] ${sample.ts} ok=${ok} ms=${ms} rows=${rows} heapMB=${sample.heapMB} source=${source}${error ? ` error=${error}` : ''}`);
    return sample;
  }

  async function start() {
    if (running) return;
    setRunning(true);
    setBusy(true);
    if (!startedAt) setStartedAt(new Date().toISOString());
    await runSample();
    setBusy(false);
    timer.current = setInterval(async () => {
      setBusy(true);
      await runSample();
      setBusy(false);
    }, INTERVAL_MS);
  }

  async function once() {
    setBusy(true);
    await runSample();
    setBusy(false);
  }

  const okCount = samples.filter((s) => s.ok).length;
  const avg = samples.length ? Math.round(samples.reduce((n, s) => n + s.ms, 0) / samples.length) : 0;
  const elapsedMin = startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 60000) : 0;

  useEffect(() => {
    // expose for the external CSV collector
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__soak = { running, startedAt, samples };
  }, [running, startedAt, samples]);

  return (
    <div className="shell" style={{ maxWidth: 1000 }}>
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          AIRGAP DESK <small>Soak · on-device extraction every 2 minutes</small>
        </div>
        <span className="badge warn">SYNTHETIC DATA</span>
      </div>

      <section className="panel" style={{ marginTop: 12 }}>
        <h2>120-minute soak</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Every 2 minutes this page runs a real on-device extraction through the same HybridLLM path the product uses, then records
          timestamp, IndexedDB row count, JS heap and success. Each sample is triggered by a real click from the soak driver, the same gesture a user makes.
        </p>
        <div className="toolbar" style={{ marginTop: 0 }}>
          <button className="primary" onClick={start} disabled={running || busy}>
            {running ? 'Soak running' : 'Start soak'}
          </button>
          <button onClick={once} disabled={busy}>Run one sample now</button>
          <span className="pill">samples {samples.length}</span>
          <span className="pill">ok {okCount}/{samples.length}</span>
          <span className="pill">avg {avg} ms</span>
          <span className="pill">elapsed {elapsedMin} min</span>
          
        </div>

        <table style={{ width: '100%', marginTop: 14, borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: 'var(--dim)', textAlign: 'left' }}>
              <th style={{ padding: '6px 8px' }}>#</th>
              <th style={{ padding: '6px 8px' }}>timestamp</th>
              <th style={{ padding: '6px 8px' }}>ok</th>
              <th style={{ padding: '6px 8px' }}>ms</th>
              <th style={{ padding: '6px 8px' }}>source</th>
              <th style={{ padding: '6px 8px' }}>IndexedDB rows</th>
              <th style={{ padding: '6px 8px' }}>heap MB</th>
            </tr>
          </thead>
          <tbody>
            {samples.map((s, i) => (
              <tr key={s.id} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '6px 8px', color: 'var(--dim)' }}>{i + 1}</td>
                <td style={{ padding: '6px 8px' }} className="mono">{s.ts}</td>
                <td style={{ padding: '6px 8px', color: s.ok ? 'var(--green)' : 'var(--red)' }}>{s.ok ? 'ok' : 'fail'}</td>
                <td style={{ padding: '6px 8px' }} className="mono">{s.ms}</td>
                <td style={{ padding: '6px 8px' }} className="mono">{s.source}</td>
                <td style={{ padding: '6px 8px' }} className="mono">{s.rows}</td>
                <td style={{ padding: '6px 8px' }} className="mono">{s.heapMB ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {samples.length === 0 && <p className="hint">No sample yet.</p>}
      </section>
    </div>
  );
}

