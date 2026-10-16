# RD stealth token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Rupiah Digital (RD) on Besu as an ERC-20 whose mint and send functions announce the stealth recipient through the ERC-5564 Announcer in the same transaction, with a TypeScript metadata helper and a live end-to-end smoke.

**Architecture:** `RupiahDigital` extends OpenZeppelin `ERC20` + `ERC20Burnable` (decimals 0), adds issuer-only `mint` / `mintStealth` and holder `sendStealth`. Each stealth function calls the sub-project 1 Announcer with the 57-byte EIP-5564 ERC-20 metadata, so the Announcement `caller` is the token address and cannot be forged. A pure library module builds and parses that metadata. The existing `scan` is unchanged.

**Tech Stack:** Solidity ^0.8.20 (evm `shanghai`), Foundry, OpenZeppelin Contracts 5.4.0, TypeScript, `ethers` 6.17.0, `@noble/curves` 1.2.0, vitest 2.

**Spec:** `docs/superpowers/specs/2026-10-15-rd-stealth-token-design.md` (builds on `docs/superpowers/specs/2026-10-15-stealth-core-design.md`)

## Global Constraints

- RD: name "Rupiah Digital", symbol "RD", `decimals()` returns `0`.
- OpenZeppelin Contracts exact pin `5.4.0` (same as `Paladin/contracts`). Solidity `pragma ^0.8.20`, SPDX `Apache-2.0`, `evm_version = "shanghai"`.
- Announcer scheme id fixed to `1`. Ephemeral public key must be exactly 33 bytes or the call reverts `InvalidEphemeralPubKey()`.
- Announcement metadata is exactly 57 bytes: byte 1 view tag; bytes 2-5 `0xa9059cbb`; bytes 6-25 token address; bytes 26-57 amount as 32-byte big-endian. The contract builds it from the same variables that move the balance.
- Only the immutable `issuer` may `mint` and `mintStealth` (`OnlyIssuer()` otherwise). No ownership transfer, no pause, no blacklist, no allowance-based stealth send.
- No new TypeScript dependency. `ethers` 6.17.0 and `@noble/curves` 1.2.0 only.
- All code under `stealth/`. Do not touch `Paladin/`, `backend/`, or the sub-project 1 files (`stealth/src/ERC5564Announcer.sol`, `stealth/src/ERC6538Registry.sol`, `stealth/ts/stealth.ts`, `stealth/script/smoke.ts`).
- Never print or `cat` any `.env*` file. Scripts read secrets from env vars only.

## Review Focus

1. Non-issuer `mint` and `mintStealth` must revert; a holder must not be able to mint. (Task 1)
2. Ephemeral key lengths 0, 32, 34 and 65 must revert for both `sendStealth` and `mintStealth`. (Task 1)
3. The announced amount must equal the moved amount, including after a partial send, and `caller` must be the token address. (Task 1, Task 3)
4. `parseTokenMetadata` must return `null`, never throw, for empty, tag-only (1 byte), 56-byte, 58-byte, wrong-selector and non-hex input. (Task 2)
5. A forged announcement with RD-looking metadata, posted straight to the Announcer, must be excluded by the `caller` filter and its address must hold 0. (Task 3)
6. Zero-address recipient and insufficient balance must revert with the OpenZeppelin errors, with no announcement emitted. (Task 1)

---

### Task 1: OpenZeppelin dependency, `RupiahDigital` and Foundry tests

**Files:**
- Modify: `stealth/package.json` (adds the dependency; `npm install` also rewrites `stealth/package-lock.json`)
- Modify: `stealth/foundry.toml`
- Create: `stealth/src/RupiahDigital.sol`
- Test: `stealth/test/RupiahDigital.t.sol`

**Interfaces:**
- Consumes: `ERC5564Announcer` from `stealth/src/ERC5564Announcer.sol` (`announce(uint256,address,bytes,bytes)`, event `Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)`).
- Produces (Task 3 relies on these exact names and on `forge build` writing `stealth/out/RupiahDigital.sol/RupiahDigital.json` with `abi` and `bytecode.object`): `constructor(address issuer_, address announcer_)`; `mint(address to, uint256 amount)`; `mintStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag)`; `sendStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag)`; inherited `burn(uint256)`, `balanceOf`, `totalSupply`; `error OnlyIssuer()`; `error InvalidEphemeralPubKey()`; `address public immutable issuer`.

