import type { LoggedAnnouncement } from '../../ts/chain.ts';

export type Keys = { spendKey: string; viewKey: string; identityKey: string }; // names = files of the S7 mount

export type SignerConfig = {
  party: string; // the one party this instance serves, e.g. "A"
  role: 'bank' | 'custodian'; // /cert is enabled for 'custodian' only (S12)
  chainId: bigint;
  rd: string; // RupiahDigital address
  bond: string; // DfabiBond address
  fromBlock: number; // announcements are read from here on
  certTtlSeconds?: number; // default 600 (ts/chain.ts:82)
};

// Everything the service needs from its own RPC node. Production adapts ethers' JsonRpcProvider; tests use a fake.
export interface ChainPort {
  announcements(fromBlock: number): Promise<LoggedAnnouncement[]>;
  balanceOf(token: string, holder: string, partition?: string): Promise<bigint>;
  nonce(address: string): Promise<number>;
  gasPrice(): Promise<bigint>;
  estimateGas(tx: { from: string; to: string; data: string }): Promise<bigint>;
  now(): Promise<bigint>; // latest block timestamp, unix seconds
  sendRawTransaction(raw: string): Promise<string>; // returns the tx hash
}

export type CertRequest = { sender: string; token: string; payload: string; expiry: bigint };
export interface CertClient {
  request(r: CertRequest): Promise<string>; // 97-byte certificate, hex
}

export type SignerDeps = { keys: Keys; chain: ChainPort; log: (line: string) => void; cert?: CertClient };
