import { request } from 'node:https';

// node:https based fetch with client key/cert/ca (analyst verdict 6: no undici). Only what certClient needs:
// url, method, headers, string body; returns a standard Response.
export type MtlsOptions = { key: string; cert: string; ca: string };
export function createMtlsFetch(opts: MtlsOptions): typeof fetch {
  return ((input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const req = request(String(input instanceof Request ? input.url : input), {
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string> | undefined,
        key: opts.key || undefined, cert: opts.cert || undefined, ca: opts.ca,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(init.body as string | undefined);
    })) as typeof fetch;
}
