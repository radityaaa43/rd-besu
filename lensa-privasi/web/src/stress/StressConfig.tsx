import type { ModelId } from '../../../server/src/domain.ts';
import type { Capacity, Meta } from '../api.ts';
import { COLOR } from './RunRows.tsx';
import { CONCURRENCY, LIMITS, PRESETS, showZetoWarning } from './stressForm.ts';

export interface Form { models: ModelId[]; count: number; concurrency: 1 | 2 | 4 | 8; limitS: 120 | 300 | 600 }
export interface ConfigProps {
  meta: Meta; capacity: Capacity; form: Form; running: boolean; starting: boolean; cap: number;
  countText: string | null; error: string | null;
  onChange(p: Partial<Form>): void; onCountText(t: string | null): void; onToggle(m: ModelId): void; onGo(): void;
}

const CHECK = <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" strokeWidth="3.5"><path d="M20 6 9 17l-5-5" /></svg>;
const WARN = <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>;
const SUB = { display: 'block', fontSize: '12.5px', fontWeight: 400, color: 'var(--muted)' } as const;

export function StressConfig(p: ConfigProps) {
  const { meta, capacity, form, running } = p;
  const locked = running || p.starting;
  return (
    <aside aria-label="Konfigurasi stress test" className="cfg">
      <div className="q">
        <h3><span className="n">1</span>Model yang diuji</h3>
        <div className="mchk">
          {(Object.keys(meta.models) as ModelId[]).map((m) => {
            const cap = capacity[m];
            const usable = meta.models[m].available && cap !== undefined;
            const on = form.models.includes(m);
            return (
              <button key={m} aria-pressed={on} disabled={locked || !usable} onClick={() => p.onToggle(m)}>
                <span className="box">{on && CHECK}</span>
                <span>
                  {meta.models[m].name}
                  <small style={SUB}>{usable ? `Kapasitas siap: ${cap.toLocaleString('id-ID')} tx` : meta.models[m].available ? 'Kapasitas tidak terbaca' : 'Belum tersedia'}</small>
                </span>
                <i className="swatch" style={{ background: COLOR[m] }} />
              </button>
            );
          })}
        </div>
        <p className="small">Model dijalankan bergantian, bukan bersamaan, supaya hasilnya tidak saling memperlambat.</p>
      </div>
      <div className="q">
        <h3><span className="n">2</span>Alur</h3>
        <div className="fixed">Transfer RD antar bank<small>Sama untuk semua model supaya perbandingannya adil.</small></div>
      </div>
      <div className="q">
        <h3><span className="n">3</span>Beban</h3>
        <div className="seg">
          {PRESETS.map(([label, n]) => (
            <button key={n} aria-pressed={form.count === n} disabled={locked} title={label} onClick={() => { p.onCountText(null); p.onChange({ count: n }); }}>{n} tx</button>
          ))}
        </div>
        <label className="f" htmlFor="tn">Jumlah transaksi per model</label>
        <input id="tn" inputMode="numeric" disabled={locked} value={p.countText ?? form.count.toLocaleString('id-ID')}
          onChange={(e) => p.onCountText(e.target.value.replace(/\D/g, ''))} onBlur={() => p.onCountText(null)} />
        <label className="f" id="tconc-label">Pengirim paralel</label>
        <div className="seg" role="group" aria-labelledby="tconc-label">
          {CONCURRENCY.map((c) => <button key={c} aria-pressed={form.concurrency === c} disabled={locked} onClick={() => p.onChange({ concurrency: c })}>{c}</button>)}
        </div>
        <label className="f" htmlFor="tlimit">Batas waktu per model</label>
        <select id="tlimit" value={form.limitS} disabled={locked} onChange={(e) => p.onChange({ limitS: Number(e.target.value) as Form['limitS'] })}>
          {LIMITS.map(([s, t]) => <option key={s} value={s}>{t}</option>)}
        </select>
        <p className="small">Model berhenti saat jumlah transaksi tercapai atau batas waktu habis, mana yang lebih dulu.</p>
      </div>
      {showZetoWarning(form.models, form.concurrency) && (
        <div className="warn">{WARN}<span>Zeto membangun bukti ZK di CPU node. Lebih dari 2 pengirim paralel pernah membuat node Paladin restart, jadi Zeto dibatasi 2 transaksi paralel.</span></div>
      )}
      <div>
        <button className={running ? 'btn2 stop' : 'btn2'} disabled={!running && (p.starting || form.models.length === 0 || p.cap === 0)} onClick={p.onGo}>
          {running ? 'Hentikan' : 'Mulai stress test'}
        </button>
        {!running && !p.starting && (form.models.length === 0 || p.cap === 0) && (
          <p className="small">{form.models.length === 0 ? 'Pilih minimal satu model.' : 'Model terpilih belum punya kapasitas siap. Jalankan preflight --prepare dulu.'}</p>
        )}
        {p.error && <p className="small" role="alert" style={{ color: 'var(--sealed)' }}>{p.error}</p>}
      </div>
    </aside>
  );
}
