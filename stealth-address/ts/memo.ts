import { secp256k1 } from '@noble/curves/secp256k1';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { SigningKey, computeAddress, concat, getAddress, getBytes, hexlify, keccak256, recoverAddress, toBeHex, toUtf8Bytes } from 'ethers';

// Encrypted sender memo, appended to the announcement metadata AFTER the fixed RD (57) / DFABI (89) prefix.
//   memo = version (1) | AES-256-GCM ciphertext (85) | tag (16) = 102 bytes
//   plaintext = sender identity address (20) | signature r,s,v (65) over memoDigest(ctx)
// Key = keccak256("RD-memo-v1" || ECDH point), the same point EIP-5564 uses, so the receiver's VIEW key opens it
// (BI holds that view key too) and nobody else can. Nonce = first 12 bytes of keccak256("RD-memo-nonce" || ephemeralPubKey);
// that is unique per announcement because every announcement uses a fresh ephemeral key (never reuse one).
// The sender identity is a bank's identity key. Which addresses are real banks is an off-chain list (BI's onboarding).
export const MEMO_VERSION = 1;
export const MAX_MEMO_LENGTH = 256; // same bound the contracts enforce
const PLAINTEXT_LENGTH = 85;

export type MemoContext = {
  chainId: bigint;
  token: string;
  stealthAddress: string;
  amount: bigint;
  ephemeralPubKey: string;
  partition?: string; // DFABI only
};

// What the sender signs: binds the memo to exactly one payment, so it cannot be replayed onto another.
export function memoDigest(c: MemoContext): string {
  return keccak256(
    concat([
      toUtf8Bytes('RD-memo-sig-v1'),
      toBeHex(c.chainId, 32),
      c.token,
      c.stealthAddress,
      toBeHex(c.amount, 32),
      c.ephemeralPubKey,
      c.partition ?? '0x',
    ]),
  );
}

const secret = (priv: string, pub: string) => secp256k1.getSharedSecret(getBytes(priv), getBytes(pub), true);
const memoKey = (point: Uint8Array) => getBytes(keccak256(concat([toUtf8Bytes('RD-memo-v1'), point])));
const nonceOf = (ephemeralPubKey: string) => getBytes(keccak256(concat([toUtf8Bytes('RD-memo-nonce'), ephemeralPubKey]))).slice(0, 12);
const AAD = Uint8Array.of(MEMO_VERSION);

// Low-level: encrypt a plaintext for the receiver. buildMemo is the normal entry point; this is exported so tests can
// build a well-encrypted memo with a forged plaintext.
export function encryptMemo(plaintext: Uint8Array, ephemeralKey: string, receiverMetaAddress: string): string {
  const raw = getBytes(receiverMetaAddress.split(':').pop()!);
  if (raw.length !== 66) throw new Error('meta-address must be 66 bytes (spend pubkey || view pubkey)');
  const ephPub = hexlify(secp256k1.getPublicKey(getBytes(ephemeralKey), true));
  const c = createCipheriv('aes-256-gcm', memoKey(secret(ephemeralKey, hexlify(raw.slice(33)))), nonceOf(ephPub));
  c.setAAD(AAD);
  return hexlify(concat([AAD, c.update(plaintext), c.final(), c.getAuthTag()]));
}

export function buildMemo(p: { senderKey: string; ephemeralKey: string; receiverMetaAddress: string; ctx: MemoContext }): string {
  const ephPub = hexlify(secp256k1.getPublicKey(getBytes(p.ephemeralKey), true));
  if (ephPub !== p.ctx.ephemeralPubKey.toLowerCase()) throw new Error('ctx.ephemeralPubKey is not the public key of ephemeralKey');
  const sig = new SigningKey(p.senderKey).sign(memoDigest(p.ctx));
  const plaintext = getBytes(concat([computeAddress(p.senderKey), sig.r, sig.s, toBeHex(sig.v, 1)]));
  return encryptMemo(plaintext, p.ephemeralKey, p.receiverMetaAddress);
}

// Receiver or BI: opens the memo with the receiver's view key. Returns the authenticated sender, or null if the memo is
// not for this key, was tampered with, belongs to another payment, or the signature is not by the claimed sender.
export function openMemo(memo: string, viewKey: string, ctx: MemoContext): { sender: string } | null {
  try {
    const b = getBytes(memo);
    if (b.length !== 1 + PLAINTEXT_LENGTH + 16 || b[0] !== MEMO_VERSION) return null;
    const d = createDecipheriv('aes-256-gcm', memoKey(secret(viewKey, ctx.ephemeralPubKey)), nonceOf(ctx.ephemeralPubKey));
    d.setAAD(AAD);
    d.setAuthTag(b.slice(1 + PLAINTEXT_LENGTH));
    const plain = Buffer.concat([d.update(b.slice(1, 1 + PLAINTEXT_LENGTH)), d.final()]);
    const sender = getAddress(hexlify(plain.subarray(0, 20)));
    const sigBytes = plain.subarray(20);
    const signer = recoverAddress(memoDigest(ctx), { r: hexlify(sigBytes.subarray(0, 32)), s: hexlify(sigBytes.subarray(32, 64)), v: sigBytes[64] });
    return signer === sender ? { sender } : null;
  } catch {
    return null; // GCM failure, bad hex, bad key: anyone can post garbage, so this is noise, not an error
  }
}
