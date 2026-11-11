import { createSign } from 'node:crypto';

// Besu JWT auth (use-besu-api/authenticate): RS256, payload `permissions` + `exp`. Tokens are short-lived (<= 900 s) and minted
// from the node's private key file; the token is reused until 60 s before expiry. Errors never carry key text.
const TTL = 900;
const MARGIN = 60;
const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

export function createRpcTokenSource(privateKeyPem: string, now: () => number = () => Math.floor(Date.now() / 1000)): () => string {
  let token = '';
  let exp = 0;
  return () => {
    const t = now();
    if (token && exp - t > MARGIN) return token;
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ permissions: ['eth:*', 'net:*', 'web3:*'], iat: t, exp: t + TTL }));
    let sig: Buffer;
    try { sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem); } catch { throw new Error('rpc token: signing failed (check the RPC JWT key file)'); }
    token = `${head}.${body}.${b64u(sig)}`;
    exp = t + TTL;
    return token;
  };
}
