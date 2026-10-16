# Stealth core (ERC-5564 + ERC-6538) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the stealth-address core for privacy-enabled RD + DFABI on Besu: an ERC-5564 Announcer, an ERC-6538 Registry, and a TypeScript library (`generateMetaAddress`, `deriveStealth`, `scan`), proven on the ACK Besu network.

**Architecture:** Two tiny Solidity contracts written from the EIP interfaces (no storage in the Announcer, one mapping pair in the Registry). A pure-function TypeScript library implementing ERC-5564 scheme 1 with `@noble/curves` and `ethers`. A one-off smoke script that runs the whole send/receive flow against Besu and records chain id and gas price.

**Tech Stack:** Solidity ^0.8.20 (evm `shanghai`), Foundry (`forge test`), TypeScript, `ethers` 6.17.0, `@noble/curves` 1.2.0, vitest 2.

**Spec:** `docs/superpowers/specs/2026-10-15-stealth-core-design.md`

## Global Constraints

- Scheme id `1` only (secp256k1 with view tags). Meta-address = 33-byte compressed spend pubkey || 33-byte compressed view pubkey (66 bytes).
- `h = keccak256(compressed ECDH point, 33 bytes)`; view tag = first byte of `h`; stealth pubkey = `P_spend + h*G`; stealth private key = `(k_spend + h) mod n`. (Spec section 5, corrected 2026-10-15 after reading the ScopeLift SDK.)
- Announcement `metadata` is the 1-byte view tag only.
- Contracts written by us from the EIP interfaces. No copied code. SPDX `Apache-2.0`, `pragma solidity ^0.8.20`, `evm_version = "shanghai"`.
- `registerKeysOnBehalf` (EIP-712) is NOT implemented. Do not add it.
- No new libraries: `ethers` 6.17.0 and `@noble/curves` 1.2.0 only (vitest and typescript as dev tools, same majors as `backend/shared`).
- All code lives under the new top-level `stealth/`. Do not touch `Paladin/` or `backend/`.
- Never print or `cat` any `.env*` file. The smoke script reads its secrets from env vars only.

## Review Focus

1. Noise announcements (short `ephemeralPubKey`, empty `metadata`, non-address `stealthAddress`) must be skipped by `scan`, never throw. Anyone can call `announce` with garbage. (Task 2)
2. Announcement whose view tag matches but whose stealth address does not (the 1-in-256 collision) must not be returned. (Task 2)
3. A wrong-length or off-curve meta-address must make `deriveStealth` throw, never return an address nobody can spend from. (Task 2)
4. Registry: re-registering a scheme overwrites; one registrant cannot affect another; non-scheme-1 ids accept any length; nonces are per registrant. (Task 1)
5. Two payments to the same recipient must produce two different stealth addresses and `scan` must find both. (Task 2)

---

### Task 1: Contracts and Foundry tests

**Files:**
- Create: `stealth/foundry.toml`
- Create: `stealth/src/ERC5564Announcer.sol`
- Create: `stealth/src/ERC6538Registry.sol`
- Create: `stealth/test/ERC5564Announcer.t.sol`
- Create: `stealth/test/ERC6538Registry.t.sol`

**Interfaces:**
- Consumes: nothing.
- Produces (Task 3 relies on these exact names, and on `forge build` writing `stealth/out/<Name>.sol/<Name>.json` with `abi` and `bytecode.object`):
  - `ERC5564Announcer`: `event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)`; `function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata) external`
  - `ERC6538Registry`: `error InvalidMetaAddressLength()`; `event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress)`; `event NonceIncremented(address indexed registrant, uint256 newNonce)`; `function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external`; `function incrementNonce() external`; `stealthMetaAddressOf(address,uint256) returns (bytes)`; `nonceOf(address) returns (uint256)`

The repo's other Foundry projects (`Paladin/contracts`) have no `forge-std`; they declare a minimal inline `Vm` interface. Do the same.

- [ ] **Step 1: Create `stealth/foundry.toml`**

