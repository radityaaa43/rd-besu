import { useEffect, useState } from 'react';
import { getHealth, getMeta, type Health, type Meta } from './api.ts';
import { DemoView } from './demo/DemoView.tsx';
import { StressView } from './stress/StressView.tsx';

const DOWN = '#C24A4A';
const dot = (up: boolean | undefined) =>
  up === undefined ? { background: 'var(--faint)', animation: 'none' } : up ? undefined : { background: DOWN, animation: 'none' };

const status = (name: string, up: boolean | undefined) =>
  `${name}: ${up === undefined ? 'memeriksa' : up ? 'terhubung' : 'tidak terjangkau'}`;

function useHealth(): Health | null | undefined {
  // undefined = not asked yet, null = server unreachable
  const [h, setH] = useState<Health | null | undefined>();
  useEffect(() => {
    let alive = true, inFlight = false;
    const poll = async () => {
      if (inFlight) return; // an older reply must never overwrite a newer one
      inFlight = true;
      const r = await getHealth();
      inFlight = false;
      if (alive) setH(r.ok ? r.body : null);
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return h;
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<'demo' | 'tps'>('demo');
  const health = useHealth();
  const load = () => getMeta().then((r) => (r.ok ? (setErr(null), setMeta(r.body)) : setErr(r.reason)));
  useEffect(() => { load(); }, []);

  const besu = health === undefined ? undefined : health?.nodes.besu === true;
  const paladin = health === undefined ? undefined : health !== null && health.nodes.paladin.length === 4 && health.nodes.paladin.every(Boolean);
  return (
    <>
      <header>
        <div className="brand">
          <svg className="i" style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          Lensa Privasi
        </div>
        <nav>
          <button aria-current={view === 'demo' ? 'page' : undefined} onClick={() => setView('demo')}>Demo transaksi</button>
          <button aria-current={view === 'tps' ? 'page' : undefined} onClick={() => setView('tps')}>Stress test TPS</button>
        </nav>
        <div className="net">
          <span title={status('Besu', besu)} aria-label={status('Besu', besu)}><i className="pulse" aria-hidden="true" style={dot(besu)} />Besu · 4 validator</span>
          <span title={status('Paladin', paladin)} aria-label={status('Paladin', paladin)}><i className="pulse" aria-hidden="true" style={dot(paladin)} />Paladin · 4 node (BI + 3 bank)</span>
        </div>
      </header>
      {meta ? (
        <>
          <DemoView meta={meta} hidden={view !== 'demo'} />
          <StressView meta={meta} hidden={view !== 'tps'} />
        </>
      ) : (
        <div className="empty">
          <h3>{err ? 'Tidak dapat memuat data' : 'Memuat…'}</h3>
          {err && <><p>{err}</p><button className="ghost" onClick={load}>Coba lagi</button></>}
        </div>
      )}
    </>
  );
}
