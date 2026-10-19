import type { ModelId } from '../../../server/src/domain.ts';
import type { ModelRunStatus, StressSnapshot } from '../../../server/src/stress.ts';
import type { Meta } from '../api.ts';
import { formatDecimal } from '../format.ts';

export const COLOR: Record<ModelId, string> = { zeto: '#0E2A52', noto: '#2F80ED', stealth: '#8A6BD1' };
const LABEL: Record<ModelRunStatus, string> = {
  waiting: 'Menunggu giliran', running: 'Berjalan', done: 'Selesai', stopped: 'Dihentikan', timeout: 'Batas waktu habis', skipped: 'Dilewati',
};
const num = (n: number) => n.toLocaleString('id-ID');

function Spark({ series, color }: { series: number[]; color: string }) {
  if (series.length < 2) return <svg className="spark" />;
  const mx = Math.max(...series) * 1.15 || 1, w = 300, h = 46;
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * w},${h - (v / mx) * h}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="Grafik TPS per detik">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function RunRows({ meta, snap }: { meta: Meta; snap: StressSnapshot }) {
  const { count } = snap.config;
  return (
    <>
      {snap.config.models.map((m) => {
        const r = snap.models[m]!;
        const { ok, failed, avgTps, p50Ms, series } = r.summary;
        const pct = Math.min(100, ((ok + failed) / count) * 100);
        return (
          <div key={m} className={`runrow ${r.status === 'running' ? 'run' : r.status}`}>
            <div>
              <h5><i className="swatch" style={{ background: COLOR[m], margin: 0 }} />{meta.models[m].name}</h5>
              <div className="state">{LABEL[r.status]}</div>
            </div>
            <div>
              <Spark series={series} color={COLOR[m]} />
              <div className="bar"><i style={{ width: `${pct}%`, background: COLOR[m] }} /></div>
              <div className="prog">
                <span>{num(ok)} berhasil{failed ? ` · ${failed} gagal` : ''}</span>
                <span>{num(ok + failed)} / {num(count)} · {r.elapsedS} s</span>
              </div>
              {(r.reason || r.firstError) && <div className="prog" style={{ color: 'var(--sealed)' }}><span>{r.reason ?? `Galat pertama: ${r.firstError}`}</span></div>}
            </div>
            <div className="kpis">
              <div>TPS<b>{formatDecimal(series.at(-1) ?? 0)}</b></div>
              <div>Rata-rata<b>{formatDecimal(avgTps)}</b></div>
              <div>Latensi p50<b>{formatDecimal(p50Ms / 1000, 2)} s</b></div>
            </div>
          </div>
        );
      })}
    </>
  );
}