```toml
[profile.default]
src = "src"
test = "test"
out = "out"
libs = []

# Same evmVersion the rest of this repo's contracts use (Paladin/contracts/foundry.toml).
# Confirm it deploys on the ACK Besu network in Task 3.
evm_version = "shanghai"
```

- [ ] **Step 2: Write the failing Announcer test**

`stealth/test/ERC5564Announcer.t.sol`:

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC5564Announcer} from "../src/ERC5564Announcer.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool) external;
    function prank(address) external;
}

contract ERC5564AnnouncerTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    ERC5564Announcer a;

    function setUp() public {
        a = new ERC5564Announcer();
    }

    function test_announce_emits_with_msg_sender_as_caller() public {
        address stealth = address(0xBEEF);
        address sender = address(0xCAFE);
        bytes memory eph = hex"02aa";
        bytes memory meta = hex"20";
        vm.expectEmit(true, true, true, true);
        emit Announcement(1, stealth, sender, eph, meta);
        vm.prank(sender);
        a.announce(1, stealth, eph, meta);
    }

    // Anyone may announce anything, including empty metadata (the standard requires it to be open).
    function test_announce_accepts_empty_metadata() public {
        vm.expectEmit(true, true, true, true);
        emit Announcement(1, address(0xBEEF), address(this), hex"02", "");
        a.announce(1, address(0xBEEF), hex"02", "");
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd stealth && forge test --match-contract ERC5564AnnouncerTest`
Expected: FAIL to compile, `ERC5564Announcer.sol` not found.

- [ ] **Step 4: Write the Announcer**

`stealth/src/ERC5564Announcer.sol`:

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @notice ERC-5564 Announcer. No storage, no access control: the standard requires it to be open.
contract ERC5564Announcer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external
    {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd stealth && forge test --match-contract ERC5564AnnouncerTest`
Expected: 2 passed.

- [ ] **Step 6: Write the failing Registry test**

`stealth/test/ERC6538Registry.t.sol`:

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC6538Registry} from "../src/ERC6538Registry.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool) external;
    function expectRevert(bytes4) external;
    function prank(address) external;
}

contract ERC6538RegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress);
    event NonceIncremented(address indexed registrant, uint256 newNonce);

    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    ERC6538Registry r;

    function setUp() public {
        r = new ERC6538Registry();
    }

    function _meta(uint8 fill, uint256 len) internal pure returns (bytes memory m) {
        m = new bytes(len);
        for (uint256 i; i < len; i++) m[i] = bytes1(fill);
    }

    function test_registerKeys_stores_and_emits() public {
        bytes memory m = _meta(0x02, 66);
        vm.expectEmit(true, true, false, true);
        emit StealthMetaAddressSet(ALICE, 1, m);
        vm.prank(ALICE);
        r.registerKeys(1, m);
        require(keccak256(r.stealthMetaAddressOf(ALICE, 1)) == keccak256(m), "stored");
    }

    function test_registerKeys_scheme1_wrong_length_reverts() public {
        vm.expectRevert(ERC6538Registry.InvalidMetaAddressLength.selector);
        r.registerKeys(1, _meta(0x02, 65));
    }

    // Review focus 4: non-scheme-1 ids accept any length.
    function test_registerKeys_other_scheme_accepts_any_length() public {
        bytes memory m = _meta(0x07, 3);
        vm.prank(ALICE);
        r.registerKeys(2, m);
        require(keccak256(r.stealthMetaAddressOf(ALICE, 2)) == keccak256(m), "stored");
    }

    // Review focus 4: re-registering overwrites, and another registrant is untouched.
    function test_register_overwrites_and_isolates_registrants() public {
        bytes memory first = _meta(0x02, 66);
        bytes memory second = _meta(0x03, 66);
        vm.prank(ALICE);
        r.registerKeys(1, first);
        vm.prank(BOB);
        r.registerKeys(1, first);
        vm.prank(ALICE);
        r.registerKeys(1, second);
        require(keccak256(r.stealthMetaAddressOf(ALICE, 1)) == keccak256(second), "alice overwritten");
        require(keccak256(r.stealthMetaAddressOf(BOB, 1)) == keccak256(first), "bob untouched");
    }

    // Review focus 4: nonces are per registrant.
    function test_incrementNonce_is_per_registrant() public {
        require(r.nonceOf(ALICE) == 0, "starts at 0");
        vm.expectEmit(true, false, false, true);
        emit NonceIncremented(ALICE, 1);
        vm.prank(ALICE);
        r.incrementNonce();
        require(r.nonceOf(ALICE) == 1, "alice 1");
        require(r.nonceOf(BOB) == 0, "bob 0");
    }
}
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd stealth && forge test --match-contract ERC6538RegistryTest`
Expected: FAIL to compile, `ERC6538Registry.sol` not found.

- [ ] **Step 8: Write the Registry**

`stealth/src/ERC6538Registry.sol`:

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @notice ERC-6538 stealth meta-address registry. `registerKeysOnBehalf` (EIP-712) is deliberately
/// not implemented, so this is not fully ERC-6538 compliant. Add it when a compliance claim is needed.
contract ERC6538Registry {
    error InvalidMetaAddressLength();

    event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress);
    event NonceIncremented(address indexed registrant, uint256 newNonce);

    mapping(address => mapping(uint256 => bytes)) public stealthMetaAddressOf;
    mapping(address => uint256) public nonceOf;

    function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external {
        // Scheme 1 meta-address = 33-byte spend pubkey || 33-byte view pubkey.
        if (schemeId == 1 && stealthMetaAddress.length != 66) revert InvalidMetaAddressLength();
        stealthMetaAddressOf[msg.sender][schemeId] = stealthMetaAddress;
        emit StealthMetaAddressSet(msg.sender, schemeId, stealthMetaAddress);
    }

    function incrementNonce() external {
        emit NonceIncremented(msg.sender, ++nonceOf[msg.sender]);
    }
}
```

