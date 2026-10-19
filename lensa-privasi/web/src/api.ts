import type { Capability } from '../../server/src/adapter.ts';
import type { FlowId, FlowRequest, ModelId, PartyId } from '../../server/src/domain.ts';
import type { StressConfig, StressSnapshot } from '../../server/src/stress.ts';
import type { TxResult } from './demo/demoState.ts';

export interface Meta {
  parties: Record<PartyId, { name: string; node: 1 | 2 | 3 | 4 }>;
  flows: Record<FlowId, { asset: 'RD' | 'DFABI'; issuer: boolean; dvp: boolean }>;
  models: Record<ModelId, { name: string; available: boolean; stepLabels: string[]; capabilities: Record<FlowId, Capability> }>;
}
export interface Health {
  models: Record<ModelId, { ready: boolean; detail: string }>;
  nodes: { besu: boolean; paladin: boolean[] };
}
export type Capacity = Partial<Record<ModelId, number>>;
export type Reply<T> = { ok: true; body: T } | { ok: false; reason: string };

const OFFLINE = 'Tidak dapat terhubung ke server';

async function call<T>(path: string, init?: RequestInit): Promise<Reply<T>> {
  try {
    const res = await fetch(path, init);
    const body = await res.json().catch(() => null);
    if (res.ok) return { ok: true, body: body as T };
    return { ok: false, reason: (body as { reason?: string } | null)?.reason ?? `Server menjawab ${res.status}` };
  } catch {
    return { ok: false, reason: OFFLINE };
  }
}
const post = <T,>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const getMeta = () => call<Meta>('/api/meta');
export const getHealth = () => call<Health>('/api/health');
export const getCapacity = () => call<Capacity>('/api/preflight-capacity');
export const postTx = (req: FlowRequest) => post<{ runId: string }>('/api/tx', req);
export const getStress = () => call<StressSnapshot>('/api/stress');
export const postStress = (cfg: StressConfig) => post<StressSnapshot>('/api/stress', cfg);
export const stopStress = () => post<StressSnapshot>('/api/stress/stop');
export const CSV_URL = '/api/stress/csv';

// EventSource reconnects by itself after the server closes the stream, so every terminal event must close it.
export function watchTx(
  runId: string,
  h: { onStep(index: number, ms: number): void; onResult(r: TxResult): void; onError(reason: string): void },
): () => void {
  const es = new EventSource(`/api/tx/${runId}/events`);
  const data = (e: Event) => JSON.parse((e as MessageEvent<string>).data);
  es.addEventListener('step', (e) => { const s = data(e); h.onStep(s.index, s.ms); });
  es.addEventListener('result', (e) => { es.close(); h.onResult(data(e)); });
  es.addEventListener('error', (e) => {
    // server-sent `error` carries data; a bare transport error does not and is retried by the browser
    if (!(e as MessageEvent).data) return;
    es.close();
    h.onError(data(e).reason);
  });
  return () => es.close();
}

export function watchStress(h: { onSnapshot(s: StressSnapshot): void }): () => void {
  const es = new EventSource('/api/stress/events');
  const data = (e: Event) => JSON.parse((e as MessageEvent<string>).data) as StressSnapshot;
  es.addEventListener('tick', (e) => h.onSnapshot(data(e)));
  es.addEventListener('done', (e) => { es.close(); h.onSnapshot(data(e)); });
  return () => es.close();
}
