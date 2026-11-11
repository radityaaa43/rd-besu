import type { CertClient } from './types.ts';

// POSTs {sender, token, payload, expiry} to `${url}/cert`, returns the certificate. `fetch` is injectable so the
// caller can supply an mTLS-configured one. RED stub.
export function createCertClient(_opts: { url: string; fetch?: typeof fetch }): CertClient {
  throw new Error('not implemented: createCertClient');
}
