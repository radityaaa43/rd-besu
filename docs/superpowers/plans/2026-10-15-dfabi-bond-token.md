# DFABI bond token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a DFABI bond on Besu as a UniversalToken ERC-1400 whose stealth issue and transfer functions announce the recipient through the ERC-5564 Announcer in the same transaction, with a custodian-certificate gate, a TypeScript metadata and certificate helper, and a live end-to-end smoke.

**Architecture:** The UniversalToken `ERC1400` and `ERC1400TokensValidator` are vendored unmodified (22 files, pinned commit) and compiled against OpenZeppelin 4.9.6 through a Foundry context remapping, while our own code stays on OpenZeppelin 5.4.0. `DfabiBond` extends `ERC1400` and adds `issueByPartitionStealth` and `transferByPartitionStealth`, each calling the parent's internal logic and then `announcer.announce`, so Announcement `caller` is the token. The validator runs in nonce-based certificate mode with the custodian as signer and an allowlist of only the custodian, which closes the ERC-20 `transfer` path. A pure TypeScript module builds and parses the 89-byte metadata and signs custodian certificates. The ERC1820 registry the vendor code needs is deployed on Besu first with its standard pre-signed transaction.

**Tech Stack:** Solidity ^0.8.20 (evm `shanghai`, optimizer on), Foundry, OpenZeppelin Contracts 5.4.0 and 4.9.6 (npm alias `oz4`), UniversalToken commit `54320c6f7a8ee1fd7fcb19073e9c122e1e8f96f9`, TypeScript, `ethers` 6.17.0, `@noble/curves` 1.2.0, vitest 2.

**Spec:** `docs/superpowers/specs/2026-10-15-dfabi-bond-token-design.md` (builds on `docs/superpowers/specs/2026-10-15-rd-stealth-token-design.md` and `docs/superpowers/specs/2026-10-15-stealth-core-design.md`)

## Global Constraints

- Vendored code: copied **byte for byte** from `https://github.com/Consensys/UniversalToken` commit `54320c6f7a8ee1fd7fcb19073e9c122e1e8f96f9` (Apache-2.0). Never edit a file under `stealth/src/vendor/`. If the vendor code is the problem, stop and report; do not patch it.
- OpenZeppelin: `@openzeppelin/contracts` stays exact `5.4.0`; the vendor code uses `oz4` = `npm:@openzeppelin/contracts@4.9.6`, exact pin. Solidity `pragma ^0.8.20` for our files, SPDX `Apache-2.0`, `evm_version = "shanghai"`, `optimizer = true`, `optimizer_runs = 200`.
- Bond token: constructor granularity fixed to `1`; partitions are tranches; announcer scheme id fixed to `1`; ephemeral public key must be exactly 33 bytes or `InvalidEphemeralPubKey()`; `value == 0` reverts `ZeroAmount()`.
- Announcement metadata, 89 bytes: view tag (1) | `0xf3d490db` (selector of `transferByPartition(bytes32,address,uint256,bytes)`) (4) | token (20) | amount (32, big-endian) | partition (32).
- Certificate: 97 bytes `expiry(32) | r(32) | s(32) | v(1)`; the signed digest is `keccak256(domainSeparator ++ keccak256(msgSender ++ token ++ payload ++ expiry ++ nonce))` with packed encoding, signed raw (no message prefix); `payload` is the calldata minus its last **160** bytes, so the certificate must be the **last** ABI argument. Every validator rejection of a certificate is `Error(string)` with `"54"`.
- ERC1820 registry address `0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24`; pre-signed deployer `0xa990077c3205cbDf861e17Fa532eeB069cE9fF96`, gas price 100 gwei, gas limit 800000 (so 0.08 ETH up front).
- Expected Foundry noise: while the context remapping is in use, `forge build` and `forge test` print `ERROR foundry_compilers_artifacts_solc::sources ... SafeMath.sol: No such file or directory` and `Unable to resolve imports ... SafeMath.sol / IERC1820Registry.sol` for the three vendor imports of OpenZeppelin 4. They are harmless **if** the run ends with `Compiler run successful` (or the tests pass) and exit code 0. Any other error is real.
- TypeScript only `ethers` and `@noble/curves` (already installed). No new runtime dependency besides `oz4` (Solidity only).
- Do not modify sub-project 1 or 2 files (`stealth/src/ERC5564Announcer.sol`, `ERC6538Registry.sol`, `RupiahDigital.sol`, `stealth/ts/stealth.ts`, `token.ts`, their tests, `script/smoke.ts`, `script/smoke-rd.ts`). Only `stealth/foundry.toml` and `stealth/package.json` (+ lock) are modified, as listed in the tasks.
- Never print, cat, or commit `stealth/.env.smoke` (it holds a funded key). Source it with `set -a && . ./.env.smoke && set +a`.
- Commits: this machine has no git identity, so run `git -c user.name=lead -c user.email=lead@localhost commit ...`, and end every commit message with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Live Besu access: `export KUBECONFIG=/home/ecs-user/alibaba-kube/alibaba.yaml`, `kubectl -n besu port-forward pod/besu-node-validator-1-0 8545:8545` in the background with its PID saved, and close it by that PID (never `pkill -f`). Never touch other port-forwards.
- `curl`/`wget` are blocked by a hook on this machine; use `node` with `ethers` for JSON-RPC.

## Review Focus

Failure modes the spec implies that a person using this software is most likely to hit. Each has a test in the task that owns the code.

1. A certificate must not be reusable for anything other than the exact call it was signed for: another recipient, another amount, another sender, after expiry, signed by anyone but the custodian, or a second time. All must revert `"54"` and move nothing. (Task 3 tests `test_certificate_is_bound_to_recipient_and_amount`, `test_certificate_is_bound_to_sender`, `test_certificate_cannot_be_replayed`, `test_transfer_with_expired_certificate_reverts`, `test_transfer_with_wrong_signer_reverts`; Task 5 smoke replay check.)
2. The inherited ERC-20 `transfer` and `transferFrom` must not move bonds around the certificate gate. (Task 3 `test_erc20_paths_are_locked`, with a mutation check that turns the allowlist off and expects that test to fail; Task 5 smoke.)
3. The announced amount and partition must equal what moved, including after a partial send, and the announcement emitter must be the Announcer with `caller` = the token. (Task 3 `test_issue_moves_and_announces`, `test_transfer_with_certificate_moves_and_announces`, emitter pinned, expected bytes built with `bytes.concat`; mutation check in Task 3.)
4. `parseBondMetadata` must return `null` and never throw for empty, tag-only, RD's 57-byte form, 88 and 90 bytes, wrong selector and non-hex input. (Task 4)
5. A forged announcement carrying bond-looking metadata, posted straight to the Announcer, must be excluded by the `caller` filter and its address must hold nothing; with the registry missing the smoke must fail with a clear message instead of a bare revert. (Task 5)

---

## File Structure

| File | Responsibility |
|---|---|
| `stealth/script/erc1820-deploy-tx.hex` | The standard pre-signed ERC1820 deployment transaction (data). |
| `stealth/script/deploy-erc1820.ts` | Idempotent deploy of the registry on any RPC; optionally writes the runtime code fixture. |
| `stealth/test/fixtures/erc1820-runtime.hex` | Registry runtime bytecode, placed with `vm.etch` in Foundry tests. |
| `stealth/src/vendor/universal-token/**` | 22 vendored files + `LICENSE` + `README.md` (provenance). |
| `stealth/src/DfabiBond.sol` | The bond token: ERC-1400 + stealth issue/transfer + announcement. |
| `stealth/test/DfabiBond.t.sol` | Foundry tests for the bond and the certificate gate. |
| `stealth/test/CertificateVector.t.sol` | Cross-language certificate vector (Solidity side). |
| `stealth/ts/bond.ts`, `bond.test.ts` | Metadata build/parse, certificate digest and signing, and their tests. |
| `stealth/script/smoke-bond.ts` | One-off live smoke on Besu. |

---

### Task 1: ERC1820 registry script, fixture and Besu pre-flight

