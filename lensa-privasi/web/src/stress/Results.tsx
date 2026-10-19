import type { ModelId } from '../../../server/src/domain.ts';
import type { StressSnapshot } from '../../../server/src/stress.ts';
import { CSV_URL, type Meta } from '../api.ts';
import { formatDecimal } from '../format.ts';
import { COLOR } from './RunRows.tsx';
import { conclusion } from './stressForm.ts';

// null while there is nothing to compare: a run in progress, or a run where no model got to measure anything
export function Results({ meta, snap }: { meta: Meta; snap: StressSnapshot }) {
  if (snap.state === 'running') return null;
  const rows = (snap.config.models as ModelId[])
    .flatMap((model) => {
      const m = snap.models[model];
      return m && m.status !== 'waiting' && m.status !== 'skipped' ? [{ model, s: m.summary }] : [];
    })
    .sort((a, b) => b.s.avgTps - a.s.avgTps);
  if (rows.length === 0) return null;
  const mx = rows[0].s.avgTps || 1;
  return (
    <section className="card" aria-label="Hasil">
      <div className="result-head">
        <div><h2>Hasil perbandingan</h2><p>{conclusion(rows)}</p></div>
        <a className="ghost" href={CSV_URL} download style={{ textDecoration: 'none', color: 'inherit' }}>Unduh hasil (CSV)</a>
      </div>
      <div className="hbars" aria-label="TPS rata-rata per model">
        {rows.map(({ model, s }) => (
          <div className="hb" key={model}>
            <span>{meta.models[model].name}</span>
            <span className="track"><i style={{ width: `${Math.max(1, (s.avgTps / mx) * 100)}%`, background: COLOR[model] }} /></span>
            <b>{formatDecimal(s.avgTps)} TPS</b>
          </div>
        ))}
      </div>
      <div className="tablewrap">
        <table className="res">
          <thead>
            <tr><th>Model</th><th>TPS rata-rata</th><th>TPS puncak</th><th>Latensi p50</th><th>Latensi p95</th><th>Berhasil</th><th>Gagal</th><th>Durasi</th></tr>
          </thead>
          <tbody>
            {rows.map(({ model, s }) => (
              <tr key={model}>
                <td>{meta.models[model].name}</td>
                <td>{formatDecimal(s.avgTps)}</td>
                <td>{formatDecimal(s.peakTps)}</td>
                <td>{formatDecimal(s.p50Ms / 1000, 2)} s</td>
                <td>{formatDecimal(s.p95Ms / 1000, 2)} s</td>
                <td>{s.ok.toLocaleString('id-ID')}</td>
                <td>{s.failed}</td>
                <td>{Math.round(s.durationS)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="footnote">
        TPS = transaksi yang sudah punya receipt dibagi waktu dari transaksi pertama dikirim sampai receipt terakhir. Diukur di cluster demo (4 validator Besu, 4 node Paladin) dengan {snap.config.concurrency} pengirim paralel, bukan kapasitas produksi. Paralelisme efektif berbeda: Zeto dibatasi 2 transaksi sekaligus, Noto 1 per bank pengirim, Stealth penuh sebanyak pengirim. Konfirmasi Zeto sudah termasuk laporan BI yang diterima. Noto membelanjakan dari satu koin besar per pengirim.
      </div>
    </section>
  );
}
