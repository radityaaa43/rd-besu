import { createSign } from 'node:crypto';

// Besu JWT auth (use-besu-api/authenticate): RS256, payload `permissions` + `exp`. Tokens are short-lived (<= 900 s) and minted
// from the node's private key file; the token is reused until 60 s before expiry. Errors never carry key text.
const TTL = 900;
const MARGIN = 60;
const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

// RS256 JWT with EXACTLY the given Besu permissions and exp = now + ttlSeconds. Errors never carry key text.
export function mintScopedToken(privateKeyPem: string, permissions: string[], ttlSeconds: number, now: () => number = () => Math.floor(Date.now() / 1000)): string {
  const t = now();
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ permissions, iat: t, exp: t + ttlSeconds }));
  let sig: Buffer;
  try { sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem); } catch { throw new Error('rpc token: signing failed (check the RPC JWT key file)'); }
  return `${head}.${body}.${b64u(sig)}`;
}

export function createRpcTokenSource(privateKeyPem: string, now: () => number = () => Math.floor(Date.now() / 1000)): () => string {
  let token = '';
  let exp = 0;
  return () => {
    const t = now();
    if (token && exp - t > MARGIN) return token;
    token = mintScopedToken(privateKeyPem, ['eth:*', 'net:*', 'web3:*'], TTL, () => t);
    exp = t + TTL;
    return token;
  };
}
