import { BANKS, type PartyId } from '../domain.ts';
import { writeState } from '../state.ts';
import { LOOKUP, createZetoAdapter, type ZetoState } from '../adapters/zeto.ts';
import {
  IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X, PaladinClient, algorithmZetoSnarkBJJ, deployToken, newAtomFactory, newGroup, nodeConnections, party, within,
} from '../../../../zeto/src/flows.ts';

// Fresh deployment owned by this app: bi@node1 deploys RD and DFABI (Zeto_Anon, never setERC20),
// one Pente group {bank, BI} per bank, an AtomFactory, then private opening balances.
// Run under the cluster lock: flock /tmp/lensa-paladin.lock npm run bootstrap -- zeto
export async function bootstrap(): Promise<void> {
  const clients = nodeConnections.map((n) => new PaladinClient(n.clientOptions));
  const P = Object.fromEntries((Object.keys(LOOKUP) as PartyId[]).map((id) => [id, party(clients, LOOKUP[id])])) as Record<PartyId, ReturnType<typeof party>>;
  const fromBlock = await P.BI.c.bidx.getConfirmedBlockHeight();

  const rd = (await deployToken(P.BI)).address;
  const dfabi = (await deployToken(P.BI)).address;
  console.log(`RD ${rd}\nDFABI ${dfabi}`);
  const atomFactory = (await within(newAtomFactory(P.BI.c, P.BI.v), 120_000, 'Deploy AtomFactory'))?.address;
  if (!atomFactory) throw new Error('AtomFactory gagal dibuat');
  // Saved as soon as the contracts exist, so a failed run does not orphan them (funded:false => load() ignores it).
  writeState('zeto', { rd, dfabi, atomFactory, fromBlock, privateMint: true, funded: false });

  const groups = {} as ZetoState['groups'];
  for (const b of BANKS) {
    groups[b] = await newGroup(P[b], P.BI, `lensa-zeto-${b}-${Date.now()}`);
    console.log(`group {${LOOKUP[b]}, ${LOOKUP.BI}} ${groups[b]}`);
  }

  const owners = {} as ZetoState['owners'];
  const addresses = {} as ZetoState['addresses'];
  for (const id of Object.keys(LOOKUP) as PartyId[]) {
    owners[id] = await P.BI.c.ptx.resolveVerifier(LOOKUP[id], algorithmZetoSnarkBJJ('zeto'), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X);
    addresses[id] = await P.BI.c.ptx.resolveVerifier(LOOKUP[id], 'ecdsa:secp256k1', 'eth_address');
  }

  const state: ZetoState = { rd, dfabi, atomFactory, groups, owners, addresses, fromBlock, privateMint: true, funded: false };
  writeState('zeto', state);
  const adapter = createZetoAdapter(state);
  for (const b of BANKS) { // sequential: one Zeto tx at a time
    await adapter.fund(b, 'RD', 5, 10n ** 9n);
    await adapter.fund(b, 'DFABI', 5, 1000n);
    console.log(`saldo awal ${b}: RD ${await adapter.balanceOf(b, 'RD')}, DFABI ${await adapter.balanceOf(b, 'DFABI')}`);
  }
  writeState('zeto', { ...state, funded: true });
  console.log('state/zeto.json ditulis');
}
