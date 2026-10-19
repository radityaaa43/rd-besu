import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelId } from '../../../server/src/domain.ts';
import type { StressSnapshot } from '../../../server/src/stress.ts';
import { getCapacity, getStress, postStress, stopStress, watchStress, type Capacity, type Meta } from '../api.ts';
import { Results } from './Results.tsx';
import { RunRows } from './RunRows.tsx';
import { StressConfig, type Form } from './StressConfig.tsx';
import { clampCount, minCapacity } from './stressForm.ts';

export function StressView({ meta, hidden }: { meta: Meta; hidden: boolean }) {
  const [capacity, setCapacity] = useState<Capacity>({});
  const selectedOnce = useRef(false);
  const [snap, setSnap] = useState<StressSnapshot | null>(null);
  const [form, setForm] = useState<Form>({ models: [], count: 200, concurrency: 2, limitS: 300 });
  const [countText, setCountText] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unwatch = useRef<() => void>();
  const running = snap?.state === 'running';

  const loadCapacity = useCallback(async () => {
    const r = await getCapacity();
    if (!r.ok) return;
    setCapacity(r.body);
    // first answer: everything usable starts selected
    if (!selectedOnce.current) {
      selectedOnce.current = true;
      setForm((f) => ({ ...f, models: (Object.keys(meta.models) as ModelId[]).filter((m) => r.body[m] !== undefined) }));
    }
  }, [meta]);

  const follow = useCallback(() => {
    unwatch.current?.();
    unwatch.current = watchStress({
      onSnapshot: (s) => {
        setSnap(s);
        if (s.state !== 'running') void loadCapacity(); // a finished run changes what is ready
      },
    });
  }, [loadCapacity]);

  useEffect(() => {
    void loadCapacity();
    void getStress().then((r) => {
      if (!r.ok) return;
      setSnap(r.body);
      if (r.body.state === 'running') follow();
    });
    return () => unwatch.current?.();
  }, [loadCapacity, follow]);

  // back on this tab: capacity may have moved while it was hidden
  useEffect(() => { if (!hidden && !running) void loadCapacity(); }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const cap = minCapacity(form.models, capacity);
  const limit = cap > 0 ? cap : Infinity;
  const count = clampCount(form.count, limit);

  const change = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));
  const toggle = (m: ModelId) => {
    const models = (Object.keys(meta.models) as ModelId[]).filter((x) => (x === m ? !form.models.includes(m) : form.models.includes(x)));
    const c = minCapacity(models, capacity);
    change({ models, count: clampCount(form.count, c > 0 ? c : Infinity) });
  };
  const setText = (t: string | null) => {
    if (!t) return setCountText(t);
    const n = clampCount(Number(t), limit);
    setCountText(String(n)); // what is typed is clamped on the spot
    change({ count: n });
  };

  async function go() {
    if (running) {
      const r = await stopStress();
      if (r.ok) setSnap(r.body);
      return;
    }
    setError(null);
    setStarting(true);
    const r = await postStress({ models: form.models, count, concurrency: form.concurrency, limitS: form.limitS });
    setStarting(false);
    if (!r.ok) return setError(r.reason);
    setSnap(r.body);
    follow();
  }

  const shown = snap?.config ?? { ...form, count };
  const summary = shown.models.length
    ? `${shown.models.map((m) => meta.models[m].name).join(', ')} · ${shown.count.toLocaleString('id-ID')} transaksi per model · ${shown.concurrency} pengirim paralel`
    : 'Pilih minimal satu model.';

  return (
    <div className="shell" hidden={hidden}>
      <StressConfig meta={meta} capacity={capacity} form={{ ...form, count }} running={running} starting={starting} cap={cap}
        countText={countText} error={error} onChange={change} onCountText={setText} onToggle={toggle} onGo={go} />
      <main>
        <section className="card" aria-label="Proses">
          <div className="result-head"><div><h2>Proses</h2><p>{summary}</p></div></div>
          <div className="runs">
            {snap ? <RunRows meta={meta} snap={snap} /> : (
              <div className="empty"><h3>Belum ada pengujian</h3>Atur beban di kiri, lalu klik Mulai stress test.</div>
            )}
          </div>
        </section>
        {snap && <Results meta={meta} snap={snap} />}
      </main>
    </div>
  );
}