**Files:**
- Create: `stealth/script/erc1820-deploy-tx.hex`
- Create: `stealth/script/deploy-erc1820.ts`
- Create: `stealth/test/fixtures/erc1820-runtime.hex`
- Modify: `docs/superpowers/specs/2026-10-15-dfabi-bond-token-design.md` (append section 8)

**Interfaces:**
- Produces: `node script/deploy-erc1820.ts [fixtureOutPath]` (reads `RPC_URL`, `DEPLOYER_KEY`; idempotent; prints the registry address and size). `stealth/test/fixtures/erc1820-runtime.hex` is `0x`-prefixed hex with **no trailing newline** (Task 3 reads it with `vm.parseBytes(vm.readFile(...))`, which rejects a newline). The registry exists at `0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24` on Besu (Task 5 requires it).

- [ ] **Step 1: Extract the pre-signed transaction**

The raw transaction comes from the `@openzeppelin/test-helpers` package. It is untrusted until the script in Step 2 verifies it (sender and resulting contract address are checked there).

```bash
cd /home/ecs-user/alibaba-kube/stealth
D=$(mktemp -d) && (cd "$D" && npm init -y >/dev/null && npm i --silent --ignore-scripts @openzeppelin/test-helpers@0.5.16)
node -e "const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');const m=s.match(/ERC1820_REGISTRY_DEPLOY_TX\s*=\s*'(0x[0-9a-fA-F]+)'/);if(!m)throw new Error('tx not found');fs.writeFileSync('script/erc1820-deploy-tx.hex',m[1])" "$D/node_modules/@openzeppelin/test-helpers/src/data.js"
wc -c script/erc1820-deploy-tx.hex
```
Expected: `5240 script/erc1820-deploy-tx.hex`.

- [ ] **Step 2: Write the deploy script**

`stealth/script/deploy-erc1820.ts`:
```ts
// Deploys the ERC1820 registry with its standard pre-signed transaction (EIP-1820), if it is not there yet.
// Usage: set -a && . ./.env.smoke && set +a && node script/deploy-erc1820.ts [runtime-fixture-output-path]
import { readFileSync, writeFileSync } from 'node:fs';
import { JsonRpcProvider, Transaction, Wallet, getCreateAddress } from 'ethers';

const SENDER = '0xa990077c3205cbDf861e17Fa532eeB069cE9fF96';
const REGISTRY = '0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24';

const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');

// cacheTimeout -1: ethers otherwise reuses identical read results for 250 ms, which hides a state change just mined.
const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
const funder = new Wallet(DEPLOYER_KEY, provider);

const raw = readFileSync(new URL('./erc1820-deploy-tx.hex', import.meta.url), 'utf8').trim();
const tx = Transaction.from(raw);
if (tx.from !== SENDER || getCreateAddress({ from: tx.from, nonce: tx.nonce }) !== REGISTRY) {
  throw new Error('pre-signed transaction does not match the EIP-1820 deployer and registry address');
}

console.log('chainId', (await provider.getNetwork()).chainId.toString());
if ((await provider.getCode(REGISTRY)) === '0x') {
  // The pre-signed transaction has a fixed gas price (100 gwei), so its sender needs gasPrice * gasLimit up front,
  // even on a network whose own gas price is 0.
  const cost = tx.gasPrice! * tx.gasLimit;
  const have = await provider.getBalance(SENDER);
  if (have < cost) await (await funder.sendTransaction({ to: SENDER, value: cost - have })).wait();
  await (await provider.broadcastTransaction(raw)).wait();
}
const code = await provider.getCode(REGISTRY);
if (code === '0x') throw new Error('registry code missing after deployment');
console.log('ERC1820 registry at', REGISTRY, '|', (code.length - 2) / 2, 'bytes');
if (process.argv[2]) writeFileSync(process.argv[2], code); // no trailing newline: vm.parseBytes rejects one
process.exit(0);
```

- [ ] **Step 3: Rehearse on a local node and create the fixture**

```bash
T=$(mktemp -d)
cd /home/ecs-user/alibaba-kube/stealth
(anvil --silent --port 8599 --gas-price 0 --block-base-fee-per-gas 0 >/dev/null 2>&1 & echo $! > $T/anvil.pid); sleep 3
export RPC_URL=http://127.0.0.1:8599 DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # Foundry's public test key, local node only
mkdir -p test/fixtures
node script/deploy-erc1820.ts test/fixtures/erc1820-runtime.hex
node script/deploy-erc1820.ts
wc -c test/fixtures/erc1820-runtime.hex
kill $(cat $T/anvil.pid)
```
Expected: both runs print `ERC1820 registry at 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24 | 2501 bytes` (the second run skips the deployment); the fixture is `5004` bytes (`0x` + 5002 hex characters, no newline).

- [ ] **Step 4: Pre-flight on Besu**

This deploys one contract (the registry) on the live `besu` network and funds the pre-signed sender with 0.08 ETH from the deployer. The spec lists this as the first plan task. **If Besu refuses the transaction (for example an unprotected-transaction or fee error), STOP, do not work around it, and report the exact error: the fallbacks conflict with "vendored unmodified" and need the user.**

```bash
T=$(mktemp -d)
cd /home/ecs-user/alibaba-kube/stealth
export KUBECONFIG=/home/ecs-user/alibaba-kube/alibaba.yaml
(kubectl -n besu port-forward pod/besu-node-validator-1-0 8545:8545 >$T/pf.log 2>&1 & echo $! > $T/pf.pid); sleep 4
set -a && . ./.env.smoke && set +a
node script/deploy-erc1820.ts
node script/deploy-erc1820.ts
node --input-type=module -e "import { JsonRpcProvider } from 'ethers'; import { readFileSync } from 'node:fs'; const p = new JsonRpcProvider(process.env.RPC_URL, undefined, { cacheTimeout: -1 }); const c = await p.getCode('0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24'); console.log('fixture matches Besu code:', c.toLowerCase() === readFileSync('test/fixtures/erc1820-runtime.hex', 'utf8').toLowerCase()); process.exit(0)"
kill $(cat $T/pf.pid)
```
Expected: `chainId 1337`, then `ERC1820 registry at 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24 | 2501 bytes` twice (second run idempotent), then `fixture matches Besu code: true`.

- [ ] **Step 5: Record the pre-flight in the spec**

Append to `docs/superpowers/specs/2026-10-15-dfabi-bond-token-design.md`:

```markdown

## 8. Results

- Pre-flight, <date>, ACK `besu` namespace via `besu-node-validator-1-0`: ERC1820 registry deployed at `0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24` (2501 bytes of runtime code) with the standard pre-signed transaction. The deployer funded the one-time sender with 0.08 ETH first (deployer balance on this network is far above that). Besu accepted the unprotected transaction. Runtime code kept as `stealth/test/fixtures/erc1820-runtime.hex` for Foundry tests.
```
Replace `<date>` with today's date in `YYYY-MM-DD` form.

- [ ] **Step 6: Commit**

