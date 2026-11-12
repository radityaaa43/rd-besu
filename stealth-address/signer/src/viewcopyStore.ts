import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { ViewCopyFiles, ViewCopyStore } from './types.ts';

// S11 rework: BI's signer writes a pushed view-key copy into its own Secret `stealth-bi-viewcopies` through the kube API, with node:https only (no kube client library,
// no kubectl). One call: PATCH /api/v1/namespaces/<ns>/secrets/stealth-bi-viewcopies, merge-patch of the three keys `<id>.viewKey`, `<id>.metaAddress`, `<id>.identityAddress`.
// Token, CA and namespace come from the projected ServiceAccount files and are read per call (the token rotates). The Role allows get/patch/update on that one Secret.
// Nothing here logs or echoes: the request body holds the view key, the response body (the whole Secret) is dropped unread, errors carry the HTTP status only.
export const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
export const SECRET_NAME = 'stealth-bi-viewcopies';

export type StoreErrorKind = 'not_found' | 'forbidden' | 'unavailable' | 'unexpected';
export class ViewCopyStoreError extends Error {
  constructor(readonly kind: StoreErrorKind, readonly status: number | null, message: string) { super(message); this.name = 'ViewCopyStoreError'; }
}

export type ViewCopyStoreOptions = {
  dir?: string; // projected ServiceAccount directory: token, ca.crt, namespace
  env?: Record<string, string | undefined>; // KUBERNETES_SERVICE_HOST / KUBERNETES_SERVICE_PORT
  read?: (path: string) => string;
  request?: typeof httpsRequest;
};

export function createViewCopyStore(o: ViewCopyStoreOptions = {}): ViewCopyStore {
  const dir = o.dir ?? SA_DIR;
  const env = o.env ?? process.env;
  const read = o.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const request = o.request ?? httpsRequest;
  return {
    async put(id: string, files: ViewCopyFiles) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ViewCopyStoreError('unexpected', null, 'view copy id is not valid');
      let token: string, ca: string, ns: string;
      try { token = read(`${dir}/token`).trim(); ca = read(`${dir}/ca.crt`); ns = read(`${dir}/namespace`).trim(); }
      catch { throw new ViewCopyStoreError('unexpected', null, 'service account files unreadable'); }
      const host = env.KUBERNETES_SERVICE_HOST;
      if (!host || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns)) throw new ViewCopyStoreError('unexpected', null, 'kube API address or namespace missing');
      const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64');
      const body = JSON.stringify({ data: { [`${id}.viewKey`]: b64(files.viewKey), [`${id}.metaAddress`]: b64(files.metaAddress), [`${id}.identityAddress`]: b64(files.identityAddress) } });
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({
          host, port: Number(env.KUBERNETES_SERVICE_PORT ?? 443), method: 'PATCH', path: `/api/v1/namespaces/${ns}/secrets/${SECRET_NAME}`, ca,
          servername: 'kubernetes.default.svc', // the API server cert names the Service, not the IP the pod dials (ClusterIP or an endpoint IP)
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/merge-patch+json', accept: 'application/json', 'content-length': Buffer.byteLength(body) },
        }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); // the answer is the whole Secret: drop it unread
        req.on('error', () => reject(new ViewCopyStoreError('unavailable', null, 'kube API unreachable'))); // never the cause
        req.end(body);
      });
      if (status >= 200 && status < 300) return;
      if (status === 404) throw new ViewCopyStoreError('not_found', status, `kube API answered ${status}: the Secret ${SECRET_NAME} does not exist`);
      if (status === 401 || status === 403) throw new ViewCopyStoreError('forbidden', status, `kube API answered ${status}: the service account may not patch ${SECRET_NAME}`);
      throw new ViewCopyStoreError(status >= 500 ? 'unavailable' : 'unexpected', status, `kube API answered ${status}`);
    },
  };
}
