import type { AddressInfo } from 'node:net';
import { Transaction, keccak256 } from 'ethers';
import { vi } from 'vitest';
import { TRANCHE_A, pay, type LoggedAnnouncement } from '../../ts/chain.ts';
import { buildBondMetadata } from '../../ts/bond.ts';
import { generateMetaAddress, deriveStealth, scan } from '../../ts/stealth.ts';
import { buildTokenMetadata } from '../../ts/token.ts';
import { createSigner } from '../src/server.ts';
import type { BankKeys, ChainPort, CertClient, Keys, PeerIdentity, SignerConfig, ViewCopyStore } from '../src/types.ts';

export const CHAIN_ID = 1337n;
export const RD = '0x00000000000000000000000000000000000000d1';
export const BOND = '0x00000000000000000000000000000000000000b1';
export const NOW = 1_800_000_000n;

// Party A: the reference vector of ts/stealth.test.ts:6-11 (spend 0x11.., view 0x22..) plus an identity key.
export const A: BankKeys & { metaAddress: string } = {
  spendKey: '0x' + '11'.repeat(32),
  viewKey: '0x' + '22'.repeat(32),
  identityKey: '0x' + '44'.repeat(32),
  metaAddress:
    '0x034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27',
};
export const B = generateMetaAddress(); // receiver of A's payments
const OTHER_SENDER = '0x' + '77'.repeat(32);

export const CONFIG: SignerConfig = { party: 'A', role: 'bank', chainId: CHAIN_ID, rd: RD, bond: BOND, fromBlock: 0 };

export class FakeChain implements ChainPort {
  anns: LoggedAnnouncement[] = [];
  balances = new Map<string, bigint>();
  sent: string[] = [];
  nonces = new Map<string, number>();
  async announcements() { return this.anns; }
  async balanceOf(token: string, holder: string) { return this.balances.get((token + holder).toLowerCase()) ?? 0n; }
  async nonce(a: string) { return this.nonces.get(a.toLowerCase()) ?? 0; }
  async gasPrice() { return 0n; }
  gasCalls: Array<{ from: string; to: string; data: string }> = [];
  domain = '0x' + 'dd'.repeat(32);
  certNonces = new Map<string, bigint>();
  escrows = new Set<string>();
  async estimateGas(tx: { from: string; to: string; data: string }) { this.gasCalls.push(tx); return 500_000n; }
  async bondDomainSeparator() { return this.domain; }
  async usedCertificateNonce(token: string, sender: string) { return this.certNonces.get((token + sender).toLowerCase()) ?? 0n; }
  async isEscrow(a: string) { return this.escrows.has(a.toLowerCase()); }
  registry = new Map<string, string>(); // identity address (lowercase) -> registered meta-address (S11)
  registryError = false;
  async registryMetaAddress(identity: string) { if (this.registryError) throw new Error('rpc down'); return this.registry.get(identity.toLowerCase()) ?? null; }
  async now() { return NOW; }
  predicted = '0x' + '00'.repeat(20);
  async predictEscrow() { return this.predicted; }
  async sendRawTransaction(raw: string) { this.sent.push(raw); return keccak256(raw); }
  xfers: Array<{ token: string; from: string; to: string; value: bigint; blockNumber: number }> = []; // ERC20 Transfer events of RD + bond
  times = new Map<number, bigint>(); // block -> timestamp (default NOW)
  head = 0;
  async transfers() { return { upTo: this.head, rows: this.xfers }; }
  async blockTime(n: number) { return this.times.get(n) ?? NOW; }
}

// Fund party A with `amount` RD (partition undefined) or bond (TRANCHE_A) at a fresh stealth address; return that address.
export function fund(chain: FakeChain, kind: 'rd' | 'bond', amount: bigint, block = 1): string {
  const token = kind === 'rd' ? RD : BOND;
  const p = pay(CHAIN_ID, A.metaAddress, OTHER_SENDER, token, amount, kind === 'bond' ? TRANCHE_A : undefined);
  const metadata = kind === 'rd'
    ? buildTokenMetadata(p.s.viewTag, token, amount, p.memo)
    : buildBondMetadata(p.s.viewTag, token, amount, TRANCHE_A, p.memo);
  chain.anns.push({
    schemeId: 1n, stealthAddress: p.s.stealthAddress, ephemeralPubKey: p.s.ephemeralPubKey, metadata,
    txHash: '0x' + String(block).padStart(64, '0'), blockNumber: block, caller: token,
  });
  chain.balances.set((token + p.s.stealthAddress).toLowerCase(), amount);
  return p.s.stealthAddress;
}

// An announcement for somebody else (party B) and one malformed one: neither may show up in A's holdings.
export function noise(chain: FakeChain) {
  const s = deriveStealth(B.metaAddress);
  chain.anns.push({ schemeId: 1n, stealthAddress: s.stealthAddress, ephemeralPubKey: s.ephemeralPubKey, metadata: s.viewTag, txHash: '0x' + '0'.repeat(64), blockNumber: 2, caller: RD });
  chain.anns.push({ schemeId: 1n, stealthAddress: RD, ephemeralPubKey: '0x00', metadata: '0x', txHash: '0x' + '0'.repeat(64), blockNumber: 3, caller: RD });
}

export const scanA = (chain: FakeChain) => scan(chain.anns, A.viewKey, A.spendKey);

export type Rec = { logs: string[]; bodies: string[] };

// Start the signer on 127.0.0.1:0 (loopback only, no outside network). Every response body and log/console line is recorded.
export async function start(chain: FakeChain, opts: { cert?: CertClient; cfg?: Partial<SignerConfig>; peer?: PeerIdentity; keys?: Keys; store?: ViewCopyStore } = {}) {
  const rec: Rec = { logs: [], bodies: [] };
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { rec.logs.push(a.map(String).join(' ')); });
  }
  const { metaAddress: _m, ...keys } = A;
  const server = createSigner({ ...CONFIG, ...opts.cfg }, { keys: opts.keys ?? keys, chain, log: (l) => rec.logs.push(l), cert: opts.cert, peer: opts.peer, viewCopyStore: opts.store });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    rec.bodies.push(text);
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  return { call, rec, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

export const decodeRaw = (raw: string) => Transaction.from(raw);
