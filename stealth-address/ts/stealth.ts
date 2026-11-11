import { secp256k1 } from '@noble/curves/secp256k1';
import { computeAddress, concat, getBytes, hexlify, keccak256 } from 'ethers';

// ERC-5564 scheme 1 (secp256k1 + view tags). Derivation matches the ScopeLift stealth-address-sdk:
// h = keccak256(compressed ECDH point), view tag = first byte of h.
const Point = secp256k1.ProjectivePoint;
const N = secp256k1.CURVE.n;

export const SCHEME_ID = 1n;

export type Announcement = { schemeId: bigint; stealthAddress: string; ephemeralPubKey: string; metadata: string };
export type Found = { stealthAddress: string; privateKey: string };

const pubOf = (priv: string) => secp256k1.getPublicKey(getBytes(priv), true);
const hashShared = (priv: string, pub: Uint8Array) => keccak256(secp256k1.getSharedSecret(getBytes(priv), pub, true));
const addressOf = (spendPub: Uint8Array, h: string) =>
  computeAddress('0x' + Point.fromHex(spendPub).add(Point.BASE.multiply(BigInt(h) % N)).toHex(false));

export const metaAddressOf = (spendKey: string, viewKey: string) => hexlify(concat([pubOf(spendKey), pubOf(viewKey)]));

export function generateMetaAddress() {
  const spendKey = hexlify(secp256k1.utils.randomPrivateKey());
  const viewKey = hexlify(secp256k1.utils.randomPrivateKey());
  return { spendKey, viewKey, metaAddress: metaAddressOf(spendKey, viewKey) };
}

// ephemeralKey is only for deterministic tests; production callers omit it.
export function deriveStealth(metaAddress: string, ephemeralKey = hexlify(secp256k1.utils.randomPrivateKey())) {
  const raw = getBytes(metaAddress.split(':').pop()!); // accepts "st:eth:0x..." or "0x..."
  if (raw.length !== 66) throw new Error('meta-address must be 66 bytes (spend pubkey || view pubkey)');
  const h = hashShared(ephemeralKey, raw.slice(33));
  return {
    stealthAddress: addressOf(raw.slice(0, 33), h), // throws if the spend key is not a curve point
    ephemeralPubKey: hexlify(pubOf(ephemeralKey)),
    viewTag: h.slice(0, 4),
  };
}

type Match = { announcement: Announcement; h: string; stealthAddress: string };

// Core of every scan: announcements that belong to (viewKey, spendPub). Needs no spend private key.
function* matches(announcements: Announcement[], viewKey: string, spendPub: Uint8Array): Generator<Match> {
  const seen = new Set<string>(); // anyone can re-post a real announcement
  for (const a of announcements) {
    try {
      if (BigInt(a.schemeId) !== SCHEME_ID) continue; // BigInt() tolerates 1 / "1" from JSON
      const h = hashShared(viewKey, getBytes(a.ephemeralPubKey));
      if (getBytes(a.metadata)[0] !== getBytes(h)[0]) continue; // view tag; empty metadata never matches
      const stealthAddress = addressOf(spendPub, h);
      if (stealthAddress.toLowerCase() !== a.stealthAddress.toLowerCase()) continue;
      if (seen.has(stealthAddress.toLowerCase())) continue;
      seen.add(stealthAddress.toLowerCase());
      yield { announcement: a, h, stealthAddress };
    } catch {
      // Anyone can announce garbage; malformed entries are noise, not errors.
    }
  }
}

export function scan(announcements: Announcement[], viewKey: string, spendKey: string): Found[] {
  const spendPub = pubOf(spendKey);
  pubOf(viewKey); // fail loudly on a bad view key rather than skipping every announcement
  return [...matches(announcements, viewKey, spendPub)].map(({ h, stealthAddress }) => {
    const k = (BigInt(spendKey) + BigInt(h)) % N;
    return { stealthAddress, privateKey: '0x' + k.toString(16).padStart(64, '0') };
  });
}

export type ViewKeyHolder = { id: string; viewKey: string; metaAddress: string };

// For a party that holds a bank's VIEW key (BI, the DFABI custodian) but never its spend key: it can tell which
// announcements are for that bank, not move the funds. The view key must belong to the meta-address.
export function scanView(announcements: Announcement[], holder: ViewKeyHolder): Announcement[] {
  const raw = getBytes(holder.metaAddress.split(':').pop()!);
  if (raw.length !== 66) throw new Error('meta-address must be 66 bytes (spend pubkey || view pubkey)');
  if (hexlify(pubOf(holder.viewKey)) !== hexlify(raw.slice(33))) throw new Error(`view key does not match meta-address of ${holder.id}`);
  return [...matches(announcements, holder.viewKey, raw.slice(0, 33))].map((m) => m.announcement);
}

// Which bank received each announcement. An announcement for an unknown bank is simply absent from the result.
export function scanAll(announcements: Announcement[], holders: ViewKeyHolder[]): { bank: string; announcement: Announcement }[] {
  return holders.flatMap((h) => scanView(announcements, h).map((announcement) => ({ bank: h.id, announcement })));
}
