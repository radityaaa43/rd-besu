import type { Meta } from '../api.ts';
import type { ModelId, PartyId } from '../../../server/src/domain.ts';
import { GROUPS, MODEL_COPY, flowName, nodeLabel, roleHelp } from './copy.ts';
import type { DemoAction, DemoState } from './demoState.ts';

const ROLE_ORDER: PartyId[] = ['A', 'B', 'C', 'BI'];

export function Sidebar({ meta, s, dispatch }: { meta: Meta; s: DemoState; dispatch: (a: DemoAction) => void }) {
  const busy = s.phase === 'run';
  const caps = meta.models[s.model].capabilities;
  const f = meta.flows[s.flow];
  const enabledOf = (m: ModelId) => Object.entries(meta.models[m].capabilities).filter(([, c]) => c.enabled).map(([k]) => k) as DemoState['flow'][];
  return (
    <aside aria-label="Pengaturan">
      <div className="q">
        <h3><span className="n">1</span>Network</h3>
        <div className="seg">
          <button aria-pressed="true" disabled={busy}>Besu</button>
          <button aria-pressed="false" disabled title="Segera">Fabric-X <small>(segera)</small></button>
        </div>
      </div>
      <div className="q">
        <h3><span className="n">2</span>Model privasi</h3>
        <div className="seg">
          {(Object.keys(meta.models) as ModelId[]).map((m) => (
            <button key={m} aria-pressed={s.model === m} disabled={busy || !meta.models[m].available}
              title={meta.models[m].available ? undefined : 'Belum tersedia'}
              onClick={() => dispatch({ type: 'model', model: m, enabled: enabledOf(m) })}>
              {meta.models[m].name}
            </button>
          ))}
        </div>
        <p className="tagline">{MODEL_COPY[s.model].tag}</p>
      </div>
      <div className="q">
        <h3><span className="n">3</span>Alur</h3>
        <div>
          {GROUPS.map(([g, title, flows]) => (
            <div className="fgroup" key={g}>
              <h4>{title}</h4>
              {flows.map((k) => {
                const cap = caps[k];
                return (
                  <button key={k} className="flow" aria-pressed={s.flow === k} disabled={!cap.enabled || busy}
                    onClick={() => dispatch({ type: 'flow', flow: k })}>
                    <span>{flowName(s.model, k)}</span>
                    {!cap.enabled && <small>{cap.reason}</small>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="q">
        <h3><span className="n">4</span>Jalankan sebagai</h3>
        <div className="roles">
          {ROLE_ORDER.map((id) => {
            const ok = f.issuer ? id === 'BI' : id !== 'BI';
            return (
              <button key={id} className={id === 'BI' ? 'role bi' : 'role'} aria-pressed={s.from === id} disabled={!ok || busy}
                onClick={() => dispatch({ type: 'from', from: id })}>
                <b>{meta.parties[id].name}</b><small>{nodeLabel(s.model, meta.parties[id].node)}</small>
              </button>
            );
          })}
        </div>
        <p className="rolehelp">{roleHelp(f.issuer, f.dvp)}</p>
      </div>
    </aside>
  );
}
