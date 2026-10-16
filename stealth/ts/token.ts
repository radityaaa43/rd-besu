import { concat, dataLength, getAddress, getBytes, hexlify, isAddress, toBeHex } from 'ethers';

// EIP-5564 ERC-20 announcement metadata, 57 bytes:
// viewTag (1) | transfer(address,uint256) selector (4) | token (20) | amount (32, big-endian).
const TRANSFER_SELECTOR = '0xa9059cbb';
const LENGTH = 57;

export function buildTokenMetadata(viewTag: string, token: string, amount: bigint): string {
  if (dataLength(viewTag) !== 1) throw new Error('viewTag must be 1 byte');
  if (!isAddress(token)) throw new Error('token must be an address');
  if (amount < 0n || amount >= 2n ** 256n) throw new Error('amount out of uint256 range');
  return concat([viewTag, TRANSFER_SELECTOR, token, toBeHex(amount, 32)]);
}

// Anyone can post any metadata, so this never throws: null means "not RD-style token metadata".
export function parseTokenMetadata(metadata: string): { viewTag: string; token: string; amount: bigint } | null {
  try {
    const b = getBytes(metadata);
    if (b.length !== LENGTH || hexlify(b.slice(1, 5)) !== TRANSFER_SELECTOR) return null;
    return {
      viewTag: hexlify(b.slice(0, 1)),
      token: getAddress(hexlify(b.slice(5, 25))),
      amount: BigInt(hexlify(b.slice(25))),
    };
  } catch {
    return null;
  }
}
