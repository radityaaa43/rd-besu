import type { LoggedAnnouncement } from '../../ts/chain.ts';
import type { ViewKeyHolder } from '../../ts/stealth.ts';

export type BankKeys = { spendKey: string; viewKey: string; identityKey: string }; // role bank: files of the S7 mount
export type CustodianKeys = { certKey: string }; // role custodian: the cert signer holds ONLY this (separate key + role, never a bank key)
// role bi: the issuer account key (RupiahDigital.issuer / DFABI minter; also BI's identity account, as in the Lensa adapter), BI's own receive keys, and one
// VIEW-key copy per bank (S11 fills them; never a spend key).
export type BiKeys = { issuerKey: string; spendKey: string; viewKey: string; viewCopies: ViewKeyHolder[] };
export type Keys = BankKeys | CustodianKeys | BiKeys; // role-dependent, enforced by createSigner and loadKeys

export type SignerConfig = {
  party: string; // the one party this instance serves, e.g. "A"
  role: 'bank' | 'custodian' | 'bi'; // /cert is enabled for 'custodian' only (S12); 'bi' = the S10 BI signer (issuer key, own receive keys, per-bank view copies)
  chainId: bigint;
  rd: string; // RupiahDigital address
  bond: string; // DfabiBond address
  fromBlock: number; // announcements are read from here on
  certTtlSeconds?: number; // default 600 (ts/chain.ts:82)
  bankSigners?: string[]; // custodian only: subjects of the mTLS client certs registered as bank signers
};

// Everything the service needs from its own RPC node. Production adapts ethers' JsonRpcProvider; tests use a fake.
export interface ChainPort {
  announcements(fromBlock: number): Promise<LoggedAnnouncement[]>;
  balanceOf(token: string, holder: string, partition?: string): Promise<bigint>;
  nonce(address: string): Promise<number>;
  gasPrice(): Promise<bigint>;
  estimateGas(tx: { from: string; to: string; data: string }): Promise<bigint>;
  now(): Promise<bigint>; // latest block timestamp, unix seconds
  // custodian reads these from the chain, never from the request (analyst verdict 1):
  bondDomainSeparator(): Promise<string>; // token.generateDomainSeparator()
  usedCertificateNonce(token: string, sender: string): Promise<bigint>; // validator.usedCertificateNonce
  isEscrow(address: string): Promise<boolean>; // created by OUR DvPFactory
  sendRawTransaction(raw: string): Promise<string>; // returns the tx hash
}

export type CertRequest = { sender: string; token: string; payload: string; expiry: bigint };
export interface CertClient {
  request(r: CertRequest): Promise<string>; // 97-byte certificate, hex
}

import type { IncomingMessage } from 'node:http';
// mTLS identity of the caller as seen by the TLS terminator (undefined = no client certificate)
export type PeerIdentity = (req: IncomingMessage) => { subject: string } | undefined;
export type SignerDeps = { keys: Keys; chain: ChainPort; log: (line: string) => void; cert?: CertClient; peer?: PeerIdentity };
