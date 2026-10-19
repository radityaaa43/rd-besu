import type { BankId, FlowId, FlowRequest, ModelId, PartyId, Role } from './domain.ts';
import type { Sample } from './stats.ts';

export interface StepEvent { index: number; label: string; ms: number }
export interface FlowResult { txHash: string; block: number; steps: StepEvent[]; context: unknown } // context: adapter-private data lens() needs
export type Verdict = 'clear' | 'reported' | 'notarised' | 'viewkey' | 'partial' | 'sealed';
export interface LensView {
  party: PartyId; role: Role; verdict: Verdict; amount: string | null; counterparty: string | null;
  onChain: { label: string; value: string }[]; method: string; // amount null => redacted
}
export type Capability = { enabled: true } | { enabled: false; reason: string };

export interface ModelAdapter {
  id: ModelId;
  stepLabels: [string, string, string, string]; // spec §5.3, verbatim
  capabilities(): Record<FlowId, Capability>;
  health(): Promise<{ ready: boolean; detail: string }>;
  balanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint>;
  run(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult>;
  lens(req: FlowRequest, result: FlowResult, party: PartyId): Promise<LensView>;
  loadCapacity(): Promise<number>;
  prepareLoad(n: number): Promise<void>;
  transferForLoad(from: BankId, to: BankId, amount: bigint): Promise<Sample>;
}

export const LOAD_AMOUNT = 1000n;
