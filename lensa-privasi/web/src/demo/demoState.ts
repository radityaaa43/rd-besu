import type { LensView, StepEvent } from '../../../server/src/adapter.ts';
import { BANKS, FLOWS, type FlowId, type ModelId, type PartyId } from '../../../server/src/domain.ts';

export interface TxResult { txHash: string; block: number; steps: StepEvent[]; lenses: LensView[] }
export interface DemoState {
  model: ModelId; flow: FlowId; from: PartyId; to: PartyId;
  amount: string; // decimal digits, kept as a string so it never passes through a JS number
  phase: 'idle' | 'run' | 'done' | 'error';
  tab: 'req' | 'res';
  steps: number[]; // measured ms per step, by index
  result: TxResult | null;
  error: string | null;
  open: PartyId | null; // lens whose detail panel is open
}
export type DemoAction =
  | { type: 'model'; model: ModelId; enabled: FlowId[] }
  | { type: 'flow'; flow: FlowId }
  | { type: 'from'; from: PartyId }
  | { type: 'to'; to: PartyId }
  | { type: 'amount'; amount: string }
  | { type: 'tab'; tab: 'req' | 'res' }
  | { type: 'open'; party: PartyId }
  | { type: 'start' }
  | { type: 'step'; index: number; ms: number }
  | { type: 'result'; result: TxResult }
  | { type: 'error'; reason: string };

const defaultAmount = (f: FlowId) => (FLOWS[f].asset === 'RD' ? '1000000000' : '1000');
const cleared = (): Pick<DemoState, "phase" | "tab" | "steps" | "result" | "error" | "open"> =>
  ({ phase: 'idle', tab: 'req', steps: [], result: null, error: null, open: null });

// issuance is BI only, every other flow is a bank; the receiver is always a bank other than the sender
function fixParties(s: DemoState): DemoState {
  const from: PartyId = FLOWS[s.flow].issuer ? 'BI' : s.from === 'BI' ? 'A' : s.from;
  const to = s.to !== from && s.to !== 'BI' ? s.to : BANKS.find((b) => b !== from)!;
  return { ...s, from, to };
}

export function initialDemo(model: ModelId, enabled: FlowId[]): DemoState {
  const flow = enabled.includes('rd-transfer') ? 'rd-transfer' : enabled[0] ?? 'rd-transfer';
  return fixParties({ model, flow, from: 'A', to: 'B', amount: defaultAmount(flow), ...cleared() });
}

export function demoReducer(s: DemoState, a: DemoAction): DemoState {
  switch (a.type) {
    case 'tab': return { ...s, tab: a.tab };
    case 'open': return s.phase === 'done' ? { ...s, open: s.open === a.party ? null : a.party } : s;
    case 'start': return { ...s, ...cleared(), phase: 'run' };
    case 'step': {
      if (s.phase !== 'run') return s;
      const steps = [...s.steps];
      steps[a.index] = a.ms;
      return { ...s, steps };
    }
    case 'result': return { ...s, phase: 'done', tab: 'res', result: a.result, steps: a.result.steps.map((x) => x.ms) };
    case 'error': return { ...s, phase: 'error', tab: 'res', error: a.reason };
  }
  if (s.phase === 'run') return s; // selections are locked while a run is in flight
  switch (a.type) {
    case 'model': {
      const flow = a.enabled.includes(s.flow) ? s.flow : a.enabled[0] ?? s.flow;
      return fixParties({ ...s, ...cleared(), model: a.model, flow, amount: flow === s.flow ? s.amount : defaultAmount(flow) });
    }
    case 'flow': return fixParties({ ...s, ...cleared(), flow: a.flow, amount: defaultAmount(a.flow) });
    case 'from': return fixParties({ ...s, ...cleared(), from: a.from });
    case 'to': return fixParties({ ...s, ...cleared(), to: a.to });
    case 'amount': return { ...s, ...cleared(), amount: a.amount };
  }
}
