import type { LensView } from '../../../server/src/adapter.ts';
import type { PartyId } from '../../../server/src/domain.ts';

const NONE = 'Pihak tidak terbaca';

// One line per card: names come from /api/meta (`name`), never shortHash on a party.
export function counterpartyLine(l: Pick<LensView, 'role' | 'counterparty'>, dvp: boolean, name: (id: PartyId) => string): string {
  const cp = l.counterparty;
  if (cp === null) return NONE;
  const from = cp.from === null ? null : name(cp.from), to = cp.to === null ? null : name(cp.to);
  switch (l.role) {
    case 'issuer': return to ? `diterbitkan untuk ${to}` : NONE;
    case 'sender': return to ? `${dvp ? 'jual ke' : 'ke'} ${to}` : NONE;
    case 'receiver': return from ? `${dvp ? 'beli dari' : 'dari'} ${from}` : NONE;
    default: return from || to ? `${from ?? 'tidak terbaca'} → ${to ?? 'tidak terbaca'}` : NONE; // regulator reads both sides
  }
}
