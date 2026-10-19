import { useEffect, useReducer, useRef } from 'react';
import { postTx, watchTx, type Meta } from '../api.ts';
import type { FlowId, ModelId } from '../../../server/src/domain.ts';
import { Compose, requestOf } from './Compose.tsx';
import { Lenses } from './Lenses.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Timeline } from './Timeline.tsx';
import { demoReducer, initialDemo } from './demoState.ts';

function init(meta: Meta) {
  const models = Object.keys(meta.models) as ModelId[];
  const model = models.find((m) => meta.models[m].available) ?? models[0];
  const enabled = Object.entries(meta.models[model].capabilities).filter(([, c]) => c.enabled).map(([k]) => k as FlowId);
  return initialDemo(model, enabled);
}

export function DemoView({ meta, hidden }: { meta: Meta; hidden: boolean }) {
  const [s, dispatch] = useReducer(demoReducer, meta, init);
  const stop = useRef<() => void>();
  useEffect(() => () => stop.current?.(), []);

  async function send() {
    dispatch({ type: 'start' });
    const res = await postTx(requestOf(s));
    if (!res.ok) return dispatch({ type: 'error', reason: res.reason });
    stop.current = watchTx(res.body.runId, {
      onStep: (index, ms) => dispatch({ type: 'step', index, ms }),
      onResult: (result) => dispatch({ type: 'result', result }),
      onError: (reason) => dispatch({ type: 'error', reason }),
    });
  }

  return (
    <div className="shell" hidden={hidden}>
      <Sidebar meta={meta} s={s} dispatch={dispatch} />
      <main>
        <Compose meta={meta} s={s} dispatch={dispatch} onSend={send} />
        <Timeline labels={meta.models[s.model].stepLabels} s={s} />
        <Lenses meta={meta} s={s} dispatch={dispatch} />
      </main>
    </div>
  );
}
