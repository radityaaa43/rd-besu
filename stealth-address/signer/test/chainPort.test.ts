// ChainPort adapter against a mocked ethers provider (no network). Production wiring (JsonRpcProvider, JWT) is not covered.
import { Interface, zeroPadValue, type Provider } from 'ethers';
import { describe, expect, it } from 'vitest';
import { createChainPort } from '../src/chainPort.ts';
import { BOND, RD } from './fixtures.ts';

const ann = new Interface(['event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)']);
const stealth = '0x' + '5a'.repeat(20);
const calls: Array<{ method: string; arg: any }> = [];
const provider = {
  getBlockNumber: async () => 2500,
  getLogs: async (f: any) => {
    calls.push({ method: 'getLogs', arg: f });
    if (f.fromBlock !== 0) return [];
    const e = ann.encodeEventLog('Announcement', [1n, stealth, RD, '0x02' + '11'.repeat(32), '0x01']);
    return [{ topics: e.topics, data: e.data, transactionHash: '0x' + '0'.repeat(63) + '1', blockNumber: 7 }];
  },
  call: async (tx: any) => { calls.push({ method: 'call', arg: tx }); return zeroPadValue('0x2a', 32); },
  getBlock: async () => ({ timestamp: 1_800_000_000 }),
} as unknown as Provider;
const port = createChainPort({ provider, announcer: '0x' + 'a1'.repeat(20), validator: '0x' + 'a2'.repeat(20), dvpFactory: '0x' + 'a3'.repeat(20), rd: RD, bond: BOND, fromBlock: 0 });

describe('createChainPort (mocked provider)', () => {
  it('announcements: reads in 1000-block chunks, filters caller to rd/bond, parses the event', async () => {
    const got = await port.announcements(0);
    expect(got).toEqual([{ schemeId: 1n, stealthAddress: expect.stringMatching(/^0x5a/i), ephemeralPubKey: '0x02' + '11'.repeat(32), metadata: '0x01', txHash: '0x' + '0'.repeat(63) + '1', blockNumber: 7, caller: expect.stringMatching(/^0x0+d1$/i) }]);
    const logs = calls.filter((c) => c.method === 'getLogs').map((c) => [c.arg.fromBlock, c.arg.toBlock]);
    expect(logs).toEqual([[0, 999], [1000, 1999], [2000, 2500]]);
    expect(calls[0].arg.topics[3]).toEqual([zeroPadValue(RD, 32), zeroPadValue(BOND, 32)]);
  });
  it('announcements: a repeat call reads only the blocks after the last one read (QBFT final: no reorg), and keeps the earlier logs', async () => {
    let head = 2500;
    const seen: Array<[number, number]> = [];
    const p = { ...provider, getBlockNumber: async () => head, getLogs: async (f: any) => { seen.push([f.fromBlock, f.toBlock]); return provider.getLogs(f); } } as unknown as Provider;
    const c = createChainPort({ provider: p, announcer: '0x' + 'a1'.repeat(20), validator: '0x' + 'a2'.repeat(20), dvpFactory: '0x' + 'a3'.repeat(20), rd: RD, bond: BOND, fromBlock: 0 });
    expect(await c.announcements(0)).toHaveLength(1);
    seen.length = 0;
    expect(await c.announcements(0)).toHaveLength(1);
    expect(seen).toEqual([]);
    head = 3100;
    expect(await c.announcements(0)).toHaveLength(1);
    expect(seen).toEqual([[2501, 3100]]);
  });
  it('balanceOf picks balanceOfByPartition when a partition is given; now() is the block timestamp', async () => {
    expect(await port.balanceOf(RD, stealth)).toBe(42n);
    expect(await port.balanceOf(BOND, stealth, '0x' + '01'.repeat(32))).toBe(42n);
    const sel = (i: number) => calls.filter((c) => c.method === 'call')[i].arg.data.slice(0, 10);
    expect(sel(0)).toBe(new Interface(['function balanceOf(address)']).getFunction('balanceOf')!.selector);
    expect(sel(1)).toBe(new Interface(['function balanceOfByPartition(bytes32,address)']).getFunction('balanceOfByPartition')!.selector);
    expect(await port.now()).toBe(1_800_000_000n);
  });
});