```bash
cd /home/ecs-user/alibaba-kube
git add stealth/script/erc1820-deploy-tx.hex stealth/script/deploy-erc1820.ts stealth/test/fixtures/erc1820-runtime.hex docs/superpowers/specs/2026-10-15-dfabi-bond-token-design.md
git -c user.name=lead -c user.email=lead@localhost commit -m "feat(stealth): ERC1820 registry deploy script, fixture, Besu pre-flight

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Vendor UniversalToken, OZ 4 alias and Foundry config

**Files:**
- Modify: `stealth/package.json` (adds dependency; `npm install` also rewrites `stealth/package-lock.json`)
- Modify: `stealth/foundry.toml`
- Create: `stealth/src/vendor/universal-token/` (22 `.sol` files under their upstream relative paths, `LICENSE`, `README.md`)

**Interfaces:**
- Produces (Task 3 relies on these import paths and on `forge build` compiling them): `stealth/src/vendor/universal-token/ERC1400.sol` (contract `ERC1400`, constructor `(string,string,uint256,address[],bytes32[])`, internal `_issueByPartition(bytes32,address,address,uint256,bytes)`, internal `_transferByPartition(bytes32,address,address,address,uint256,bytes,bytes)`, modifiers `onlyMinter` and `isIssuableToken`) and `stealth/src/vendor/universal-token/extensions/tokenExtensions/ERC1400TokensValidator.sol` (contract `ERC1400TokensValidator`, enum `CertificateValidation { None, NonceBased, SaltBased }`).

- [ ] **Step 1: Add the OpenZeppelin 4 alias**

```bash
cd /home/ecs-user/alibaba-kube/stealth
npm install --save-exact "oz4@npm:@openzeppelin/contracts@4.9.6"
grep -n '"oz4"' package.json
grep '"version"' node_modules/oz4/package.json node_modules/@openzeppelin/contracts/package.json
```
Expected: `"oz4": "npm:@openzeppelin/contracts@4.9.6"` in `package.json`; versions `4.9.6` and `5.4.0`.

- [ ] **Step 2: Copy the 22 files from the pinned commit and prove they are identical**

```bash
cd /home/ecs-user/alibaba-kube/stealth
U=$(mktemp -d) && git clone -q https://github.com/Consensys/UniversalToken.git "$U/ut" && git -C "$U/ut" checkout -q 54320c6f7a8ee1fd7fcb19073e9c122e1e8f96f9
test "$(git -C "$U/ut" rev-parse HEAD)" = 54320c6f7a8ee1fd7fcb19073e9c122e1e8f96f9 && echo pinned-ok
V=src/vendor/universal-token
FILES="ERC1400.sol IERC1400.sol extensions/tokenExtensions/ERC1400TokensValidator.sol extensions/tokenExtensions/IERC1400TokensChecker.sol extensions/tokenExtensions/IERC1400TokensValidator.sol extensions/userExtensions/IERC1400TokensRecipient.sol extensions/userExtensions/IERC1400TokensSender.sol interface/ERC1820Implementer.sol interface/HoldStatusCode.sol interface/IERC1643.sol interface/IHoldableERC1400TokenExtension.sol roles/AllowlistAdminRole.sol roles/AllowlistedRole.sol roles/BlocklistAdminRole.sol roles/BlocklistedRole.sol roles/CertificateSignerRole.sol roles/MinterRole.sol roles/PauserRole.sol roles/Roles.sol tools/DomainAware.sol tools/ERC1820Client.sol tools/Pausable.sol"
for f in $FILES; do mkdir -p "$V/$(dirname $f)"; cp "$U/ut/contracts/$f" "$V/$f"; cmp "$U/ut/contracts/$f" "$V/$f" || echo "DIFFERS $f"; done
cp "$U/ut/LICENSE" "$V/LICENSE"
find "$V" -name '*.sol' | wc -l
```
Expected: `pinned-ok`, no `DIFFERS` line, and `22`.

- [ ] **Step 3: Write the provenance README**

`stealth/src/vendor/universal-token/README.md`:
```markdown
# Vendored: Consensys UniversalToken (ERC-1400)

- Source: https://github.com/Consensys/UniversalToken, commit `54320c6f7a8ee1fd7fcb19073e9c122e1e8f96f9` (2024-01-23), `contracts/` subtree, license Apache-2.0 (`LICENSE` in this folder).
- Files: the 22 Solidity files that `ERC1400.sol` and `ERC1400TokensValidator.sol` import, at their upstream relative paths. Copied byte for byte; never edit them here. To check: clone the repository at the commit above and `cmp` each file against `contracts/<same path>`.
- **The upstream repository is archived and its files say "This code has not been reviewed. Do not use or deploy this code before reviewing it personally first." Nothing in this repository audits it.**
- It is compiled against OpenZeppelin Contracts 4.9.6 (npm alias `oz4`) through the context remapping in `stealth/foundry.toml`; the rest of `stealth/src` uses OpenZeppelin 5.4.0.
- It registers itself in the ERC1820 registry at `0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24`, so that registry must exist on the network (`stealth/script/deploy-erc1820.ts`).
```

- [ ] **Step 4: Update `stealth/foundry.toml`**

Replace the line
```
remappings = ["@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/"]
```
with
```
# The vendored UniversalToken needs OpenZeppelin 4 (npm alias `oz4`); everything else uses 5.4.0.
# Foundry's import pre-scan ignores the context line and logs "Unable to resolve imports" for three vendor
# imports; solc itself resolves them and the build succeeds.
remappings = [
  "@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/",
  "src/vendor/universal-token/:@openzeppelin/contracts/=node_modules/oz4/",
]
```
and append at the end of the file
```

