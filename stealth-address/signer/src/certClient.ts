import type { CertClient } from './types.ts';

// POSTs {sender, token, payload, expiry} to `${url}/cert`, returns the certificate. `fetch` is injectable so the
// caller can supply an mTLS-configured one (mtls.ts).
export function createCertClient(opts: { url: string; fetch?: typeof fetch }): CertClient {
  const f = opts.fetch ?? fetch;
  return {
    async request(r) {
      const res = await f(`${opts.url.replace(/\/$/, '')}/cert`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sender: r.sender, token: r.token, payload: r.payload, expiry: r.expiry.toString() }),
      });
      if (!res.ok) throw new Error(`custodian answered ${res.status}`);
      const { certificate } = (await res.json()) as { certificate?: string };
      if (typeof certificate !== 'string') throw new Error('custodian answer has no certificate');
      return certificate;
    },
    async escrowCerts(t) {
      const res = await f(`${opts.url.replace(/\/$/, '')}/escrow-certs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) });
      if (!res.ok) throw new Error(`custodian answered ${res.status}`);
      const b = (await res.json()) as { escrow?: string; settleCert?: string; refundCert?: string };
      if (typeof b.escrow !== 'string' || typeof b.settleCert !== 'string' || typeof b.refundCert !== 'string') throw new Error('custodian answer incomplete');
      return { escrow: b.escrow, settleCert: b.settleCert, refundCert: b.refundCert };
    },
  };
}
