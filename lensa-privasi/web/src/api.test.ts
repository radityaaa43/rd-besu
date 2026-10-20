import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { stopStress, watchTx } from './api.ts';

class FakeES {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
  static last: FakeES;
  readyState = FakeES.CONNECTING;
  closed = false;
  handlers = new Map<string, (e: unknown) => void>();
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(name: string, h: (e: unknown) => void) { this.handlers.set(name, h); }
  close() { this.closed = true; this.readyState = FakeES.CLOSED; }
  emit(name: string, e: unknown = {}) { this.handlers.get(name)?.(e); }
}

beforeEach(() => vi.stubGlobal('EventSource', FakeES));
afterEach(() => vi.unstubAllGlobals());

const handlers = () => ({ onStep: vi.fn(), onResult: vi.fn(), onError: vi.fn() });

test('a dropped stream that the browser gave up on reports an error and closes', () => {
  const h = handlers();
  watchTx('r1', h);
  FakeES.last.readyState = FakeES.CLOSED;
  FakeES.last.emit('error');
  expect(h.onError).toHaveBeenCalledWith('Koneksi ke server terputus');
  expect(FakeES.last.closed).toBe(true);
});

test('a transport error while the browser is retrying keeps waiting', () => {
  const h = handlers();
  watchTx('r1', h);
  FakeES.last.readyState = FakeES.CONNECTING;
  FakeES.last.emit('error');
  expect(h.onError).not.toHaveBeenCalled();
  expect(FakeES.last.closed).toBe(false);
});

test('a server error event passes its reason through and closes', () => {
  const h = handlers();
  watchTx('r1', h);
  FakeES.last.emit('error', { data: JSON.stringify({ reason: 'Saldo tidak cukup' }) });
  expect(h.onError).toHaveBeenCalledWith('Saldo tidak cukup');
  expect(FakeES.last.closed).toBe(true);
});

test('a POST without a body sends no content-type (Fastify rejects an empty JSON body)', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
  await stopStress();
  expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'POST' });
});
