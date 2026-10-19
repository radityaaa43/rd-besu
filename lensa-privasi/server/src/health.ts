export type Probe = () => Promise<{ besu: boolean; paladin: boolean[] }>;

// any failure (refused, timeout, non-JSON body, JSON-RPC error) means "down" for that node only
export const rpcUp = (url: string, method: string): Promise<boolean> =>
  fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    signal: AbortSignal.timeout(2000),
  }).then(async (r) => { const j = await r.json() as { result?: unknown } | null; return j?.result !== undefined; }).catch(() => false);

export const probeNodes: Probe = async () => {
  const [besu, ...paladin] = await Promise.all([
    rpcUp('http://127.0.0.1:8545', 'eth_blockNumber'),
    ...[31548, 31648, 31748, 31848].map((p) => rpcUp(`http://127.0.0.1:${p}`, 'transport_nodeName')),
  ]);
  return { besu, paladin };
};
