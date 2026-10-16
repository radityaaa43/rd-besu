import { SigningKey, concat, dataLength, getAddress, getBytes, hexlify, isAddress, keccak256, toBeHex } from 'ethers';

// Announcement metadata of DfabiBond, 89 bytes:
// viewTag (1) | transferByPartition(bytes32,address,uint256,bytes) selector (4) | token (20) | amount (32) | partition (32),
// optionally followed by an encrypted sender memo (see memo.ts), at most MAX_MEMO bytes.
const TRANSFER_BY_PARTITION_SELECTOR = '0xf3d490db';
const LENGTH = 89;
const MAX_MEMO = 256;

export function buildBondMetadata(viewTag: string, token: string, amount: bigint, partition: string, memo = '0x'): string {
  if (dataLength(viewTag) !== 1) throw new Error('viewTag must be 1 byte');
  if (!isAddress(token)) throw new Error('token must be an address');
  if (amount < 0n || amount >= 2n ** 256n) throw new Error('amount out of uint256 range');
  if (dataLength(partition) !== 32) throw new Error('partition must be 32 bytes');
  if (dataLength(memo) > MAX_MEMO) throw new Error('memo longer than ' + MAX_MEMO + ' bytes');
  return concat([viewTag, TRANSFER_BY_PARTITION_SELECTOR, token, toBeHex(amount, 32), partition, memo]);
}

// Anyone can post any metadata, so this never throws: null means "not DfabiBond-style metadata (89-byte prefix, optional memo)".
export function parseBondMetadata(
  metadata: string,
): { viewTag: string; token: string; amount: bigint; partition: string; memo: string } | null {
  try {
    const b = getBytes(metadata);
    if (b.length < LENGTH || b.length > LENGTH + MAX_MEMO || hexlify(b.slice(1, 5)) !== TRANSFER_BY_PARTITION_SELECTOR) return null;
    return {
      viewTag: hexlify(b.slice(0, 1)),
      token: getAddress(hexlify(b.slice(5, 25))),
      amount: BigInt(hexlify(b.slice(25, 57))),
      partition: hexlify(b.slice(57, 89)),
      memo: hexlify(b.slice(89)),
    };
  } catch {
    return null;
  }
}

// ERC1400TokensValidator (nonce-based) signs the calldata minus its LAST 160 bytes: the 97-byte certificate
// padded to 128 plus the 32-byte length word. So the certificate must be the last ABI argument of the call.
export const CERTIFICATE_LENGTH = 97;
const CERTIFICATE_TAIL = 160;

// Pass calldata encoded with a 97-byte placeholder as the certificate; returns what the custodian signs over.
export function payloadWithoutCertificate(calldata: string): string {
  const b = getBytes(calldata);
  if (b.length <= CERTIFICATE_TAIL) throw new Error('calldata too short to carry a certificate');
  return hexlify(b.slice(0, b.length - CERTIFICATE_TAIL));
}

export type CertificateParams = {
  domainSeparator: string; // token.generateDomainSeparator()
  msgSender: string; // the holder that will send the transaction
  token: string;
  payload: string; // payloadWithoutCertificate(calldata)
  expiry: bigint; // unix seconds
  nonce: bigint; // validator.usedCertificateNonce(token, msgSender)
};

// keccak256(domainSeparator ++ keccak256(msgSender ++ token ++ payload ++ expiry ++ nonce)), packed encoding.
export function certificateDigest(p: CertificateParams): string {
  if (dataLength(p.domainSeparator) !== 32) throw new Error('domainSeparator must be 32 bytes');
  if (!isAddress(p.msgSender) || !isAddress(p.token)) throw new Error('msgSender and token must be addresses');
  if (p.expiry < 0n || p.expiry >= 2n ** 256n || p.nonce < 0n || p.nonce >= 2n ** 256n) {
    throw new Error('expiry and nonce must fit uint256');
  }
  const inner = keccak256(concat([p.msgSender, p.token, p.payload, toBeHex(p.expiry, 32), toBeHex(p.nonce, 32)]));
  return keccak256(concat([p.domainSeparator, inner]));
}

// 97 bytes: expiry (32) | r (32) | s (32) | v (1). Raw signature over the digest, no message prefix.
export function signCertificate(custodianKey: string, p: CertificateParams): string {
  const sig = new SigningKey(custodianKey).sign(certificateDigest(p));
  return concat([toBeHex(p.expiry, 32), sig.r, sig.s, toBeHex(sig.v, 1)]);
}
