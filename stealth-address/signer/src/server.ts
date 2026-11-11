import type { Server } from 'node:http';
import type { SignerConfig, SignerDeps } from './types.ts';

// Returns an http.Server that is not listening yet. RED stub: S8 implementation replaces the body.
export function createSigner(_cfg: SignerConfig, _deps: SignerDeps): Server {
  throw new Error('not implemented: createSigner');
}