- [ ] **Step 1: Install OpenZeppelin and add the remapping**

Run: `cd stealth && npm install --save-exact @openzeppelin/contracts@5.4.0`
Expected: `package.json` gains `"@openzeppelin/contracts": "5.4.0"` under `dependencies`, `package-lock.json` updates, exit 0.

Append to `stealth/foundry.toml`, inside `[profile.default]` (keep the existing lines):

```toml
remappings = ["@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/"]
```

Verify the error interface exists: `ls stealth/node_modules/@openzeppelin/contracts/interfaces/draft-IERC6093.sol` (it declares `ERC20InvalidReceiver(address)` and `ERC20InsufficientBalance(address,uint256,uint256)`). If the file is elsewhere in your install, fix the import in Step 2 and say so in your report.

- [ ] **Step 2: Write the failing test**

`stealth/test/RupiahDigital.t.sol`:

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC5564Announcer} from "../src/ERC5564Announcer.sol";
import {RupiahDigital} from "../src/RupiahDigital.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool, address) external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
    function prank(address) external;
}

contract RupiahDigitalTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    address constant ISSUER = address(0xB1);
    address constant ALICE = address(0xA11CE);
    address constant STEALTH = address(0x57EA17);

    ERC5564Announcer announcer;
    RupiahDigital token;

    function setUp() public {
        announcer = new ERC5564Announcer();
        token = new RupiahDigital(ISSUER, address(announcer));
    }

    // 57-byte EIP-5564 ERC-20 metadata, built independently of the contract's encoding.
    function _meta(bytes1 tag, uint256 amount) internal view returns (bytes memory) {
        return bytes.concat(tag, bytes4(0xa9059cbb), bytes20(address(token)), bytes32(amount));
    }

    function _eph(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i++) b[i] = 0x02;
    }

    function _fund(address to, uint256 amount) internal {
        vm.prank(ISSUER);
        token.mint(to, amount);
    }

    function test_token_identity() public view {
        require(token.decimals() == 0, "decimals");
        require(keccak256(bytes(token.name())) == keccak256("Rupiah Digital"), "name");
        require(keccak256(bytes(token.symbol())) == keccak256("RD"), "symbol");
        require(token.issuer() == ISSUER, "issuer");
    }

    // Review focus 1: only the issuer mints.
    function test_non_issuer_cannot_mint() public {
        vm.prank(ALICE);
        vm.expectRevert(RupiahDigital.OnlyIssuer.selector);
        token.mint(ALICE, 1);
    }

    function test_non_issuer_cannot_mintStealth() public {
        vm.prank(ALICE);
        vm.expectRevert(RupiahDigital.OnlyIssuer.selector);
        token.mintStealth(STEALTH, 1, _eph(33), 0x20);
    }

    function test_issuer_mint_adds_balance_and_supply() public {
        _fund(ALICE, 1000);
        require(token.balanceOf(ALICE) == 1000, "balance");
        require(token.totalSupply() == 1000, "supply");
    }

    // Review focus 3: caller is the token, metadata is exactly 57 bytes with the minted amount.
    function test_mintStealth_mints_and_announces() public {
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(token), _eph(33), _meta(0x20, 1000));
        vm.prank(ISSUER);
        token.mintStealth(STEALTH, 1000, _eph(33), 0x20);
        require(token.balanceOf(STEALTH) == 1000, "balance");
        require(token.totalSupply() == 1000, "supply");
    }

    // Review focus 3: a partial send announces only the sent amount and leaves the remainder.
    function test_sendStealth_partial_moves_and_announces_sent_amount() public {
        _fund(ALICE, 1000);
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(token), _eph(33), _meta(0x7f, 400));
        vm.prank(ALICE);
        token.sendStealth(STEALTH, 400, _eph(33), 0x7f);
        require(token.balanceOf(STEALTH) == 400, "recipient");
        require(token.balanceOf(ALICE) == 600, "remainder");
        require(token.totalSupply() == 1000, "supply unchanged");
    }

    // Review focus 2: ephemeral key must be exactly 33 bytes, for both entry points.
    function test_bad_ephemeral_length_reverts() public {
        _fund(ALICE, 1000);
        uint256[4] memory lens = [uint256(0), 32, 34, 65];
        for (uint256 i; i < lens.length; i++) {
            vm.prank(ALICE);
            vm.expectRevert(RupiahDigital.InvalidEphemeralPubKey.selector);
            token.sendStealth(STEALTH, 1, _eph(lens[i]), 0x20);

            vm.prank(ISSUER);
            vm.expectRevert(RupiahDigital.InvalidEphemeralPubKey.selector);
            token.mintStealth(STEALTH, 1, _eph(lens[i]), 0x20);
        }
        require(token.balanceOf(STEALTH) == 0, "nothing moved");
    }

    // Review focus 6: OpenZeppelin errors, nothing announced.
    function test_zero_recipient_reverts() public {
        _fund(ALICE, 1000);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.sendStealth(address(0), 1, _eph(33), 0x20);
    }

    function test_insufficient_balance_reverts() public {
        _fund(ALICE, 100);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, ALICE, 100, 101));
        token.sendStealth(STEALTH, 101, _eph(33), 0x20);
    }

    function test_burn_lowers_supply() public {
        _fund(ALICE, 1000);
        vm.prank(ALICE);
        token.burn(400);
        require(token.balanceOf(ALICE) == 600, "balance");
        require(token.totalSupply() == 600, "supply");
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd stealth && forge test --match-contract RupiahDigitalTest`
Expected: FAIL to compile, `src/RupiahDigital.sol` not found.

- [ ] **Step 4: Write the contract**

`stealth/src/RupiahDigital.sol`:

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

interface IERC5564Announcer {
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external;
}

/// @notice Rupiah Digital: whole-rupiah ERC-20 whose mint and send announce the stealth recipient
/// (ERC-5564 scheme 1) in the same transaction. This contract is the Announcement `caller`, so a scanner
/// that filters on `caller == address(this)` can trust the metadata. A plain `transfer` to a stealth
/// address still works but announces nothing; wallets must use `sendStealth`.
contract RupiahDigital is ERC20, ERC20Burnable {
    error OnlyIssuer();
    error InvalidEphemeralPubKey();

    address public immutable issuer;
    IERC5564Announcer public immutable announcer;

    constructor(address issuer_, address announcer_) ERC20("Rupiah Digital", "RD") {
        issuer = issuer_;
        announcer = IERC5564Announcer(announcer_);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != issuer) revert OnlyIssuer();
        _mint(to, amount);
    }

    function mintStealth(address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes1 viewTag)
        external
    {
        if (msg.sender != issuer) revert OnlyIssuer();
        _mint(stealthAddress, amount);
        _announce(stealthAddress, amount, ephemeralPubKey, viewTag);
    }

    function sendStealth(address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes1 viewTag)
        external
    {
        _transfer(msg.sender, stealthAddress, amount);
        _announce(stealthAddress, amount, ephemeralPubKey, viewTag);
    }

    /// EIP-5564 ERC-20 metadata: viewTag (1) | transfer selector (4) | token (20) | amount (32) = 57 bytes.
    function _announce(address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes1 viewTag)
        private
    {
        if (ephemeralPubKey.length != 33) revert InvalidEphemeralPubKey();
        announcer.announce(
            1, stealthAddress, ephemeralPubKey, abi.encodePacked(viewTag, bytes4(0xa9059cbb), address(this), amount)
        );
    }
}
```

- [ ] **Step 5: Run the new tests**

Run: `cd stealth && forge test --match-contract RupiahDigitalTest`
Expected: 10 passed, 0 failed.

- [ ] **Step 6: Run the whole contract suite**

Run: `cd stealth && forge test`
Expected: 17 passed, 0 failed (7 from sub-project 1 plus 10 new). Also run `npm test` and expect 14 vitest tests still passing and `tsc` clean.

- [ ] **Step 7: Commit** (the spec and this plan are untracked and are included on purpose)

```bash
git add stealth/package.json stealth/package-lock.json stealth/foundry.toml \
  stealth/src/RupiahDigital.sol stealth/test/RupiahDigital.t.sol \
  docs/superpowers/specs/2026-10-15-rd-stealth-token-design.md \
  docs/superpowers/plans/2026-10-15-rd-stealth-token.md
git commit -m "feat(stealth): RupiahDigital ERC-20 with stealth mint and send"
```

---

### Task 2: Token metadata helper

**Files:**
- Create: `stealth/ts/token.ts`
- Test: `stealth/ts/token.test.ts`

**Interfaces:**
- Consumes: `generateMetaAddress`, `deriveStealth`, `scan`, type `Announcement` from `./stealth.ts` (the test uses them).
- Produces (Task 3 imports these exact names from `../ts/token.ts`):
  - `buildTokenMetadata(viewTag: string, token: string, amount: bigint): string` returns a 57-byte `0x` hex string.
  - `parseTokenMetadata(metadata: string): { viewTag: string; token: string; amount: bigint } | null` (`token` is checksummed; `viewTag` is a 1-byte `0x..` string).

Golden vector (computed 2026-10-15 with `ethers` `concat`): view tag `0x20`, token `0xD8606eD2ecDB71fdcb8cCA8fA1925ff84238f2a9`, amount `1000n` gives
`0x20a9059cbbd8606ed2ecdb71fdcb8cca8fa1925ff84238f2a900000000000000000000000000000000000000000000000000000000000003e8`.

- [ ] **Step 1: Write the failing tests**

`stealth/ts/token.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from './stealth.ts';
import { buildTokenMetadata, parseTokenMetadata } from './token.ts';

const TOKEN = '0xD8606eD2ecDB71fdcb8cCA8fA1925ff84238f2a9';
const GOLDEN =
  '0x20a9059cbbd8606ed2ecdb71fdcb8cca8fa1925ff84238f2a900000000000000000000000000000000000000000000000000000000000003e8';

describe('buildTokenMetadata', () => {
  it('matches the golden 57-byte vector', () => {
    expect(buildTokenMetadata('0x20', TOKEN, 1000n)).toBe(GOLDEN);
    expect((GOLDEN.length - 2) / 2).toBe(57);
  });

  it('accepts the extremes 0 and 2^256-1', () => {
    expect(buildTokenMetadata('0x00', TOKEN, 0n)).toHaveLength(2 + 57 * 2);
    expect(buildTokenMetadata('0xff', TOKEN, 2n ** 256n - 1n).endsWith('ff'.repeat(32))).toBe(true);
  });

  it('throws on bad input', () => {
    expect(() => buildTokenMetadata('0x2000', TOKEN, 1n)).toThrow();
    expect(() => buildTokenMetadata('0x', TOKEN, 1n)).toThrow();
    expect(() => buildTokenMetadata('0x20', '0x1234', 1n)).toThrow();
    expect(() => buildTokenMetadata('0x20', TOKEN, -1n)).toThrow();
    expect(() => buildTokenMetadata('0x20', TOKEN, 2n ** 256n)).toThrow();
  });
});

describe('parseTokenMetadata', () => {
  it('round-trips', () => {
    expect(parseTokenMetadata(buildTokenMetadata('0x7f', TOKEN, 123456789n))).toEqual({
      viewTag: '0x7f',
      token: TOKEN,
      amount: 123456789n,
    });
  });

  it('parses the golden vector', () => {
    expect(parseTokenMetadata(GOLDEN)).toEqual({ viewTag: '0x20', token: TOKEN, amount: 1000n });
  });

  // Review focus 4: never throws, always null for anything that is not the 57-byte ERC-20 form.
  it('returns null for anything else', () => {
    const body = GOLDEN.slice(2);
    for (const bad of [
      '0x',
      '0x20', // tag-only metadata from sub-project 1
      '0x' + body.slice(0, 56 * 2), // 56 bytes
      GOLDEN + '00', // 58 bytes
      '0x20' + 'deadbeef' + body.slice(10), // wrong selector
      'not hex',
      '',
    ]) {
      expect(parseTokenMetadata(bad)).toBeNull();
    }
  });
});

describe('with scan', () => {
  it('scan still finds an announcement whose metadata is token metadata', () => {
    const me = generateMetaAddress();
    const s = deriveStealth(me.metaAddress);
    const ann: Announcement = {
      schemeId: 1n,
      stealthAddress: s.stealthAddress,
      ephemeralPubKey: s.ephemeralPubKey,
      metadata: buildTokenMetadata(s.viewTag, TOKEN, 400n),
    };
    const found = scan([ann], me.viewKey, me.spendKey);
    expect(found.map((f) => f.stealthAddress)).toEqual([s.stealthAddress]);
    expect(parseTokenMetadata(ann.metadata)?.amount).toBe(400n);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd stealth && npx vitest run ts/token.test.ts`
Expected: FAIL, cannot resolve `./token.ts`.

- [ ] **Step 3: Write the helper**

`stealth/ts/token.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd stealth && npm test`
Expected: `tsc --noEmit` clean, then 14 existing + 7 new = 21 vitest tests passing. If the golden test fails, the helper is wrong; do not edit the vector.

- [ ] **Step 5: Commit**

```bash
git add stealth/ts/token.ts stealth/ts/token.test.ts
git commit -m "feat(stealth): ERC-20 announcement metadata helper"
```

---

### Task 3: RD smoke script on Besu and recorded results

**Files:**
- Create: `stealth/script/smoke-rd.ts`
- Modify: `docs/superpowers/specs/2026-10-15-rd-stealth-token-design.md` (section 7: record results)

**Interfaces:**
- Consumes: Task 1 artifacts `stealth/out/ERC5564Announcer.sol/ERC5564Announcer.json` and `stealth/out/RupiahDigital.sol/RupiahDigital.json` (fields `abi`, `bytecode.object`); `generateMetaAddress`, `deriveStealth`, `scan`, type `Announcement` from `../ts/stealth.ts`; `buildTokenMetadata`, `parseTokenMetadata` from `../ts/token.ts`.
- Produces: a printed record, copied into the spec. One-off check, not CI.

The deployer is the RD issuer (BI). "Bank A" and "bank B" are two fresh stealth identities made with `generateMetaAddress`. Stealth addresses hold no gas; the smoke relies on the recorded gas price `0` and passes the node's `gasPrice` explicitly, as `stealth/script/smoke.ts` does.

- [ ] **Step 1: Write the script**

`stealth/script/smoke-rd.ts`:

```ts
// One-off RD smoke check against a live Besu network. Not part of CI.
// Usage: forge build && RPC_URL=... DEPLOYER_KEY=0x... node script/smoke-rd.ts
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from '../ts/stealth.ts';
import { buildTokenMetadata, parseTokenMetadata } from '../ts/token.ts';

const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');

const provider = new JsonRpcProvider(RPC_URL);
const issuer = new Wallet(DEPLOYER_KEY, provider);

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('FAILED: ' + msg);
}

async function deploy(name: string, ...args: unknown[]): Promise<Contract> {
  const { abi, bytecode } = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
  const c = await new ContractFactory(abi, bytecode.object, issuer).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

const net = await provider.getNetwork();
const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
console.log('chainId', net.chainId.toString(), '| gasPrice', gasPrice.toString());

// Besu caps the eth_getLogs range, so read from the block before the deploy.
const fromBlock = await provider.getBlockNumber();
const announcer = await deploy('ERC5564Announcer');
const token = await deploy('RupiahDigital', issuer.address, await announcer.getAddress());
const tokenAddr = await token.getAddress();
console.log('announcer', await announcer.getAddress(), '| rd', tokenAddr);

// tokenFilter=true reads only announcements the token itself emitted (caller == token).
async function announcements(tokenFilter: boolean): Promise<Announcement[]> {
  const f = announcer.filters.Announcement(null, null, tokenFilter ? tokenAddr : null);
  const logs = await announcer.queryFilter(f, fromBlock);
  return logs.map((l: any) => ({
    schemeId: l.args.schemeId,
    stealthAddress: l.args.stealthAddress,
    ephemeralPubKey: l.args.ephemeralPubKey,
    metadata: l.args.metadata,
  }));
}

const bankA = generateMetaAddress();
const bankB = generateMetaAddress();

// 1. BI funds bank A with 1000 RD at a stealth address.
const toA = deriveStealth(bankA.metaAddress);
await (await token.mintStealth(toA.stealthAddress, 1000n, toA.ephemeralPubKey, toA.viewTag)).wait();

// 2. Bank A scans only the token's own announcements and checks the metadata against the chain.
const annsA = await announcements(true);
const [foundA, ...restA] = scan(annsA, bankA.viewKey, bankA.spendKey);
check(foundA && restA.length === 0, 'bank A finds exactly one payment');
const metaA = parseTokenMetadata(annsA.find((a) => a.stealthAddress === foundA.stealthAddress)!.metadata);
check(metaA && metaA.token === tokenAddr && metaA.amount === 1000n, 'metadata says 1000 RD of this token');
check((await token.balanceOf(foundA.stealthAddress)) === 1000n, 'bank A stealth address holds 1000');

// 3. Bank A sends 400 to bank B from its unfunded stealth address (gas price 0).
const walletA = new Wallet(foundA.privateKey, provider);
const toB = deriveStealth(bankB.metaAddress);
await (await token.connect(walletA).getFunction('sendStealth')(toB.stealthAddress, 400n, toB.ephemeralPubKey, toB.viewTag, { gasPrice })).wait();
check((await token.balanceOf(foundA.stealthAddress)) === 600n, 'bank A keeps the 600 remainder');

// 4. Bank B scans and finds 400.
const [foundB, ...restB] = scan(await announcements(true), bankB.viewKey, bankB.spendKey);
check(foundB && restB.length === 0, 'bank B finds exactly one payment');
check((await token.balanceOf(foundB.stealthAddress)) === 400n, 'bank B stealth address holds 400');

// 5. Forged announcement: the issuer posts RD-looking metadata straight to the Announcer for bank B.
//    It carries caller = issuer, not the token, so the token-filtered scan must not see it.
const forged = deriveStealth(bankB.metaAddress);
await (await announcer.announce(1, forged.stealthAddress, forged.ephemeralPubKey, buildTokenMetadata(forged.viewTag, tokenAddr, 999n))).wait();
check(scan(await announcements(false), bankB.viewKey, bankB.spendKey).length === 2, 'unfiltered scan sees the forgery');
check(scan(await announcements(true), bankB.viewKey, bankB.spendKey).length === 1, 'token-filtered scan ignores the forgery');
check((await token.balanceOf(forged.stealthAddress)) === 0n, 'forged address holds nothing');

// 6. Both banks burn what they hold; supply returns to 0.
await (await token.connect(new Wallet(foundB.privateKey, provider)).getFunction('burn')(400n, { gasPrice })).wait();
await (await token.connect(walletA).getFunction('burn')(600n, { gasPrice })).wait();
check((await token.totalSupply()) === 0n, 'total supply is 0 after burns');

console.log('OK: mintStealth, scan, sendStealth, forgery ignored, burn; final supply 0');
```

- [ ] **Step 2: Typecheck**

Run: `cd stealth && npm test`
Expected: `tsc --noEmit` clean (it includes `script/`), 21 vitest tests passing.

If tsc rejects a line (for example the `getFunction(...)` calls or `filters.Announcement(...)` typing), make the smallest type-level fix inside `smoke-rd.ts` only (a cast is fine), keep behaviour identical, and say what you changed in your report.

- [ ] **Step 3: Build the artifacts**

Run: `cd stealth && forge build`
Expected: exit 0; `out/RupiahDigital.sol/RupiahDigital.json` and `out/ERC5564Announcer.sol/ERC5564Announcer.json` exist.

- [ ] **Step 4: Commit the script**

```bash
git add stealth/script/smoke-rd.ts
git commit -m "feat(stealth): RD smoke script"
```

Steps 5-8 are done by the controller, not the implementer: they need a tunnel to the cluster.

- [ ] **Step 5: Open a tunnel to a validator**

Run (background): `KUBECONFIG=$PWD/alibaba.yaml kubectl -n besu port-forward pod/besu-node-validator-1-0 8545:8545`
Expected: `Forwarding from 127.0.0.1:8545`.

- [ ] **Step 6: Run the smoke**

Run: `cd stealth && set -a && . ./.env.smoke && set +a && node script/smoke-rd.ts`
Expected: a `chainId ... | gasPrice ...` line, the two addresses, then `OK: mintStealth, scan, sendStealth, forgery ignored, burn; final supply 0`. A line starting `FAILED:` names the broken check; record it in the spec instead of working around it, and stop to ask the user.

- [ ] **Step 7: Record the results in the spec**

Replace the body of section 7 of `docs/superpowers/specs/2026-10-15-rd-stealth-token-design.md` with: date, chain id, gas price, the deployed Announcer and RD addresses (throwaway), which checks passed, and anything surprising. Change the spec's `Status:` line to `approved 2026-10-15; implemented, results in section 7`.

- [ ] **Step 8: Close the tunnel and commit**

Stop only the port-forward you started (find its PID with `ps`; do not use `pkill -f` with a pattern that matches your own shell).

```bash
git add docs/superpowers/specs/2026-10-15-rd-stealth-token-design.md
git commit -m "docs(stealth): record RD smoke results on Besu"
```