// S11 rework: the ERC-6538 registry read (same call as compareMain.ts) behind ChainPort.registryMetaAddress.
describe('registryMetaAddress (mocked provider)', () => {
  const regAbi = new Interface(['function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)']);
  const registry = '0x' + 'a4'.repeat(20);
  const identity = '0x' + '5b'.repeat(20);
  const meta = '0x' + '03'.repeat(33) + '02'.repeat(33);
  const portFor = (value: string, seen: Array<{ to: string; data: string }>, withRegistry = true) => createChainPort({
    provider: { call: async (tx: { to: string; data: string }) => { seen.push(tx); return regAbi.encodeFunctionResult('stealthMetaAddressOf', [value]); } } as unknown as Provider,
    announcer: '0x' + 'a1'.repeat(20), validator: '0x' + 'a2'.repeat(20), dvpFactory: '0x' + 'a3'.repeat(20), rd: RD, bond: BOND, fromBlock: 0,
    registry: withRegistry ? registry : undefined,
  });
  it('calls stealthMetaAddressOf(identity, 1) on the registry and returns the registered bytes', async () => {
    const seen: Array<{ to: string; data: string }> = [];
    expect(await portFor(meta, seen).registryMetaAddress(identity)).toBe(meta);
    expect(seen).toHaveLength(1);
    expect(seen[0].to.toLowerCase()).toBe(registry);
    expect(seen[0].data).toBe(regAbi.encodeFunctionData('stealthMetaAddressOf', [identity, 1n]));
  });
  it('an empty registry value (0x) is null', async () => {
    expect(await portFor('0x', []).registryMetaAddress(identity)).toBeNull();
  });
  it('without a configured registry address it rejects and makes no call', async () => {
    const seen: Array<{ to: string; data: string }> = [];
    await expect(portFor(meta, seen, false).registryMetaAddress(identity)).rejects.toThrow(/registry/);
    expect(seen).toEqual([]);
  });
});

// Stealth daily limit (2026-11-14): RD + bond ERC20 Transfer events (incremental, like announcements) and memoized block timestamps.
describe('transfers + blockTime (mocked provider)', () => {
  const erc20 = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  it('reads Transfer logs of both tokens up to the head, parses them; a block time is read once', async () => {
    const seen: any[] = [];
    let blocks = 0;
    const e = erc20.encodeEventLog('Transfer', [stealth, '0x' + 'ee'.repeat(20), 9n]);
    const p = {
      getBlockNumber: async () => 1200,
      getLogs: async (f: any) => { seen.push(f); return f.fromBlock === 0 ? [{ address: BOND, topics: e.topics, data: e.data, blockNumber: 5 }] : []; },
      getBlock: async (n: number) => { blocks++; return { timestamp: 1000 + n }; },
    } as unknown as Provider;
    const c = createChainPort({ provider: p, announcer: '0x' + 'a1'.repeat(20), validator: '0x' + 'a2'.repeat(20), dvpFactory: '0x' + 'a3'.repeat(20), rd: RD, bond: BOND, fromBlock: 0 });
    const t = await c.transfers(0);
    expect(t.upTo).toBe(1200);
    expect(t.rows).toEqual([{ token: BOND, from: expect.stringMatching(/^0x5a/i), to: expect.stringMatching(/^0xee/i), value: 9n, blockNumber: 5 }]);
    expect(seen[0].address).toEqual([RD, BOND]);
    expect(seen[0].topics).toEqual([erc20.getEvent('Transfer')!.topicHash]);
    expect(await c.blockTime(5)).toBe(1005n);
    expect(await c.blockTime(5)).toBe(1005n);
    expect(blocks).toBe(1);
  });
});
