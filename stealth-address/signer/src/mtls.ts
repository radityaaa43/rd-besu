// node:https based fetch with client key/cert/ca (analyst verdict 6: no undici). RED stub.
export type MtlsOptions = { key: string; cert: string; ca: string };
export function createMtlsFetch(_opts: MtlsOptions): typeof fetch {
  throw new Error('not implemented: createMtlsFetch');
}