- [ ] **Step 9: Run the full contract suite**

Run: `cd stealth && forge test`
Expected: 7 passed, 0 failed.

- [ ] **Step 10: Commit** (includes the approved spec and this plan)

```bash
git add stealth/foundry.toml stealth/src stealth/test \
  docs/superpowers/specs/2026-10-15-stealth-core-design.md \
  docs/superpowers/plans/2026-10-15-stealth-core.md
git commit -m "feat(stealth): ERC-5564 announcer and ERC-6538 registry"
```

---

### Task 2: TypeScript library and tests

**Files:**
- Create: `stealth/package.json`
- Create: `stealth/tsconfig.json`
- Create: `stealth/ts/stealth.ts`
- Test: `stealth/ts/stealth.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (Task 3 imports these exact names from `../ts/stealth.ts`):
  - `type Announcement = { schemeId: bigint; stealthAddress: string; ephemeralPubKey: string; metadata: string }`
  - `type Found = { stealthAddress: string; privateKey: string }`
  - `generateMetaAddress(): { spendKey: string; viewKey: string; metaAddress: string }` (all `0x` hex; `metaAddress` is 66 bytes)
  - `deriveStealth(metaAddress: string, ephemeralKey?: string): { stealthAddress: string; ephemeralPubKey: string; viewTag: string }` (accepts `0x..` or `st:eth:0x..`; `viewTag` is a 1-byte `0x..` hex string, usable directly as announcement `metadata`)
  - `scan(announcements: Announcement[], viewKey: string, spendKey: string): Found[]`

Reference vector (generated 2026-10-15 by running `@scopelift/stealth-address-sdk` `generateStealthAddress` and `computeStealthKey` with these fixed keys; our code must match it, never the other way round):

- spend key `0x1111…11`, view key `0x2222…22`, ephemeral key `0x3333…33` (32 bytes each)
- meta-address `0x034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27`
- ephemeral pubkey `0x023c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1`
- view tag `0x20`
- stealth address `0xD8606eD2ecDB71fdcb8cCA8fA1925ff84238f2a9`
- stealth private key `0x32074def70f9689560d0eb1b86aa895b735ed5852c9ce187ff0dcd968e8a19d3`

- [ ] **Step 1: Create `stealth/package.json` and `stealth/tsconfig.json`**

`stealth/package.json`:

```json
{
  "name": "stealth",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "tsc --noEmit && vitest run",
    "test:sol": "forge test",
    "smoke": "node script/smoke.ts"
  },
  "dependencies": {
    "@noble/curves": "1.2.0",
    "ethers": "6.17.0"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

`stealth/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["ts", "script"]
}
```

- [ ] **Step 2: Install**

Run: `cd stealth && npm install`
Expected: creates `package-lock.json`, exits 0. Check `node -p "require('./node_modules/ethers/package.json').version"` prints `6.17.0`.

- [ ] **Step 3: Write the failing tests**

`stealth/ts/stealth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from './stealth.ts';

const V = {
  spend: '0x' + '11'.repeat(32),
  view: '0x' + '22'.repeat(32),
  eph: '0x' + '33'.repeat(32),
  meta: '0x034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27',
  ephPub: '0x023c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1',
  tag: '0x20',
  address: '0xD8606eD2ecDB71fdcb8cCA8fA1925ff84238f2a9',
  privateKey: '0x32074def70f9689560d0eb1b86aa895b735ed5852c9ce187ff0dcd968e8a19d3',
};

const toAnn = (s: ReturnType<typeof deriveStealth>): Announcement => ({
  schemeId: 1n,
  stealthAddress: s.stealthAddress,
  ephemeralPubKey: s.ephemeralPubKey,
  metadata: s.viewTag,
});

describe('reference vector (ScopeLift stealth-address-sdk)', () => {
  it('deriveStealth matches the reference', () => {
    expect(deriveStealth(V.meta, V.eph)).toEqual({
      stealthAddress: V.address,
      ephemeralPubKey: V.ephPub,
      viewTag: V.tag,
    });
  });

  it('scan recovers the reference address and private key', () => {
    const ann = toAnn(deriveStealth(V.meta, V.eph));
    expect(scan([ann], V.view, V.spend)).toEqual([{ stealthAddress: V.address, privateKey: V.privateKey }]);
  });

  it('accepts the st:eth: URI form', () => {
    expect(deriveStealth('st:eth:' + V.meta, V.eph).stealthAddress).toBe(V.address);
  });
});

describe('round trip', () => {
  // Review focus 5: two payments, two unlinkable addresses, both found.
  it('finds every payment; the recovered key controls the address', () => {
    const me = generateMetaAddress();
    const a = deriveStealth(me.metaAddress);
    const b = deriveStealth(me.metaAddress);
    expect(a.stealthAddress).not.toBe(b.stealthAddress);
    const found = scan([toAnn(a), toAnn(b)], me.viewKey, me.spendKey);
    expect(found.map((f) => f.stealthAddress)).toEqual([a.stealthAddress, b.stealthAddress]);
    for (const f of found) expect(new Wallet(f.privateKey).address).toBe(f.stealthAddress);
  });

  it('does not return payments meant for someone else', () => {
    const me = generateMetaAddress();
    const other = generateMetaAddress();
    expect(scan([toAnn(deriveStealth(other.metaAddress))], me.viewKey, me.spendKey)).toEqual([]);
  });

  it('skips announcements for other scheme ids', () => {
    const me = generateMetaAddress();
    const ann = { ...toAnn(deriveStealth(me.metaAddress)), schemeId: 2n };
    expect(scan([ann], me.viewKey, me.spendKey)).toEqual([]);
  });
});

describe('hostile input', () => {
  // Review focus 1: anyone can announce garbage; scan must skip it, never throw.
  it('skips malformed announcements without throwing', () => {
    const me = generateMetaAddress();
    const noise: Announcement[] = [
      { schemeId: 1n, stealthAddress: 'nonsense', ephemeralPubKey: '0x1234', metadata: '0x' },
      { schemeId: 1n, stealthAddress: V.address, ephemeralPubKey: '0x', metadata: '0x20' },
      { schemeId: 1n, stealthAddress: V.address, ephemeralPubKey: '0x05' + '00'.repeat(32), metadata: '0x20' },
      { schemeId: 1n, stealthAddress: V.address, ephemeralPubKey: V.ephPub, metadata: '0x' },
    ];
    expect(scan(noise, me.viewKey, me.spendKey)).toEqual([]);
  });

  // Review focus 2: right view tag, wrong address (the 1-in-256 collision) must not match.
  it('rejects a view-tag match whose address differs', () => {
    const ann = { ...toAnn(deriveStealth(V.meta, V.eph)), stealthAddress: '0x' + '00'.repeat(19) + '01' };
    expect(scan([ann], V.view, V.spend)).toEqual([]);
  });

  // Review focus 3: a bad meta-address must throw, never yield an unspendable address.
  it('deriveStealth throws on wrong length', () => {
    expect(() => deriveStealth('0x' + '02'.repeat(33))).toThrow(/66 bytes/);
  });

  it('deriveStealth throws on an off-curve key', () => {
    expect(() => deriveStealth('0x' + '05'.repeat(66))).toThrow();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd stealth && npx vitest run`
Expected: FAIL, cannot resolve `./stealth.ts`.

- [ ] **Step 5: Write the library**

`stealth/ts/stealth.ts`:

```ts
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
  const found: Found[] = [];
  for (const a of announcements) {
    try {
      if (a.schemeId !== SCHEME_ID) continue;
      const h = hashShared(viewKey, getBytes(a.ephemeralPubKey));
      if (getBytes(a.metadata)[0] !== getBytes(h)[0]) continue; // view tag; empty metadata never matches
      const stealthAddress = addressOf(spendPub, h);
      if (stealthAddress.toLowerCase() !== a.stealthAddress.toLowerCase()) continue;
      const k = (BigInt(spendKey) + BigInt(h)) % N;
      found.push({ stealthAddress, privateKey: '0x' + k.toString(16).padStart(64, '0') });
    } catch {
      // Anyone can announce garbage; malformed entries are noise, not errors.
    }
  }
  return found;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd stealth && npm test`
Expected: `tsc --noEmit` clean, then 10 tests passed.

If the reference-vector tests fail, the library is wrong: do not edit the vector. Re-read the Global Constraints derivation.

- [ ] **Step 7: Commit**

```bash
git add stealth/package.json stealth/package-lock.json stealth/tsconfig.json stealth/ts
git commit -m "feat(stealth): ERC-5564 scheme 1 library with reference-vector test"
```

---

### Task 3: Besu smoke script and recorded results

**Files:**
- Create: `stealth/script/smoke.ts`
- Modify: `docs/superpowers/specs/2026-10-15-stealth-core-design.md` (section 6, item 3: record results)

**Interfaces:**
- Consumes: Task 1 artifacts `stealth/out/ERC5564Announcer.sol/ERC5564Announcer.json` and `stealth/out/ERC6538Registry.sol/ERC6538Registry.json` (fields `abi`, `bytecode.object`); Task 2 exports `generateMetaAddress`, `deriveStealth`, `scan`, `Announcement` from `../ts/stealth.ts`.
- Produces: a printed record of chain id, gas price and deployed addresses, copied into the spec. This is a throwaway-style one-off check, not a CI test.

The script uses the deployer account as the recipient identity in the Registry (it registers keys as `msg.sender`); a real recipient would use its own account. It needs a funded Besu account. The user supplies the key; never print it.

- [ ] **Step 1: Write the script**

`stealth/script/smoke.ts`:

```ts
// One-off smoke check against a live Besu network. Not part of CI.
// Usage: forge build && RPC_URL=... DEPLOYER_KEY=0x... node script/smoke.ts
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from '../ts/stealth.ts';

const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');

const provider = new JsonRpcProvider(RPC_URL);
const deployer = new Wallet(DEPLOYER_KEY, provider);

async function deploy(name: string): Promise<Contract> {
  const { abi, bytecode } = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
  const c = await new ContractFactory(abi, bytecode.object, deployer).deploy();
  await c.waitForDeployment();
  return c as unknown as Contract;
}

const net = await provider.getNetwork();
const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
console.log('chainId', net.chainId.toString(), '| gasPrice', gasPrice.toString());

const announcer = await deploy('ERC5564Announcer');
const registry = await deploy('ERC6538Registry');
console.log('announcer', await announcer.getAddress(), '| registry', await registry.getAddress());

// Recipient registers a meta-address.
const me = generateMetaAddress();
await (await registry.registerKeys(1, me.metaAddress)).wait();

// Sender reads it from the registry, derives a stealth address, announces.
const s = deriveStealth(await registry.stealthMetaAddressOf(deployer.address, 1));
await (await announcer.announce(1, s.stealthAddress, s.ephemeralPubKey, s.viewTag)).wait();

// Recipient scans the chain logs.
const logs = await announcer.queryFilter(announcer.filters.Announcement());
const anns: Announcement[] = logs.map((l: any) => ({
  schemeId: l.args.schemeId,
  stealthAddress: l.args.stealthAddress,
  ephemeralPubKey: l.args.ephemeralPubKey,
  metadata: l.args.metadata,
}));
const [found] = scan(anns, me.viewKey, me.spendKey);
if (!found || found.stealthAddress !== s.stealthAddress) throw new Error('scan did not recover the stealth address');

// Spend: a fresh stealth address holds no gas. Fund it only if gas is not free.
const stealth = new Wallet(found.privateKey, provider);
const gasLimit = 21000n;
if (gasPrice > 0n) {
  await (await deployer.sendTransaction({ to: stealth.address, value: gasPrice * gasLimit * 2n, gasPrice, gasLimit })).wait();
}
const rc = await (await stealth.sendTransaction({ to: deployer.address, value: 0n, gasPrice, gasLimit })).wait();
if (rc?.from !== stealth.address) throw new Error('tx was not signed by the stealth key');
console.log('OK: scan recovered', stealth.address, '| tx signed by stealth key', rc.hash);
```

- [ ] **Step 2: Typecheck**

Run: `cd stealth && npm test`
Expected: `tsc --noEmit` clean (it now includes `script/`), 10 tests passed.

- [ ] **Step 3: Build the contract artifacts**

Run: `cd stealth && forge build`
Expected: exits 0; `out/ERC5564Announcer.sol/ERC5564Announcer.json` and `out/ERC6538Registry.sol/ERC6538Registry.json` exist.

- [ ] **Step 4: Ask the user for a funded Besu key**

Ask the user to put `RPC_URL` and `DEPLOYER_KEY` in `stealth/.env.smoke` (gitignored via `.env.*`; they can write it with a `!` one-liner). Do NOT read, cat or print that file.

- [ ] **Step 5: Open a tunnel to a validator**

Run (background): `KUBECONFIG=$PWD/alibaba.yaml kubectl -n besu port-forward pod/besu-node-validator-1-0 8545:8545`
Expected: `Forwarding from 127.0.0.1:8545`. `RPC_URL` in the env file is then `http://127.0.0.1:8545`.

- [ ] **Step 6: Run the smoke check**

Run: `cd stealth && set -a && . ./.env.smoke && set +a && node script/smoke.ts`
Expected: a `chainId ... | gasPrice ...` line, the two addresses, then `OK: scan recovered 0x... | tx signed by stealth key 0x...`.

If node rejects the `.ts` file, rerun with `node --experimental-strip-types script/smoke.ts`. If a deploy reverts with no reason, the cause is likely the `shanghai` EVM version: record that finding in the spec instead of working around it, and stop to ask the user.

- [ ] **Step 7: Record the results in the spec**

Append to section 6 item 3 of `docs/superpowers/specs/2026-10-15-stealth-core-design.md`, under "Results (date)": chain id, gas price (zero or not, so sub-project 2 knows whether stealth addresses need a gas sponsor), whether `shanghai` deployed, and the announcer and registry addresses.

- [ ] **Step 8: Commit**

```bash
git add stealth/script docs/superpowers/specs/2026-10-15-stealth-core-design.md
git commit -m "feat(stealth): Besu smoke script and recorded network results"
```
