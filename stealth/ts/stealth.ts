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

export function generateMetaAddress() {
  const spendKey = hexlify(secp256k1.utils.randomPrivateKey());
  const viewKey = hexlify(secp256k1.utils.randomPrivateKey());
  return { spendKey, viewKey, metaAddress: hexlify(concat([pubOf(spendKey), pubOf(viewKey)])) };
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

export function scan(announcements: Announcement[], viewKey: string, spendKey: string): Found[] {
  const spendPub = pubOf(spendKey);
  pubOf(viewKey); // fail loudly on a bad view key rather than skipping every announcement
  const found: Found[] = [];
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
      const k = (BigInt(spendKey) + BigInt(h)) % N;
      found.push({ stealthAddress, privateKey: '0x' + k.toString(16).padStart(64, '0') });
    } catch {
      // Anyone can announce garbage; malformed entries are noise, not errors.
    }
  }
  return found;
}
