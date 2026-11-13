import { Agent } from 'node:https';
import { Contract, FetchRequest, Interface, JsonRpcProvider, zeroPadValue, type Log, type Provider } from 'ethers';
import type { MtlsOptions } from './mtls.ts';
import { LOG_RANGE, type LoggedAnnouncement } from '../../ts/chain.ts';
import { SCHEME_ID } from '../../ts/stealth.ts';
import type { ChainPort, Terms } from './types.ts';

// DvPEscrow Terms (src/DvPEscrow.sol:16-29), shared with server.ts for DvPFactory.create.
const LEG_TUPLE = '(address receiver, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)';
export const TERMS_TUPLE = `(bytes32 tradeId, address bond, bytes32 partition, uint256 bondAmount, address rd, uint256 rdAmount, address seller, address buyer, uint256 expiry, uint256 refundWindow, ${LEG_TUPLE} bondLeg, ${LEG_TUPLE} rdLeg)`;
export const termsTuple = (t: Terms) => ({ ...t, bondAmount: BigInt(t.bondAmount), rdAmount: BigInt(t.rdAmount), expiry: BigInt(t.expiry), refundWindow: BigInt(t.refundWindow) });

// ABIs inline (analyst verdict 2). Event/function signatures: src/ERC5564Announcer.sol, src/DvPFactory.sol, ERC1400 + ERC1400TokensValidator.
const abi = new Interface([
  'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)',
  'event EscrowCreated(bytes32 indexed tradeId, address indexed escrow)',
  'function balanceOf(address holder) view returns (uint256)',
  'function balanceOfByPartition(bytes32 partition, address holder) view returns (uint256)',
  'function generateDomainSeparator() view returns (bytes32)',
  'function usedCertificateNonce(address token, address sender) view returns (uint256)',
  'function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)', // ERC-6538 registry, src/ERC6538Registry.sol:22
  `function predict(${TERMS_TUPLE} t) view returns (address)`, // src/DvPFactory.sol:25
]);

export type ChainPortOptions = {
  provider: Provider;
  announcer: string; validator: string; dvpFactory: string; // contract addresses
  rd: string; bond: string; // announcements are read for these two tokens (caller topic)
  fromBlock: number; // isEscrow scans DvPFactory logs from here
  registry?: string; // public ERC-6538 registry address (registryMetaAddress only)
};

// JSON-RPC provider for the party's own Besu node; `token` (see rpcToken.ts) is called per request, so a short-lived JWT never goes stale.
// `tls` (S17, 2026-11-12 topology): the node is reached through the party's own bank-gw-N Besu door (mTLS + OPA method allowlist); the client cert is
// signed by that party's bank-gw CA, `servername` = bank-gw-N because bank-c dials an LB IP that is not in the gateway cert's SAN.
export function createProvider(url: string, chainId: bigint, token?: () => string, tls?: MtlsOptions): JsonRpcProvider {
  const req = new FetchRequest(url);
  if (token) req.preflightFunc = async (r) => { r.setHeader('Authorization', `Bearer ${token()}`); return r; };
  if (tls) req.getUrlFunc = FetchRequest.createGetUrlFunc({ agent: new Agent({ key: tls.key || undefined, cert: tls.cert || undefined, ca: tls.ca, servername: tls.servername }) });
  return new JsonRpcProvider(req, chainId, { staticNetwork: true });
}

export function createChainPort(o: ChainPortOptions): ChainPort {
  const p = o.provider;
  const at = (addr: string) => new Contract(addr, abi, p);
  const topic = (name: string) => abi.getEvent(name)!.topicHash;
  // eth_getLogs is capped (Besu: 1000 blocks), so read in LOG_RANGE chunks. Per filter, only the blocks after the last read are fetched again:
  // QBFT blocks are final (no reorg), so the earlier logs stay valid. ponytail: unbounded in-memory list, persist or prune if a party's logs grow large.
  const seen = new Map<string, { upTo: number; out: Log[] }>();
  async function logs(address: string, topics: (string | string[] | null)[], fromBlock: number) {
    const key = JSON.stringify([address, topics, fromBlock]);
    const c = seen.get(key) ?? { upTo: fromBlock - 1, out: [] };
    const end = await p.getBlockNumber();
    const out = [...c.out];
    for (let from = c.upTo + 1; from <= end; from += LOG_RANGE) out.push(...(await p.getLogs({ address, topics, fromBlock: from, toBlock: Math.min(from + LOG_RANGE - 1, end) })));
    if (end > c.upTo) seen.set(key, { upTo: end, out });
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
    async registryMetaAddress(identity) {
      if (!o.registry) throw new Error('registry address not configured');
      const v: string = await at(o.registry).stealthMetaAddressOf(identity, SCHEME_ID);
      return v === '0x' ? null : v;
    },
    async predictEscrow(t) { return at(o.dvpFactory).predict(termsTuple(t)); },
    async sendRawTransaction(raw) { return (await p.broadcastTransaction(raw)).hash; },
  };
}
