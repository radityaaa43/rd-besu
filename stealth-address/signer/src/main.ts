// Process entrypoint (S9 wires it into the Deployment). Not unit-tested: needs a real RPC node and key files.
// Env: PARTY, ROLE (bank|custodian|bi), PORT, CHAIN_ID, RD, BOND, ANNOUNCER, VALIDATOR, DVP_FACTORY, FROM_BLOCK, RPC_URL, RPC_TLS_DIR + RPC_SERVERNAME (optional: mTLS to the own bank-gw door),
// RPC_JWT_KEY_FILE (optional: the node's RS256 private key; the signer mints <= 900 s tokens from it), KEYS_DIR (bank: files spendKey, viewKey, identityKey; bi: issuerKey, spendKey, viewKey + the view copies <id>.viewKey and <id>.metaAddress from VIEWCOPIES_DIR (default ${KEYS_DIR}/viewcopies; a missing directory means no copies); custodian: file certKey ONLY),
// VIEWCOPIES_DIR (bi only, optional): directory of the per-bank view copies, e.g. the mount of the optional Secret stealth-bi-viewcopies.
// REGISTRY (bi only, optional): public ERC-6538 registry address; with it `PUT /viewcopy/<id>` checks the pushed copy against the registry. The write of a pushed copy
// uses the projected ServiceAccount of the pod (token, ca.crt, namespace) and the Role on the one Secret stealth-bi-viewcopies.
// bank and bi: CERT_URL + optional CERT_SERVERNAME + TLS_DIR (client.key, client.crt, ca.crt); custodian: TLS_DIR (server.key, server.crt, ca.crt) + BANK_SIGNERS (comma list of "CN=...").
import { readFileSync } from 'node:fs';
import { createServer as createHttps } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { createCertClient } from './certClient.ts';
import { createChainPort, createProvider } from './chainPort.ts';
import { loadKeys } from './keys.ts';
import { createRpcTokenSource } from './rpcToken.ts';
import { createMtlsFetch } from './mtls.ts';
import { createSigner } from './server.ts';
import { createViewCopyStore } from './viewcopyStore.ts';
import type { SignerConfig } from './types.ts';

const env = (n: string) => process.env[n] ?? (() => { throw new Error(`missing env ${n}`); })();
const file = (dir: string, n: string) => readFileSync(`${dir}/${n}`, 'utf8').trim();

const role = env('ROLE') as 'bank' | 'custodian' | 'bi';
if (role !== 'bank' && role !== 'custodian' && role !== 'bi') throw new Error('ROLE must be bank, custodian or bi');
const cfg: SignerConfig = {
  party: env('PARTY'), role, chainId: BigInt(env('CHAIN_ID')), rd: env('RD'), bond: env('BOND'), fromBlock: Number(env('FROM_BLOCK')),
  bankSigners: process.env.BANK_SIGNERS?.split(',').map((s) => s.trim()).filter(Boolean),
  biSigner: process.env.BI_SIGNER || undefined, // custodian: "CN=..." of the BI signer's client cert, the only caller of /escrow-certs (S17 DvP)
  announcer: env('ANNOUNCER'),
  dvpFactory: env('DVP_FACTORY'), // bi: DvPFactory.create is sent by the issuer account (the factory's immutable custodian)
};
const dir = env('KEYS_DIR');
const keys = loadKeys(role, dir, undefined, undefined, process.env.VIEWCOPIES_DIR || undefined); // role custodian: certKey ONLY; role bank: spend/view/identity, never certKey

const jwt = process.env.RPC_JWT_KEY_FILE ? createRpcTokenSource(readFileSync(process.env.RPC_JWT_KEY_FILE, 'utf8')) : undefined;
// RPC_TLS_DIR (client.key, client.crt, ca.crt) + RPC_SERVERNAME (bank-gw-N): RPC_URL is the party's own bank-gw Besu door (S17, 2026-11-12 topology).
const rpcTls = process.env.RPC_TLS_DIR;
const chain = createChainPort({
  provider: createProvider(env('RPC_URL'), cfg.chainId, jwt, rpcTls ? { key: file(rpcTls, 'client.key'), cert: file(rpcTls, 'client.crt'), ca: file(rpcTls, 'ca.crt'), servername: process.env.RPC_SERVERNAME } : undefined),
  announcer: env('ANNOUNCER'), validator: env('VALIDATOR'), dvpFactory: env('DVP_FACTORY'), rd: cfg.rd, bond: cfg.bond, fromBlock: cfg.fromBlock, registry: process.env.REGISTRY || undefined,
});
const log = (line: string) => process.stdout.write(line + '\n');
const tls = process.env.TLS_DIR;

const certClient = role !== 'custodian' && process.env.CERT_URL && tls
  ? createCertClient({ url: process.env.CERT_URL, fetch: createMtlsFetch({ key: file(tls, 'client.key'), cert: file(tls, 'client.crt'), ca: file(tls, 'ca.crt'), servername: process.env.CERT_SERVERNAME }) })
  : undefined;
const peer = (req: import('node:http').IncomingMessage) => {
  const cn = (req.socket as TLSSocket).getPeerCertificate?.()?.subject?.CN;
  return cn ? { subject: `CN=${cn}` } : undefined;
};
const app = createSigner(cfg, { keys, chain, log, cert: certClient, peer, viewCopyStore: role === 'bi' ? createViewCopyStore() : undefined });
const port = Number(process.env.PORT ?? 8080);

if (role === 'custodian') {
  if (!tls) throw new Error('custodian needs TLS_DIR (mTLS is the only caller authentication)');
  // Same handler behind an https listener that demands a client cert signed by ca.crt.
  createHttps({ key: file(tls, 'server.key'), cert: file(tls, 'server.crt'), ca: file(tls, 'ca.crt'), requestCert: true, rejectUnauthorized: true },
    (req, res) => app.emit('request', req, res)).listen(port, () => log(`stealth-signer custodian ${cfg.party} on ${port}`));
} else {
  // Warm before listening (Recreate: no pod serves meanwhile; liveness allows 60 s). A failed warm-up is logged; the first calls fill the caches then.
  await app.warm().catch((e) => log(`warm-up failed err=${(e as Error).name}`));
  app.listen(port, () => log(`stealth-signer bank ${cfg.party} on ${port}`));
}
