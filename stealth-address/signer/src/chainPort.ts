import { Contract, FetchRequest, Interface, JsonRpcProvider, zeroPadValue, type Provider } from 'ethers';
import { LOG_RANGE, type LoggedAnnouncement } from '../../ts/chain.ts';
import type { ChainPort } from './types.ts';

// ABIs inline (analyst verdict 2). Event/function signatures: src/ERC5564Announcer.sol, src/DvPFactory.sol, ERC1400 + ERC1400TokensValidator.
const abi = new Interface([
  'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)',
  'event EscrowCreated(bytes32 indexed tradeId, address indexed escrow)',
  'function balanceOf(address holder) view returns (uint256)',
  'function balanceOfByPartition(bytes32 partition, address holder) view returns (uint256)',
  'function generateDomainSeparator() view returns (bytes32)',
  'function usedCertificateNonce(address token, address sender) view returns (uint256)',
]);

export type ChainPortOptions = {
  provider: Provider;
  announcer: string; validator: string; dvpFactory: string; // contract addresses
  rd: string; bond: string; // announcements are read for these two tokens (caller topic)
  fromBlock: number; // isEscrow scans DvPFactory logs from here
};

// JSON-RPC provider for the party's own Besu node; `token` (see rpcToken.ts) is called per request, so a short-lived JWT never goes stale.
export function createProvider(url: string, chainId: bigint, token?: () => string): JsonRpcProvider {
  const req = new FetchRequest(url);
  if (token) req.preflightFunc = async (r) => { r.setHeader('Authorization', `Bearer ${token()}`); return r; };
  return new JsonRpcProvider(req, chainId, { staticNetwork: true });
}

export function createChainPort(o: ChainPortOptions): ChainPort {
  const p = o.provider;
  const at = (addr: string) => new Contract(addr, abi, p);
  const topic = (name: string) => abi.getEvent(name)!.topicHash;
  // eth_getLogs is capped (Besu: 1000 blocks), so read in LOG_RANGE chunks
  async function logs(address: string, topics: (string | string[] | null)[], fromBlock: number) {
    const end = await p.getBlockNumber();
    const out = [];
    for (let from = fromBlock; from <= end; from += LOG_RANGE) out.push(...(await p.getLogs({ address, topics, fromBlock: from, toBlock: Math.min(from + LOG_RANGE - 1, end) })));
    return out;
  }
  const pad = (a: string) => zeroPadValue(a, 32);
  return {
    async announcements(fromBlock): Promise<LoggedAnnouncement[]> {
      return (await logs(o.announcer, [topic('Announcement'), null, null, [pad(o.rd), pad(o.bond)]], fromBlock)).map((l) => {
        const a = abi.parseLog(l)!.args;
        return { schemeId: a.schemeId, stealthAddress: a.stealthAddress, ephemeralPubKey: a.ephemeralPubKey, metadata: a.metadata, txHash: l.transactionHash, blockNumber: l.blockNumber, caller: a.caller };
      });
    },
    async balanceOf(token, holder, partition) {
      const c = at(token);
      return partition ? c.balanceOfByPartition(partition, holder) : c.balanceOf(holder);
    },
    nonce: (a) => p.getTransactionCount(a, 'pending'),
    async gasPrice() { return (await p.getFeeData()).gasPrice ?? 0n; },
    estimateGas: (tx) => p.estimateGas(tx),
    async now() { return BigInt((await p.getBlock('latest'))!.timestamp); },
    bondDomainSeparator: () => at(o.bond).generateDomainSeparator(),
    usedCertificateNonce: (token, sender) => at(o.validator).usedCertificateNonce(token, sender),
    // ponytail: scans DvPFactory logs per call; cache or index if /cert volume matters
    async isEscrow(a) { return (await logs(o.dvpFactory, [topic('EscrowCreated'), null, pad(a)], o.fromBlock)).length > 0; },
    async sendRawTransaction(raw) { return (await p.broadcastTransaction(raw)).hash; },
  };
}
