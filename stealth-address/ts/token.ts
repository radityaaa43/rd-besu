import { concat, dataLength, getAddress, getBytes, hexlify, isAddress, toBeHex } from 'ethers';

// EIP-5564 ERC-20 announcement metadata, 57 bytes:
// viewTag (1) | transfer(address,uint256) selector (4) | token (20) | amount (32, big-endian),
// optionally followed by an encrypted sender memo (see memo.ts), at most MAX_MEMO bytes.
const TRANSFER_SELECTOR = '0xa9059cbb';
const LENGTH = 57;
const MAX_MEMO = 256;

export function buildTokenMetadata(viewTag: string, token: string, amount: bigint, memo = '0x'): string {
  if (dataLength(viewTag) !== 1) throw new Error('viewTag must be 1 byte');
  if (!isAddress(token)) throw new Error('token must be an address');
  if (amount < 0n || amount >= 2n ** 256n) throw new Error('amount out of uint256 range');
  if (dataLength(memo) > MAX_MEMO) throw new Error('memo longer than ' + MAX_MEMO + ' bytes');
  return concat([viewTag, TRANSFER_SELECTOR, token, toBeHex(amount, 32), memo]);
}

// Anyone can post any metadata, so this never throws: null means "not RD-style token metadata (57-byte prefix, optional memo)".
export function parseTokenMetadata(
  metadata: string,
): { viewTag: string; token: string; amount: bigint; memo: string } | null {
  try {
    const b = getBytes(metadata);
    if (b.length < LENGTH || b.length > LENGTH + MAX_MEMO || hexlify(b.slice(1, 5)) !== TRANSFER_SELECTOR) return null;
    return {
      viewTag: hexlify(b.slice(0, 1)),
      token: getAddress(hexlify(b.slice(5, 25))),
      amount: BigInt(hexlify(b.slice(25, 57))),
      memo: hexlify(b.slice(57)),
    };
  } catch {
    return null;
  }
}
