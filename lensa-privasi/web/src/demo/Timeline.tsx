import { formatSeconds } from '../format.ts';
import type { DemoState } from './demoState.ts';

export function Timeline({ labels, s }: { labels: string[]; s: DemoState }) {
  return (
    <section className="card" aria-label="Proses">
      <ol className="timeline">
        {labels.map((label, i) => {
          const ms = s.steps[i];
          const cls = ms != null ? 'ok' : s.phase === 'run' && i === s.steps.filter((x) => x != null).length ? 'run' : '';
          return (
            <li key={label} className={cls}>
              <span className="st">
                {cls === 'ok' && <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>}
              </span>
              <span>{label}<span className="ms">{ms != null ? formatSeconds(ms) : '—'}</span></span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
