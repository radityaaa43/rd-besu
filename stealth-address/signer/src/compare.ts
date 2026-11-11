import { getBytes, hexlify } from 'ethers';
import { scanView, type ViewKeyHolder } from '../../ts/stealth.ts';

// S11 DELTA 3, detective: BI compares the viewing public key (bytes 33..66 of the 66-byte meta-address) that each party REGISTERED
// in the ERC-6538 registry with the view-key copy BI holds. Pure and injectable: no network, no key in any output (ids, public addresses, lengths only).
export type CompareBank = ViewKeyHolder & { identityAddress: string };
export type CompareStatus = 'OK' | 'MISMATCH' | 'unregistered' | 'bad_copy' | 'registry_error' | 'missing_copy' | 'ignored';
export type CompareRow = { bank: string; status: CompareStatus; detail: string };

// Every run checks exactly these four parties (view-copy ids), in this order.
export const PARTIES = ['bi', 'bank-a', 'bank-b', 'bank-c'];

const VIEW_FROM = 33;
const META_LEN = 66;

// Error text for a row: code + short message, any hex run of 64+ digits (a key) replaced, then cut to 80 chars (scrub first, so a key is never half-cut).
const describe = (e: unknown) => {
  const o = (e ?? {}) as { code?: unknown; shortMessage?: unknown };
  const text = [typeof o.code === 'string' ? o.code : '', String(typeof o.shortMessage === 'string' ? o.shortMessage : (e instanceof Error ? e.message : e))].filter(Boolean).join(': ');
  return text.replace(/(0x)?[0-9a-fA-F]{64,}/g, '0x<redacted>').replace(/\s+/g, ' ').slice(0, 80);
};

async function compareOne(registry: (identity: string) => Promise<string | null>, b: CompareBank): Promise<CompareRow> {
  const row = (status: CompareStatus, detail = ''): CompareRow => ({ bank: b.id, status, detail });
  try { scanView([], b); } catch { return row('bad_copy', 'held view key does not belong to the held meta-address, or it is not 66 bytes'); }
  let value: string | null;
  try { value = await registry(b.identityAddress); } catch (e) { return row('registry_error', describe(e)); }
  if (!value || value === '0x') return row('unregistered');
  let reg: Uint8Array;
  try { reg = getBytes(value); } catch { return row('MISMATCH', `registry value under ${b.identityAddress} is not hex`); }
  if (reg.length !== META_LEN) return row('MISMATCH', `registry value under ${b.identityAddress} is ${reg.length} bytes, expected ${META_LEN}`);
  const held = getBytes(b.metaAddress.split(':').pop()!);
  return hexlify(reg.slice(VIEW_FROM)) === hexlify(held.slice(VIEW_FROM))
    ? row('OK')
    : row('MISMATCH', `registry viewing key under ${b.identityAddress} differs from the held copy`);
}

// One row per party of PARTIES in order (missing_copy when BI holds no copy of it), then `ignored` rows for copies of any other id.
export async function compareViewKeys({ registry, banks }: { registry: (identity: string) => Promise<string | null>; banks: CompareBank[] }): Promise<CompareRow[]> {
  const rows = await Promise.all(PARTIES.map((id) => {
    const b = banks.find((x) => x.id === id);
    return b ? compareOne(registry, b) : Promise.resolve<CompareRow>({ bank: id, status: 'missing_copy', detail: '' });
  }));
  return [...rows, ...banks.filter((b) => !PARTIES.includes(b.id)).map((b): CompareRow => ({ bank: b.id, status: 'ignored', detail: '' }))];
}

export const formatRow = (r: CompareRow) => (r.detail ? `${r.status} ${r.bank} ${r.detail}` : `${r.status} ${r.bank}`);

const failing = (rows: CompareRow[]) => PARTIES.filter((p) => rows.find((r) => r.bank === p)?.status !== 'OK').length;
export const summaryLine = (rows: CompareRow[]) => (failing(rows) === 0 ? `compare: ${PARTIES.length}/${PARTIES.length} OK` : `compare: FAIL (${failing(rows)} not OK)`);
// 0 only when every party of PARTIES is OK: a missing party, no rows at all or any other status must not pass silently. `ignored` rows never count.
export const exitCode = (rows: CompareRow[]) => (failing(rows) === 0 ? 0 : 1);

// READ-ONLY RPC guard: the compare process may only send these methods to the node; anything else is refused before it leaves the process.
export const READ_ONLY_METHODS = new Set(['eth_call', 'eth_blockNumber', 'eth_chainId']);
type Send = (method: string, params: any[] | Record<string, any>) => Promise<any>;
export const readOnlySend = (send: Send, allowed: Set<string> = READ_ONLY_METHODS): Send => async (method, params) => {
  if (!allowed.has(method)) throw new Error(`rpc method not allowed: ${method}`);
  return send(method, params);
};
// ethers routes every provider call (call, getBlockNumber, getLogs, broadcastTransaction, ...) through provider.send, so the instance override covers them all.
export const guardProvider = <P extends { send: Send }>(p: P): P => { p.send = readOnlySend(p.send.bind(p)); return p; };
