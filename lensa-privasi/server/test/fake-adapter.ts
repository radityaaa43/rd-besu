import type { Capability, LensView, ModelAdapter } from '../src/adapter.ts';
import { roleOf, type FlowId, type ModelId } from '../src/domain.ts';

const FLOW_IDS: FlowId[] = ['rd-issue', 'rd-transfer', 'dfabi-issue', 'dfabi-transfer', 'dvp'];

// Deterministic adapter for tests: no chain access, fixed results.
export function fakeAdapter(
  id: ModelId,
  opts: { ready?: boolean; capacity?: number; tps?: number; failEvery?: number; disabled?: Partial<Record<FlowId, string>> } = {},
): ModelAdapter {
  let calls = 0;
  const labels: [string, string, string, string] = ['Siapkan', 'Kirim', 'Konfirmasi', 'Selesai'];
  return {
    id,
    stepLabels: labels,
    capabilities: () => Object.fromEntries(FLOW_IDS.map((f): [FlowId, Capability] => {
      const reason = opts.disabled?.[f];
      return [f, reason === undefined ? { enabled: true } : { enabled: false, reason }];
    })) as Record<FlowId, Capability>,
    health: async () => ({ ready: opts.ready ?? true, detail: opts.ready === false ? 'node mati' : 'ok' }),
    balanceOf: async () => 10n ** 18n,
    async run(_req, _amount, onStep) {
      const steps = labels.map((label, index) => ({ index, label, ms: 100 * (index + 1) }));
      steps.forEach((s) => onStep(s));
      return { txHash: '0x' + 'ab'.repeat(32), block: 42, steps, context: null };
    },
    async lens(req, _result, party): Promise<LensView> {
      const role = roleOf(req, party);
      const sealed = role === 'outsider';
      return {
        party, role, verdict: sealed ? 'sealed' : 'clear',
        amount: sealed ? null : req.amount,
        counterparty: sealed ? null : party === req.from ? req.to : req.from,
        onChain: [{ label: 'tx', value: '0x' + 'ab'.repeat(32) }],
        method: `fake:${id}`,
      };
    },
    loadCapacity: async () => opts.capacity ?? 1000,
    prepareLoad: async () => {},
    async transferForLoad() {
      const n = ++calls;
      const submittedAt = Date.now();
      await new Promise((r) => setTimeout(r, 1000 / (opts.tps ?? 10)));
      if (opts.failEvery && n % opts.failEvery === 0) throw new Error('gagal simulasi');
      return { submittedAt, confirmedAt: Date.now() };
    },
  };
}