# The vendored ERC1400 only fits the 24,576-byte contract limit comfortably with the optimizer on (measured on).
optimizer = true
optimizer_runs = 200
```

- [ ] **Step 5: Build, check sizes, check nothing else broke**

```bash
cd /home/ecs-user/alibaba-kube/stealth
forge build 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Compiler run|Error \(" ; echo "exit=${PIPESTATUS[0]}"
forge build --sizes 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^\| (ERC1400|ERC1400TokensValidator|RupiahDigital) "
forge test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "tests passed|Suite result"
```
Expected: `Compiler run successful!`, `exit=0`, no `Error (` lines (the noise lines from Global Constraints may appear above); runtime sizes `ERC1400` about 17,181 and `ERC1400TokensValidator` about 21,125, both below 24,576; `forge test` reports 19 tests passed in total (7 from sub-project 1, 12 from RD).

- [ ] **Step 6: Commit**

```bash
cd /home/ecs-user/alibaba-kube
git add stealth/package.json stealth/package-lock.json stealth/foundry.toml stealth/src/vendor
git -c user.name=lead -c user.email=lead@localhost commit -m "feat(stealth): vendor UniversalToken ERC-1400 (pinned, unmodified) with OZ 4 context remapping

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `DfabiBond` and Foundry tests

**Files:**
- Modify: `stealth/foundry.toml` (one line)
- Create: `stealth/src/DfabiBond.sol`
- Test: `stealth/test/DfabiBond.t.sol`

**Interfaces:**
- Consumes: `ERC1400`, `ERC1400TokensValidator` (Task 2); `ERC5564Announcer` (`announce(uint256,address,bytes,bytes)`, event `Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)`); `stealth/test/fixtures/erc1820-runtime.hex` (Task 1).
- Produces (Task 5 relies on exact names and on `forge build` writing `stealth/out/DfabiBond.sol/DfabiBond.json`, `stealth/out/ERC1400TokensValidator.sol/ERC1400TokensValidator.json`, `stealth/out/ERC5564Announcer.sol/ERC5564Announcer.json`): `constructor(string name_, string symbol_, address[] controllers_, bytes32[] defaultPartitions_, address announcer_)`; `issueByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag)` (minter only); `transferByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes data)` (`data` = certificate, last parameter); `announcer()`; errors `InvalidEphemeralPubKey()`, `ZeroAmount()`.

- [ ] **Step 1: Allow Foundry to read the fixture**

Append to `stealth/foundry.toml`:
```
fs_permissions = [{ access = "read", path = "./test/fixtures" }]
```

- [ ] **Step 2: Write the failing test**

`stealth/test/DfabiBond.t.sol`:
```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC5564Announcer} from "../src/ERC5564Announcer.sol";
import {DfabiBond} from "../src/DfabiBond.sol";
import {ERC1400TokensValidator} from "../src/vendor/universal-token/extensions/tokenExtensions/ERC1400TokensValidator.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool, address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function etch(address, bytes calldata) external;
    function readFile(string calldata) external view returns (string memory);
    function parseBytes(string calldata) external pure returns (bytes memory);
    function sign(uint256, bytes32) external pure returns (uint8, bytes32, bytes32);
    function addr(uint256) external pure returns (address);
    function warp(uint256) external;
}

contract DfabiBondTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    address constant ERC1820 = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;
    bytes32 constant TRANCHE_A = bytes32("TRANCHE-A");
    uint256 constant CUSTODIAN_KEY = 0xC0570D1A;
    uint256 constant ROGUE_KEY = 0xBAD;
    address constant SENDER = address(0x5E4DE2);
    address constant STEALTH = address(0x57EA17);
    address constant OTHER = address(0x07E2);

    address custodian;
    ERC5564Announcer announcer;
    ERC1400TokensValidator validator;
    DfabiBond token;

    // The test contract deploys everything, so it is the token owner.
    function setUp() public {
        vm.warp(1_000_000);
        vm.etch(ERC1820, vm.parseBytes(vm.readFile("test/fixtures/erc1820-runtime.hex")));
        custodian = vm.addr(CUSTODIAN_KEY);
        announcer = new ERC5564Announcer();
        validator = new ERC1400TokensValidator();
        address[] memory controllers = new address[](1);
        controllers[0] = custodian;
        bytes32[] memory defaults = new bytes32[](1);
        defaults[0] = TRANCHE_A;
        token = new DfabiBond("DFABI Series 1", "DFB1", controllers, defaults, address(announcer));
        token.setTokenExtension(address(validator), "ERC1400TokensValidator", true, false, false);
        validator.registerTokenSetup(
            address(token), ERC1400TokensValidator.CertificateValidation.NonceBased, true, false, false, false, new address[](0)
        );
        validator.addCertificateSigner(address(token), custodian);
        validator.addAllowlisted(address(token), custodian);
        token.addMinter(custodian);
    }

    // 89-byte announcement metadata, built independently of the contract's encoding.
    function _meta(bytes1 tag, uint256 amount, bytes32 partition) internal view returns (bytes memory) {
        return bytes.concat(tag, bytes4(0xf3d490db), bytes20(address(token)), bytes32(amount), partition);
    }

    function _eph(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i++) b[i] = 0x02;
    }

    function _fund(address to, uint256 amount) internal {
        vm.prank(custodian);
        token.issueByPartitionStealth(TRANCHE_A, to, amount, _eph(33), 0x20);
    }

    // The validator signs calldata minus its last 160 bytes (97-byte certificate padded to 128 + length word).
    function _strip(bytes memory b) internal pure returns (bytes memory) {
        assembly {
            mstore(b, sub(mload(b), 160))
        }
        return b;
    }

    function _certFor(address msgSender, bytes memory payloadWithoutCert, uint256 expiry, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        bytes32 inner = keccak256(
            abi.encodePacked(
                msgSender, address(token), payloadWithoutCert, expiry, validator.usedCertificateNonce(address(token), msgSender)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(token.generateDomainSeparator(), inner));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(expiry, r, s, v);
    }

    function _transferPayload(address to, uint256 value) internal view returns (bytes memory) {
        return _strip(abi.encodeCall(token.transferByPartitionStealth, (TRANCHE_A, to, value, _eph(33), 0x20, new bytes(97))));
    }

    function _certTransfer(address from, address to, uint256 value, uint256 expiry, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        return _certFor(from, _transferPayload(to, value), expiry, key);
    }

    function _send(address from, address to, uint256 value, bytes memory cert) internal {
        vm.prank(from);
        token.transferByPartitionStealth(TRANCHE_A, to, value, _eph(33), 0x20, cert);
    }

    bytes constant ERR_54 = abi.encodeWithSignature("Error(string)", "54");

    function test_setup_roles() public view {
        require(token.isMinter(custodian), "minter");
        require(validator.isCertificateSigner(address(token), custodian), "signer");
        require(token.announcer() == announcer, "announcer");
        require(token.granularity() == 1, "granularity");
    }

    function test_issue_only_minter() public {
        vm.prank(SENDER);
        vm.expectRevert();
        token.issueByPartitionStealth(TRANCHE_A, STEALTH, 1, _eph(33), 0x20);
    }

    function test_issue_moves_and_announces() public {
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(token), _eph(33), _meta(0x20, 1000, TRANCHE_A));
        _fund(STEALTH, 1000);
        require(token.balanceOfByPartition(TRANCHE_A, STEALTH) == 1000, "partition balance");
        require(token.balanceOf(STEALTH) == 1000, "balance");
        require(token.totalSupplyByPartition(TRANCHE_A) == 1000, "partition supply");
        require(token.totalSupply() == 1000, "supply");
    }

    function test_transfer_with_certificate_moves_and_announces() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 400, block.timestamp + 600, CUSTODIAN_KEY);
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(token), _eph(33), _meta(0x20, 400, TRANCHE_A));
        _send(SENDER, STEALTH, 400, cert);
        require(token.balanceOfByPartition(TRANCHE_A, STEALTH) == 400, "recipient");
        require(token.balanceOfByPartition(TRANCHE_A, SENDER) == 600, "remainder");
        require(token.totalSupplyByPartition(TRANCHE_A) == 1000, "supply");
        require(validator.usedCertificateNonce(address(token), SENDER) == 1, "nonce");
    }

    function test_transfer_without_certificate_reverts() public {
        _fund(SENDER, 1000);
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 400, "");
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 400, new bytes(97));
    }

    function test_transfer_with_expired_certificate_reverts() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 400, block.timestamp - 1, CUSTODIAN_KEY);
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 400, cert);
    }

    function test_transfer_with_wrong_signer_reverts() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 400, block.timestamp + 600, ROGUE_KEY);
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 400, cert);
    }

    function test_certificate_is_bound_to_recipient_and_amount() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 400, block.timestamp + 600, CUSTODIAN_KEY);
        vm.expectRevert(ERR_54);
        _send(SENDER, OTHER, 400, cert);
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 401, cert);
    }

    function test_certificate_cannot_be_replayed() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 100, block.timestamp + 600, CUSTODIAN_KEY);
        _send(SENDER, STEALTH, 100, cert);
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 100, cert);
    }

    function test_certificate_is_bound_to_sender() public {
        _fund(SENDER, 1000);
        _fund(OTHER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 100, block.timestamp + 600, CUSTODIAN_KEY);
        vm.expectRevert(ERR_54);
        _send(OTHER, STEALTH, 100, cert);
    }

    function test_bad_ephemeral_key_length_reverts() public {
        _fund(SENDER, 1000);
        uint256[4] memory lens = [uint256(0), 32, 34, 65];
        for (uint256 i; i < 4; i++) {
            vm.prank(custodian);
            vm.expectRevert(DfabiBond.InvalidEphemeralPubKey.selector);
            token.issueByPartitionStealth(TRANCHE_A, STEALTH, 1, _eph(lens[i]), 0x20);
            vm.prank(SENDER);
            vm.expectRevert(DfabiBond.InvalidEphemeralPubKey.selector);
            token.transferByPartitionStealth(TRANCHE_A, STEALTH, 1, _eph(lens[i]), 0x20, "");
        }
    }

    function test_zero_value_reverts() public {
        vm.prank(custodian);
        vm.expectRevert(DfabiBond.ZeroAmount.selector);
        token.issueByPartitionStealth(TRANCHE_A, STEALTH, 0, _eph(33), 0x20);
        vm.prank(SENDER);
        vm.expectRevert(DfabiBond.ZeroAmount.selector);
        token.transferByPartitionStealth(TRANCHE_A, STEALTH, 0, _eph(33), 0x20, "");
    }

    function test_erc20_paths_are_locked() public {
        _fund(SENDER, 1000);
        vm.prank(SENDER);
        vm.expectRevert(ERR_54);
        token.transfer(STEALTH, 1);
        vm.prank(SENDER);
        token.approve(OTHER, 10);
        vm.prank(OTHER);
        vm.expectRevert(ERR_54);
        token.transferFrom(SENDER, STEALTH, 1);
    }

    function test_redeem_needs_certificate() public {
        _fund(SENDER, 1000);
        vm.prank(SENDER);
        vm.expectRevert(ERR_54);
        token.redeemByPartition(TRANCHE_A, 100, "");
        bytes memory payload = _strip(abi.encodeCall(token.redeemByPartition, (TRANCHE_A, 100, new bytes(97))));
        bytes memory cert = _certFor(SENDER, payload, block.timestamp + 600, CUSTODIAN_KEY);
        vm.prank(SENDER);
        token.redeemByPartition(TRANCHE_A, 100, cert);
        require(token.totalSupplyByPartition(TRANCHE_A) == 900, "supply after redeem");
        require(token.balanceOfByPartition(TRANCHE_A, SENDER) == 900, "holder after redeem");
    }

    function test_document_can_be_set_and_read() public {
        vm.prank(custodian);
        token.setDocument("PROSPECTUS", "ipfs://prospectus", bytes32(uint256(0xD0C)));
        (string memory uri, bytes32 h,) = token.getDocument("PROSPECTUS");
        require(keccak256(bytes(uri)) == keccak256("ipfs://prospectus"), "uri");
        require(h == bytes32(uint256(0xD0C)), "hash");
    }
}
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd stealth && forge test --match-contract DfabiBondTest 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Error|not found|Source" | head -5`
Expected: compile failure because `../src/DfabiBond.sol` does not exist.

- [ ] **Step 4: Write the contract**

`stealth/src/DfabiBond.sol`:
```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC1400} from "./vendor/universal-token/ERC1400.sol";
import {ERC5564Announcer} from "./ERC5564Announcer.sol";

/// @notice DFABI bond: Consensys UniversalToken ERC-1400 (partitions are tranches) whose stealth issue and
/// transfer functions announce the stealth recipient (ERC-5564 scheme 1) in the same transaction. This
/// contract is the Announcement `caller`, so a scanner that filters on `caller == address(this)` can trust
/// the metadata. The inherited `transferByPartition`, operator and controller transfers announce nothing;
/// wallets must use `transferByPartitionStealth`.
/// @dev Certificate rule: the validator (ERC1400TokensValidator, nonce-based) verifies a custodian
/// signature over the calldata minus its LAST 160 bytes, so `data` (the 97-byte certificate) must stay the
/// last parameter of `transferByPartitionStealth`. The validator is configured in setup, not here.
contract DfabiBond is ERC1400 {
    error InvalidEphemeralPubKey();
    error ZeroAmount();

    ERC5564Announcer public immutable announcer;

    constructor(
        string memory name_,
        string memory symbol_,
        address[] memory controllers_,
        bytes32[] memory defaultPartitions_,
        address announcer_
    ) ERC1400(name_, symbol_, 1, controllers_, defaultPartitions_) {
        announcer = ERC5564Announcer(announcer_);
    }

    /// @notice Minter (the custodian) issues to a stealth address and announces. A certificate signer is
    /// exempt from the certificate check in the validator.
    function issueByPartitionStealth(
        bytes32 partition,
        address stealthAddress,
        uint256 value,
        bytes memory ephemeralPubKey,
        bytes1 viewTag
    ) external onlyMinter isIssuableToken {
        _checkAnnounce(value, ephemeralPubKey);
        _issueByPartition(partition, msg.sender, stealthAddress, value, "");
        _announce(partition, stealthAddress, value, ephemeralPubKey, viewTag);
    }

    /// @notice Holder transfers to a stealth address and announces. `data` is the custodian certificate.
    function transferByPartitionStealth(
        bytes32 partition,
        address stealthAddress,
        uint256 value,
        bytes memory ephemeralPubKey,
        bytes1 viewTag,
        bytes memory data
    ) external {
        _checkAnnounce(value, ephemeralPubKey);
        _transferByPartition(partition, msg.sender, msg.sender, stealthAddress, value, data, "");
        _announce(partition, stealthAddress, value, ephemeralPubKey, viewTag);
    }

    function _checkAnnounce(uint256 value, bytes memory ephemeralPubKey) private pure {
        if (ephemeralPubKey.length != 33) revert InvalidEphemeralPubKey();
        if (value == 0) revert ZeroAmount();
    }

    /// 89 bytes: viewTag (1) | transferByPartition selector (4) | token (20) | amount (32) | partition (32).
    function _announce(bytes32 partition, address stealthAddress, uint256 value, bytes memory ephemeralPubKey, bytes1 viewTag)
        private
    {
        announcer.announce(
            1,
            stealthAddress,
            ephemeralPubKey,
            abi.encodePacked(viewTag, bytes4(0xf3d490db), address(this), value, partition)
        );
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd stealth && forge test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^\[(PASS|FAIL)|Suite result|tests passed"`
Expected: all of `DfabiBondTest` (15 tests) pass and the run reports 34 tests passed in total (19 earlier + 15). Then `forge build --sizes 2>&1 | grep "^| DfabiBond "` shows a runtime size below 24,576 (about 18,233).

- [ ] **Step 6: Mutation checks (prove the tests can fail)**

Do each mutation on its own, run the named test, expect FAIL, then restore from the backup.

1. Announced amount: in `stealth/src/DfabiBond.sol` change `address(this), value, partition)` to `address(this), value + 1, partition)`:
```bash
T=$(mktemp -d)
cd /home/ecs-user/alibaba-kube/stealth
cp src/DfabiBond.sol $T/DfabiBond.sol.bak
sed -i 's/address(this), value, partition)/address(this), value + 1, partition)/' src/DfabiBond.sol
forge test --match-contract DfabiBondTest 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^\[FAIL" | cut -c1-120
cp $T/DfabiBond.sol.bak src/DfabiBond.sol
```
Expected: `test_issue_moves_and_announces` and `test_transfer_with_certificate_moves_and_announces` FAIL.

2. Allowlist lock: in `stealth/test/DfabiBond.t.sol` change the `registerTokenSetup(...)` argument list `NonceBased, true, false, false, false` to `NonceBased, false, false, false, false`:
```bash
T=$(mktemp -d)
cp test/DfabiBond.t.sol $T/DfabiBond.t.sol.bak
sed -i 's/NonceBased, true, false, false, false/NonceBased, false, false, false, false/' test/DfabiBond.t.sol
forge test --match-test test_erc20_paths_are_locked 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^\[(PASS|FAIL)"
cp $T/DfabiBond.t.sol.bak test/DfabiBond.t.sol
```
Expected: `test_erc20_paths_are_locked` FAILS (the ERC-20 transfer goes through once the allowlist is off). After restoring, `forge test` is back to 34 passed.

- [ ] **Step 7: Commit**

```bash
cd /home/ecs-user/alibaba-kube
git status --short stealth   # only foundry.toml, src/DfabiBond.sol, test/DfabiBond.t.sol
git add stealth/foundry.toml stealth/src/DfabiBond.sol stealth/test/DfabiBond.t.sol
git -c user.name=lead -c user.email=lead@localhost commit -m "feat(stealth): DFABI bond token (ERC-1400 with stealth issue/transfer and announcements)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: TypeScript bond helper and certificate vector

**Files:**
- Create: `stealth/ts/bond.ts`
- Test: `stealth/ts/bond.test.ts`
- Create: `stealth/test/CertificateVector.t.sol`

**Interfaces:**
- Consumes: `deriveStealth`, `generateMetaAddress`, `scan`, `Announcement` from `stealth/ts/stealth.ts`.
- Produces (Task 5 relies on these exact exports): `buildBondMetadata(viewTag: string, token: string, amount: bigint, partition: string): string`; `parseBondMetadata(metadata: string): { viewTag: string; token: string; amount: bigint; partition: string } | null`; `CERTIFICATE_LENGTH` (= 97); `payloadWithoutCertificate(calldata: string): string`; `type CertificateParams = { domainSeparator: string; msgSender: string; token: string; payload: string; expiry: bigint; nonce: bigint }`; `certificateDigest(p: CertificateParams): string`; `signCertificate(custodianKey: string, p: CertificateParams): string` (97-byte `0x` hex).

- [ ] **Step 1: Write the failing test**

`stealth/ts/bond.test.ts`:
```ts
import { Interface, SigningKey, computeAddress, getBytes, hexlify, recoverAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_LENGTH,
  buildBondMetadata,
  certificateDigest,
  parseBondMetadata,
  payloadWithoutCertificate,
  signCertificate,
} from './bond.ts';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from './stealth.ts';

const TOKEN = '0xD8606eD2ecDB71fdcb8cCA8fA1925ff84238f2a9';
const TRANCHE_A = '0x5452414e4348452d410000000000000000000000000000000000000000000000'; // bytes32("TRANCHE-A")
const GOLDEN =
  '0x20f3d490dbd8606ed2ecdb71fdcb8cca8fa1925ff84238f2a900000000000000000000000000000000000000000000000000000000000003e85452414e4348452d410000000000000000000000000000000000000000000000';

describe('buildBondMetadata', () => {
  it('matches the golden 89-byte vector', () => {
    expect(buildBondMetadata('0x20', TOKEN, 1000n, TRANCHE_A)).toBe(GOLDEN);
    expect((GOLDEN.length - 2) / 2).toBe(89);
  });

  it('throws on bad input', () => {
    expect(() => buildBondMetadata('0x2000', TOKEN, 1n, TRANCHE_A)).toThrow();
    expect(() => buildBondMetadata('0x20', '0x1234', 1n, TRANCHE_A)).toThrow();
    expect(() => buildBondMetadata('0x20', TOKEN, -1n, TRANCHE_A)).toThrow();
    expect(() => buildBondMetadata('0x20', TOKEN, 2n ** 256n, TRANCHE_A)).toThrow();
    expect(() => buildBondMetadata('0x20', TOKEN, 1n, '0x5452')).toThrow();
  });
});

describe('parseBondMetadata', () => {
  it('round-trips and parses the golden vector', () => {
    expect(parseBondMetadata(GOLDEN)).toEqual({ viewTag: '0x20', token: TOKEN, amount: 1000n, partition: TRANCHE_A });
    expect(parseBondMetadata(buildBondMetadata('0x7f', TOKEN, 123456789n, TRANCHE_A))?.amount).toBe(123456789n);
  });

  // Never throws, always null for anything that is not the 89-byte form.
  it('returns null for anything else', () => {
    const body = GOLDEN.slice(2);
    const rd57 = '0x20a9059cbbd8606ed2ecdb71fdcb8cca8fa1925ff84238f2a900000000000000000000000000000000000000000000000000000000000003e8';
    for (const bad of [
      '0x',
      '0x20',
      rd57, // RD token metadata
      '0x' + body.slice(0, 88 * 2),
      GOLDEN + '00',
      '0x20' + 'deadbeef' + body.slice(10),
      'not hex',
      '',
    ]) {
      expect(parseBondMetadata(bad)).toBeNull();
    }
  });
});

describe('certificate', () => {
  // Same inputs and expected values are pinned in test/CertificateVector.t.sol, which checks them with
  // abi.encodePacked and ecrecover. The digest here was produced by manual byte concatenation.
  const params = {
    domainSeparator: '0x' + '11'.repeat(32),
    msgSender: '0x00000000000000000000000000000000000A11CE',
    token: '0x000000000000000000000000000000000000DFAB',
    payload: '0x0102030405',
    expiry: 2000000000n,
    nonce: 7n,
  };
  const KEY = '0x00000000000000000000000000000000000000000000000000000000C0570D1A';
  const DIGEST = '0xddaa44b410b3e9fe06d836fcc8d71e4343a24f58b1757b285252b6e941a9fa7c';
  const CERT =
    '0x00000000000000000000000000000000000000000000000000000000773594007440fafcd4b250b61e5c90fe16b579ed2f89e7fbcb775173b7eaf2c5694733f1422c40d3ac9ae04a87702e59353bbb935efc24f6f5973aa1a369cb8f2ecbbcef1b';

  it('digest and certificate match the golden vector', () => {
    expect(certificateDigest(params)).toBe(DIGEST);
    expect(signCertificate(KEY, params)).toBe(CERT);
    expect(getBytes(CERT)).toHaveLength(CERTIFICATE_LENGTH);
  });

  it('the certificate recovers to the custodian key', () => {
    const b = getBytes(CERT);
    const r = hexlify(b.slice(32, 64));
    const s = hexlify(b.slice(64, 96));
    expect(recoverAddress(DIGEST, { r, s, v: b[96] })).toBe(computeAddress(new SigningKey(KEY).publicKey));
  });

  it('every parameter changes the digest', () => {
    const base = certificateDigest(params);
    expect(certificateDigest({ ...params, nonce: 8n })).not.toBe(base);
    expect(certificateDigest({ ...params, expiry: 2000000001n })).not.toBe(base);
    expect(certificateDigest({ ...params, payload: '0x0102030406' })).not.toBe(base);
    expect(certificateDigest({ ...params, msgSender: TOKEN })).not.toBe(base);
    expect(certificateDigest({ ...params, token: TOKEN })).not.toBe(base);
    expect(certificateDigest({ ...params, domainSeparator: '0x' + '22'.repeat(32) })).not.toBe(base);
  });

  it('throws on bad input', () => {
    expect(() => certificateDigest({ ...params, domainSeparator: '0x1234' })).toThrow();
    expect(() => certificateDigest({ ...params, msgSender: '0x1234' })).toThrow();
    expect(() => certificateDigest({ ...params, nonce: -1n })).toThrow();
    expect(() => certificateDigest({ ...params, expiry: 2n ** 256n })).toThrow();
  });

  it('payloadWithoutCertificate strips exactly the 160-byte tail of the real call layout', () => {
    const iface = new Interface([
      'function transferByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes data)',
    ]);
    const call = (data: Uint8Array) =>
      iface.encodeFunctionData('transferByPartitionStealth', [TRANCHE_A, TOKEN, 400n, '0x' + '02'.repeat(33), '0x20', data]);
    const withPlaceholder = call(new Uint8Array(CERTIFICATE_LENGTH));
    const withRealCert = call(getBytes(signCertificate(KEY, params)));
    // The signed payload is identical whatever the certificate bytes are.
    expect(payloadWithoutCertificate(withPlaceholder)).toBe(payloadWithoutCertificate(withRealCert));
    expect(getBytes(withPlaceholder).length - getBytes(payloadWithoutCertificate(withPlaceholder)).length).toBe(160);
    expect(() => payloadWithoutCertificate('0x' + '00'.repeat(160))).toThrow();
  });
});

describe('with scan', () => {
  it('scan still finds an announcement whose metadata is bond metadata', () => {
    const me = generateMetaAddress();
    const s = deriveStealth(me.metaAddress);
    const ann: Announcement = {
      schemeId: 1n,
      stealthAddress: s.stealthAddress,
      ephemeralPubKey: s.ephemeralPubKey,
      metadata: buildBondMetadata(s.viewTag, TOKEN, 400n, TRANCHE_A),
    };
    expect(scan([ann], me.viewKey, me.spendKey).map((f) => f.stealthAddress)).toEqual([s.stealthAddress]);
    expect(parseBondMetadata(ann.metadata)?.partition).toBe(TRANCHE_A);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd stealth && npx vitest run ts/bond.test.ts 2>&1 | grep -E "Error|Failed|Cannot find" | head -3`
Expected: fails because `./bond.ts` does not exist.

- [ ] **Step 3: Write the module**

`stealth/ts/bond.ts`:
```ts
import { SigningKey, concat, dataLength, getAddress, getBytes, hexlify, isAddress, keccak256, toBeHex } from 'ethers';

// Announcement metadata of DfabiBond, 89 bytes:
// viewTag (1) | transferByPartition(bytes32,address,uint256,bytes) selector (4) | token (20) | amount (32) | partition (32).
const TRANSFER_BY_PARTITION_SELECTOR = '0xf3d490db';
const LENGTH = 89;

export function buildBondMetadata(viewTag: string, token: string, amount: bigint, partition: string): string {
  if (dataLength(viewTag) !== 1) throw new Error('viewTag must be 1 byte');
  if (!isAddress(token)) throw new Error('token must be an address');
  if (amount < 0n || amount >= 2n ** 256n) throw new Error('amount out of uint256 range');
  if (dataLength(partition) !== 32) throw new Error('partition must be 32 bytes');
  return concat([viewTag, TRANSFER_BY_PARTITION_SELECTOR, token, toBeHex(amount, 32), partition]);
}

// Anyone can post any metadata, so this never throws: null means "not DfabiBond-style metadata".
export function parseBondMetadata(
  metadata: string,
): { viewTag: string; token: string; amount: bigint; partition: string } | null {
  try {
    const b = getBytes(metadata);
    if (b.length !== LENGTH || hexlify(b.slice(1, 5)) !== TRANSFER_BY_PARTITION_SELECTOR) return null;
    return {
      viewTag: hexlify(b.slice(0, 1)),
      token: getAddress(hexlify(b.slice(5, 25))),
      amount: BigInt(hexlify(b.slice(25, 57))),
      partition: hexlify(b.slice(57)),
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
```

- [ ] **Step 4: Add the Solidity side of the vector**

`stealth/test/CertificateVector.t.sol`:
```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface Vm {
    function addr(uint256) external pure returns (address);
}

/// Cross-language check: the same inputs and expected values are pinned in ts/bond.test.ts, where the digest
/// came from manual byte concatenation and the certificate from ethers' SigningKey. Here the digest is
/// rebuilt with abi.encodePacked (the validator's rule) and the certificate is checked with ecrecover.
contract CertificateVectorTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function test_digest_and_certificate_match_typescript_vector() public view {
        bytes32 domainSeparator = bytes32(hex"1111111111111111111111111111111111111111111111111111111111111111");
        address msgSender = address(uint160(0xA11CE));
        address token = address(uint160(0xDFAB));
        bytes memory payload = hex"0102030405";
        uint256 expiry = 2000000000;
        uint256 nonce = 7;

        bytes32 digest = keccak256(
            abi.encodePacked(domainSeparator, keccak256(abi.encodePacked(msgSender, token, payload, expiry, nonce)))
        );
        require(digest == 0xddaa44b410b3e9fe06d836fcc8d71e4343a24f58b1757b285252b6e941a9fa7c, "digest");

        bytes32 r = 0x7440fafcd4b250b61e5c90fe16b579ed2f89e7fbcb775173b7eaf2c5694733f1;
        bytes32 s = 0x422c40d3ac9ae04a87702e59353bbb935efc24f6f5973aa1a369cb8f2ecbbcef;
        require(ecrecover(digest, 27, r, s) == vm.addr(0xC0570D1A), "signer");
    }
}
```

- [ ] **Step 5: Run everything**

```bash
cd /home/ecs-user/alibaba-kube/stealth
npx tsc --noEmit && echo tsc-ok
npx vitest run 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Test Files|Tests"
forge test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "tests passed|FAIL"
```
Expected: `tsc-ok`; vitest `3 passed` files and `31 passed` tests (21 earlier + 10 new); forge `35 tests passed` (34 + the vector test).

- [ ] **Step 6: Commit**

```bash
cd /home/ecs-user/alibaba-kube
git add stealth/ts/bond.ts stealth/ts/bond.test.ts stealth/test/CertificateVector.t.sol
git -c user.name=lead -c user.email=lead@localhost commit -m "feat(stealth): bond metadata and custodian certificate helper with cross-language vector

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Besu smoke script and live run

**Files:**
- Create: `stealth/script/smoke-bond.ts`
- Modify: `docs/superpowers/specs/2026-10-15-dfabi-bond-token-design.md` (section 8)

**Interfaces:**
- Consumes: `DfabiBond`, `ERC1400TokensValidator`, `ERC5564Announcer` artifacts (Task 3); `bond.ts` exports (Task 4); the ERC1820 registry on Besu (Task 1); `deriveStealth`, `generateMetaAddress`, `scan`, `Announcement` from `stealth.ts`.
- Produces: the live evidence recorded in the spec.

- [ ] **Step 1: Write the smoke script**

`stealth/script/smoke-bond.ts`:
```ts
// One-off DFABI bond smoke check against a live Besu network. Not part of CI.
// Needs the ERC1820 registry (node script/deploy-erc1820.ts).
// Usage: forge build && set -a && . ./.env.smoke && set +a && node script/smoke-bond.ts
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, encodeBytes32String } from 'ethers';
import { buildBondMetadata, CERTIFICATE_LENGTH, parseBondMetadata, payloadWithoutCertificate, signCertificate } from '../ts/bond.ts';
import { deriveStealth, generateMetaAddress, scan, type Announcement } from '../ts/stealth.ts';

const { RPC_URL, DEPLOYER_KEY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY) throw new Error('set RPC_URL and DEPLOYER_KEY');

// cacheTimeout -1: ethers otherwise reuses identical read results for 250 ms, which hides a state change just mined.
const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
// The deployer plays owner, minter, controller and certificate signer (the custodian); production would split them.
const custodian = new Wallet(DEPLOYER_KEY, provider);
const TRANCHE_A = encodeBytes32String('TRANCHE-A');

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('FAILED: ' + msg);
}

async function reverts(call: Promise<unknown>, reason: string, msg: string): Promise<void> {
  try {
    await call;
  } catch (e: any) {
    check(e.reason === reason, `${msg} (expected revert "${reason}", got ${e.reason ?? e.shortMessage ?? e.message})`);
    return;
  }
  throw new Error(`FAILED: ${msg} (did not revert)`);
}

async function deploy(name: string, ...args: unknown[]): Promise<Contract> {
  const { abi, bytecode } = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
  const c = await new ContractFactory(abi, bytecode.object, custodian).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

const net = await provider.getNetwork();
const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
console.log('chainId', net.chainId.toString(), '| gasPrice', gasPrice.toString());
check((await provider.getCode('0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24')) !== '0x', 'ERC1820 registry is deployed');

// Besu caps the eth_getLogs range, so read from the block before the deploy.
const fromBlock = await provider.getBlockNumber();
const announcer = await deploy('ERC5564Announcer');
const validator = await deploy('ERC1400TokensValidator');
const token = await deploy('DfabiBond', 'DFABI Series 1', 'DFB1', [custodian.address], [TRANCHE_A], await announcer.getAddress());
const tokenAddr = await token.getAddress();
const validatorAddr = await validator.getAddress();
console.log('announcer', await announcer.getAddress(), '| validator', validatorAddr, '| bond', tokenAddr);

// Setup: validator in nonce-based certificate mode, custodian as certificate signer, allowlist = custodian only
// (this is what locks the ERC-20 transfer path), custodian is already minter and controller.
const setup = [
  () => token.setTokenExtension(validatorAddr, 'ERC1400TokensValidator', true, false, false),
  () => validator.registerTokenSetup(tokenAddr, 1, true, false, false, false, []),
  () => validator.addCertificateSigner(tokenAddr, custodian.address),
  () => validator.addAllowlisted(tokenAddr, custodian.address),
];
for (const send of setup) await (await send()).wait(); // one at a time: they share the deployer's nonce

// The custodian signs the calldata of the exact call the holder will make, minus the certificate argument.
async function certificate(fn: string, holder: string, args: unknown[]): Promise<string> {
  const placeholder = token.interface.encodeFunctionData(fn, [...args, new Uint8Array(CERTIFICATE_LENGTH)]);
  const { timestamp } = (await provider.getBlock('latest'))!;
  return signCertificate(DEPLOYER_KEY!, {
    domainSeparator: await token.generateDomainSeparator(),
    msgSender: holder,
    token: tokenAddr,
    payload: payloadWithoutCertificate(placeholder),
    expiry: BigInt(timestamp) + 600n,
    nonce: await validator.usedCertificateNonce(tokenAddr, holder),
  });
}

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

// 1. The custodian issues 1000 units of tranche A to bank A at a stealth address.
const toA = deriveStealth(bankA.metaAddress);
await (await token.issueByPartitionStealth(TRANCHE_A, toA.stealthAddress, 1000n, toA.ephemeralPubKey, toA.viewTag)).wait();

// 2. Bank A scans only the token's own announcements and checks the metadata against the chain.
const annsA = await announcements(true);
const [foundA, ...restA] = scan(annsA, bankA.viewKey, bankA.spendKey);
check(foundA && restA.length === 0, 'bank A finds exactly one payment');
const metaA = parseBondMetadata(annsA.find((a) => a.stealthAddress === foundA.stealthAddress)!.metadata);
check(metaA && metaA.token === tokenAddr && metaA.amount === 1000n && metaA.partition === TRANCHE_A, 'metadata says 1000 of tranche A of this token');
check((await token.balanceOfByPartition(TRANCHE_A, foundA.stealthAddress)) === 1000n, 'bank A stealth address holds 1000 of tranche A');
check((await provider.getBalance(foundA.stealthAddress)) === 0n, 'bank A stealth address has no native balance');

// 3. Bank A sends 400 to bank B from its unfunded stealth address: refused without a certificate,
//    refused through the ERC-20 path, accepted with the custodian's certificate.
const walletA = new Wallet(foundA.privateKey, provider);
const toB = deriveStealth(bankB.metaAddress);
const sendArgs = [TRANCHE_A, toB.stealthAddress, 400n, toB.ephemeralPubKey, toB.viewTag];
const asA = token.connect(walletA);
await reverts(asA.getFunction('transferByPartitionStealth').staticCall(...sendArgs, '0x'), '54', 'transfer without a certificate');
await reverts(asA.getFunction('transfer').staticCall(toB.stealthAddress, 1n), '54', 'ERC-20 transfer is locked');
const cert = await certificate('transferByPartitionStealth', foundA.stealthAddress, sendArgs);
await (await asA.getFunction('transferByPartitionStealth')(...sendArgs, cert, { gasPrice })).wait();
check((await token.balanceOfByPartition(TRANCHE_A, foundA.stealthAddress)) === 600n, 'bank A keeps the 600 remainder');
await reverts(asA.getFunction('transferByPartitionStealth').staticCall(...sendArgs, cert), '54', 'the same certificate cannot be replayed');

// 4. Bank B scans and finds 400 of tranche A.
const annsB = await announcements(true);
const [foundB, ...restB] = scan(annsB, bankB.viewKey, bankB.spendKey);
check(foundB && restB.length === 0, 'bank B finds exactly one payment');
const metaB = parseBondMetadata(annsB.find((a) => a.stealthAddress === foundB.stealthAddress)!.metadata);
check(metaB && metaB.token === tokenAddr && metaB.amount === 400n && metaB.partition === TRANCHE_A, 'bank B metadata says 400 of tranche A');
check((await token.balanceOfByPartition(TRANCHE_A, foundB.stealthAddress)) === 400n, 'bank B stealth address holds 400');

// 5. Forged announcement: the custodian wallet posts bond-looking metadata straight to the Announcer for bank B.
//    It carries caller = that wallet, not the token, so the token-filtered scan must not see it.
const forged = deriveStealth(bankB.metaAddress);
await (await announcer.announce(1, forged.stealthAddress, forged.ephemeralPubKey, buildBondMetadata(forged.viewTag, tokenAddr, 999n, TRANCHE_A))).wait();
check(scan(await announcements(false), bankB.viewKey, bankB.spendKey).length === 2, 'unfiltered scan sees the forgery');
check(scan(await announcements(true), bankB.viewKey, bankB.spendKey).length === 1, 'token-filtered scan ignores the forgery');
check((await token.balanceOfByPartition(TRANCHE_A, forged.stealthAddress)) === 0n, 'forged address holds nothing');

// 6. Both banks redeem what they hold (each redemption needs a certificate); tranche supply returns to 0.
const walletB = new Wallet(foundB.privateKey, provider);
for (const [wallet, amount] of [[walletB, 400n], [walletA, 600n]] as const) {
  const args = [TRANCHE_A, amount];
  const c = await certificate('redeemByPartition', wallet.address, args);
  await (await token.connect(wallet).getFunction('redeemByPartition')(...args, c, { gasPrice })).wait();
}
check((await token.totalSupplyByPartition(TRANCHE_A)) === 0n, 'tranche A supply is 0 after redemptions');
check((await token.totalSupply()) === 0n, 'total supply is 0 after redemptions');

console.log('OK: issue, scan, certified transfer, no-certificate / ERC-20 / replay refused, forgery ignored, redeem; final supply 0');
process.exit(0);
```

- [ ] **Step 2: Type-check and rehearse on a local node**

The local node reports a gas price of 1 gwei even when started at zero, and stealth addresses hold no gas, so the rehearsal uses a temporary copy that forces gas price 0.

```bash
T=$(mktemp -d)
cd /home/ecs-user/alibaba-kube/stealth
npx tsc --noEmit && echo tsc-ok
forge build >/dev/null 2>&1
(anvil --silent --port 8599 --gas-price 0 --block-base-fee-per-gas 0 >/dev/null 2>&1 & echo $! > $T/anvil.pid); sleep 3
export RPC_URL=http://127.0.0.1:8599 DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
node script/deploy-erc1820.ts
sed 's|(await provider.getFeeData()).gasPrice ?? 0n|0n|' script/smoke-bond.ts > script/smoke-bond-local.ts
node script/smoke-bond-local.ts
rm script/smoke-bond-local.ts
kill $(cat $T/anvil.pid)
```
Expected: `tsc-ok`, then `ERC1820 registry at ...`, then `smoke-bond-local.ts` prints `OK: issue, scan, certified transfer, no-certificate / ERC-20 / replay refused, forgery ignored, redeem; final supply 0`. If the rehearsal fails for any other reason, fix the script before touching Besu. Make sure `script/smoke-bond-local.ts` is deleted.

- [ ] **Step 3: Run it live on Besu**

This deploys three throwaway contracts (Announcer, validator, bond) on the live `besu` network. They are not for use afterwards.

```bash
T=$(mktemp -d)
cd /home/ecs-user/alibaba-kube/stealth
export KUBECONFIG=/home/ecs-user/alibaba-kube/alibaba.yaml
(kubectl -n besu port-forward pod/besu-node-validator-1-0 8545:8545 >$T/pf.log 2>&1 & echo $! > $T/pf.pid); sleep 4
forge build >/dev/null 2>&1
set -a && . ./.env.smoke && set +a
node script/smoke-bond.ts
kill $(cat $T/pf.pid)
```
Expected: `chainId 1337 | gasPrice 0`, the three contract addresses, then the final `OK:` line. Copy the three addresses. If any check fails, record the failure text in the spec exactly and stop; do not edit vendor code.

- [ ] **Step 4: Record the results in the spec**

Append to section 8 of `docs/superpowers/specs/2026-10-15-dfabi-bond-token-design.md`:

```markdown
- Live smoke <date>, `stealth/script/smoke-bond.ts` against the shipped contracts (repository HEAD `<short sha>` when it ran), passed on the first attempt (or: list each failure and what fixed it). Chain id `1337`, gas price `0`; stealth addresses sent and redeemed with no funding and the script asserts bank A's stealth address holds `0` native balance.
- All checks passed: the custodian issued 1000 of tranche A to bank A; A's scan over only the token's own announcements found exactly one payment whose on-chain metadata (token, amount 1000, tranche A) matched `balanceOfByPartition`; a transfer without a certificate and an ERC-20 `transfer` were both refused with `"54"`; A sent 400 to B with a custodian certificate and kept 600; replaying the same certificate was refused; B's scan found exactly one payment (400, tranche A); a forged announcement with bond-looking metadata appeared in the unfiltered scan but not in the `caller`-filtered scan and its address held 0; both banks redeemed with certificates and tranche and total supply ended at 0.
- Throwaway contracts left on the network, not for use: Announcer `<address>`, validator `<address>`, bond `<address>`.
- Not exercised live: expired, wrong-signer, wrong-recipient, wrong-amount and wrong-sender certificates, bad ephemeral key lengths, zero value, non-minter issue (Foundry suite only).
```
Fill `<date>`, `<short sha>` (run `git rev-parse --short HEAD`) and the three addresses from Step 3; keep the "(or: ...)" clause only if something did fail.

- [ ] **Step 5: Final check and commit**

```bash
cd /home/ecs-user/alibaba-kube/stealth
npx tsc --noEmit && npx vitest run 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Tests " ; forge test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "tests passed"
cd .. && git add stealth/script/smoke-bond.ts docs/superpowers/specs/2026-10-15-dfabi-bond-token-design.md
git -c user.name=lead -c user.email=lead@localhost commit -m "feat(stealth): bond smoke script and Besu results

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Expected: `Tests  31 passed (31)`, `35 tests passed`.
