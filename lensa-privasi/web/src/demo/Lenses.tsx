import type { LensView } from '../../../server/src/adapter.ts';
import { PRICE_PER_UNIT, type PartyId } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';
import { formatRupiah, formatUnits, shortHash } from '../format.ts';
import { counterpartyLine } from './counterparty.ts';
import { MODEL_COPY, VERDICT, nodeLabel, roleLabel } from './copy.ts';
import type { DemoAction, DemoState } from './demoState.ts';

const ICON = {
  eye: <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  lock: <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
  half: <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" /></svg>,
};
const INSIDE_ORDER = ['issuer', 'sender', 'receiver', 'regulator'];

function Legend() {
  return (
    <div className="legend">
      <span><i className="sw" style={{ background: 'var(--clear)' }} />Terbaca utuh</span>
      <span><i className="sw" style={{ background: 'var(--partial)' }} />Sebagian</span>
      <span><i className="sw" style={{ background: 'var(--sealed)' }} />Tersegel</span>
    </div>
  );
}

export function Lenses({ meta, s, dispatch }: { meta: Meta; s: DemoState; dispatch: (a: DemoAction) => void }) {
  const f = meta.flows[s.flow];
  const nm = (id: PartyId) => meta.parties[id].name;
  const done = s.phase === 'done' && s.result !== null;
  const who = (id: PartyId, role: string) => `${roleLabel(role, f.dvp)} · ${nodeLabel(s.model, meta.parties[id].node)}`;

  // before the result arrives: who takes part follows from the selection alone, no data is shown
  const sender = f.issuer ? 'issuer' : 'sender';
  const idleCards: { party: PartyId; role: string }[][] = [
    f.issuer
      ? [{ party: 'BI', role: sender }, { party: s.to, role: 'receiver' }]
      : [{ party: s.from, role: sender }, { party: s.to, role: 'receiver' }, { party: 'BI', role: 'regulator' }],
    (['A', 'B', 'C'] as PartyId[]).filter((b) => b !== s.from && b !== s.to).map((party) => ({ party, role: 'outsider' })),
  ];

  const lenses = done ? s.result!.lenses : [];
  const inside = lenses.filter((l) => l.role !== 'outsider').sort((a, b) => INSIDE_ORDER.indexOf(a.role) - INSIDE_ORDER.indexOf(b.role));
  const outside = lenses.filter((l) => l.role === 'outsider');

  const line = (l: LensView) => counterpartyLine(l, f.dvp, nm);
  const value = (l: LensView) => {
    if (l.amount === null) return <span className="redact">Rp 000.000.000</span>;
    try {
      const a = BigInt(l.amount);
      return (
        <>
          {f.asset === 'RD' ? formatRupiah(a) : formatUnits(a)}
          {f.dvp && <div className="leg">⇄ {formatRupiah(a * PRICE_PER_UNIT)}</div>}
        </>
      );
    } catch {
      return <>{String(l.amount)}</>; // malformed server data is shown as received, not hidden or crashed on
    }
  };

  const card = (l: LensView, i: number) => {
    const v = VERDICT[l.verdict] ?? { cls: '', icon: null, text: String(l.verdict) }; // unknown verdict: show it raw
    return (
      <button key={l.party} className={`lens ${v.cls} reveal`} style={{ animationDelay: `${i * 90}ms` }}
        aria-expanded={s.open === l.party} onClick={() => dispatch({ type: 'open', party: l.party })}>
        <span className="who">{who(l.party, l.role)}</span>
        <h5>{nm(l.party)}</h5>
        <div className="val">{value(l)}</div>
        <div className="line">{line(l)}</div>
        {v.cls !== 'clear' && (l.onChain?.length ?? 0) > 0 && (
          <div className="hex">{l.onChain.map((o, k) => <span key={k}>{k > 0 && <br />}{o.label} {shortHash(o.value)}</span>)}</div>
        )}
        <div className="verdict">{v.icon && ICON[v.icon]}{v.text}</div>
      </button>
    );
  };
  const idleCard = (c: { party: PartyId; role: string }) => (
    <div key={c.party} className="lens idle">
      <span className="who">{who(c.party, c.role)}</span>
      <h5>{nm(c.party)}</h5>
      <div className="val">··· ··· ···</div>
      <div className="line">Menunggu transaksi</div>
    </div>
  );

  const open = done ? lenses.find((l) => l.party === s.open) : undefined;
  return (
    <section aria-label="Siapa melihat apa">
      <div className="lens-intro">
        <div>
          <h2>Transaksi yang sama, dilihat dari tiap pihak</h2>
          <p>{MODEL_COPY[s.model].story}</p>
        </div>
        <Legend />
      </div>
      <div className="lensrow">
        <div className="lgroup"><h4>Pihak dalam transaksi</h4>
          <div className="lenses">{done ? inside.map((l, i) => card(l, i)) : idleCards[0].map(idleCard)}</div>
        </div>
        <div className="lgroup"><h4>Bank lain di network yang sama</h4>
          <div className="lenses">{done ? outside.map((l, i) => card(l, i + inside.length)) : idleCards[1].map(idleCard)}</div>
        </div>
      </div>
      {open && (
        <div className="card detail" style={{ marginTop: 12 }}>
          <div><h4>Cara {nm(open.party)} membaca transaksi ini</h4><p>{open.method}</p></div>
          <div>
            <h4>Yang tercatat di chain</h4>
            <ul>
              <li>Tx <code title={s.result!.txHash}>{shortHash(s.result!.txHash)}</code>, block {s.result!.block}</li>
              {(open.onChain ?? []).map((o, k) => <li key={k}>{o.label}: <code title={o.value}>{shortHash(o.value)}</code></li>)}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
