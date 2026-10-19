import { MAX_AMOUNT, PRICE_PER_UNIT, type FlowRequest } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';
import { amountWords, formatRupiah, parseAmountInput } from '../format.ts';
import { JsonView } from './JsonView.tsx';
import { flowName, groupName } from './copy.ts';
import type { DemoAction, DemoState } from './demoState.ts';

const VERB = (issuer: boolean, dvp: boolean) => (issuer ? 'Terbitkan' : dvp ? 'Jalankan DvP' : 'Kirim');

export function requestOf(s: DemoState): FlowRequest {
  return { model: s.model, flow: s.flow, from: s.from, to: s.to, amount: s.amount };
}

export function Compose({ meta, s, dispatch, onSend }: { meta: Meta; s: DemoState; dispatch: (a: DemoAction) => void; onSend: () => void }) {
  const busy = s.phase === 'run';
  const f = meta.flows[s.flow];
  const name = (id: keyof Meta['parties']) => meta.parties[id].name;
  const amount = s.amount === '' ? null : BigInt(s.amount);
  const valid = amount !== null && amount >= 1n && amount <= MAX_AMOUNT;
  const banks = (Object.keys(meta.parties) as (keyof Meta['parties'])[]).filter((p) => p !== 'BI' && p !== s.from);
  const sub = f.dvp
    ? `${name(s.from)} menjual DFABI ke ${name(s.to)}, dibayar RD dalam satu transaksi atomik.`
    : `${name(s.from)} ${f.issuer ? 'menerbitkan' : 'mengirim'} ${f.asset} ke ${name(s.to)}.`;
  const hint = !valid
    ? `Isi nominal antara 1 dan ${MAX_AMOUNT.toLocaleString('id-ID')}`
    : amountWords(amount, f.asset) + (f.dvp ? ` · dibayar ${formatRupiah(amount * PRICE_PER_UNIT)}` : '');
  return (
    <section className="card compose" aria-label="Susun transaksi">
      <div>
        <p className="crumbs">{`Besu / ${meta.models[s.model].name} / ${groupName(s.flow)}`}</p>
        <h2>{flowName(s.model, s.flow)}</h2>
        <p className="sub">{sub}</p>
        <div className="fields">
          <div>
            <label className="f" htmlFor="to">{f.issuer ? 'Diterbitkan untuk' : f.dvp ? 'Bank pembeli' : 'Bank penerima'}</label>
            <select id="to" value={s.to} disabled={busy} onChange={(e) => dispatch({ type: 'to', to: e.target.value as DemoState['to'] })}>
              {banks.map((b) => <option key={b} value={b}>{name(b)}</option>)}
            </select>
          </div>
          <div>
            <label className="f" htmlFor="amount">{f.asset === 'RD' ? 'Nominal (Rupiah)' : 'Jumlah (unit DFABI)'}</label>
            <input id="amount" inputMode="numeric" disabled={busy} value={amount === null ? '' : amount.toLocaleString('id-ID')}
              onChange={(e) => dispatch({ type: 'amount', amount: parseAmountInput(e.target.value)?.toString() ?? '' })} />
            <div className="hint">{hint}</div>
          </div>
        </div>
        <button className="go" disabled={busy || !valid} onClick={onSend}>{busy ? 'Memproses di network…' : VERB(f.issuer, f.dvp)}</button>
      </div>
      <div>
        <div className="tabs" role="tablist">
          {(['req', 'res'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={s.tab === t} onClick={() => dispatch({ type: 'tab', tab: t })}>{t === 'req' ? 'Request' : 'Response'}</button>
          ))}
        </div>
        <pre aria-live="polite">
          {s.tab === 'req' ? (
            <><span className="k">POST</span> /api/tx{'\n'}<JsonView value={requestOf(s)} /></>
          ) : s.phase === 'done' && s.result ? (
            <JsonView value={{ status: 'SUCCESS', txHash: s.result.txHash, block: s.result.block, timings_ms: Object.fromEntries(s.result.steps.map((x) => [x.label, x.ms])) }} />
          ) : s.phase === 'error' ? (
            <JsonView value={{ status: 'ERROR', reason: s.error }} />
          ) : (
            <span style={{ color: 'var(--faint)' }}>Response muncul setelah transaksi diproses network.</span>
          )}
        </pre>
      </div>
    </section>
  );
}
