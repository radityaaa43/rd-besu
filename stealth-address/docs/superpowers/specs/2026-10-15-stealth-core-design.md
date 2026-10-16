# Stealth core (ERC-5564 + ERC-6538) design

Date: 2026-10-15
Status: approved 2026-10-15; implemented, results in section 6
Part of: privacy-enabled RD + DFABI directly on Hyperledger Besu (no Paladin).

## 1. Why

RD (cash) and DFABI (bond) must hide **who the recipient is** from other banks and nodes. Paladin cannot do this
for us: its key manager only derives HD-path keys from a seed and has no way to hold an arbitrary derived
private key, so a Noto UTXO owned by an ERC-5564 stealth address could not be signed for (checked in
`eksplorasi-paladin/paladin/core/go/internal/keymanager` and `toolkit/go/pkg/signer`; the version running on ACK was
not compared). So the new rail talks to Besu directly.

Threat model (user, 2026-10-15): other banks/nodes must not link a recipient to a transfer. Out of scope: sender,
amount and token stay public; the custodian may see recipients (needed for KYC/audit, see sub-project 3).

## 2. Decomposition

| # | Sub-project | Depends on |
|---|---|---|
| 1 | **Stealth core** (this spec): Announcer, Registry, TypeScript library | none |
| 2 | RD: ERC-20 cash with stealth send | 1 |
| 3 | DFABI: Consensys UniversalToken (ERC-1400 family) per series; partitions = tranches; ERC-1643 documents; custom validator checking a custodian-signed certificate for stealth recipients | 1 |
| 4 | DvP: bond <-> RD swap using per-partition allowance | 2, 3 |

Each gets its own spec, plan and implementation. 2 to 4 are not designed here.

## 3. Decisions

| Topic | Decision |
|---|---|
| Scheme | ERC-5564 scheme id `1` (secp256k1 with view tags). The only standard scheme. |
| Contracts | Written by us from the two EIP interfaces (each is under 40 lines). No copied code, so no licence question. |
| ERC-6538 scope | `registerKeys`, `registerKeysOnBehalf` (EIP-712, EOA and ERC-1271 signers, DOMAIN_SEPARATOR recomputed on a chain-id change), `stealthMetaAddressOf`, `incrementNonce`, `nonceOf`. Full ERC-6538 interface, implemented 2026-10-16 (it was skipped at first). Differences from ScopeLift: signatures are checked with OZ `ECDSA` plus an ERC-1271 call (a bad EOA signature reverts with `ERC6538Registry__InvalidSignature`, not empty data), and scheme-1 meta-addresses must be exactly 66 bytes in both register functions. |
| Metadata | Announcement `metadata` is the 1-byte view tag only. Sub-projects 2 and 3 extend it with token and amount if they want scanners to see them. |
| Library deps | `ethers` 6.17 and `@noble/curves` 1.2.0, both already installed under `backend/`. No new dependency. |
| EVM version | `shanghai`, same as `Paladin/contracts/foundry.toml`. Confirm it deploys on the ACK Besu network (section 6). |
| Location | New top-level `stealth/`, separate from `Paladin/` and `backend/`. |

## 4. Contracts (`stealth/src`)

`ERC5564Announcer.sol`

- `event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)`
- `function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata) external` emits the event with `caller = msg.sender`. No storage, no access control (the standard requires it to be open).

`ERC6538Registry.sol`

- `mapping(address => mapping(uint256 => bytes)) public stealthMetaAddressOf`
- `mapping(address => uint256) public nonceOf`
- `registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress)` stores for `msg.sender`, emits `StealthMetaAddressSet(registrant, schemeId, stealthMetaAddress)`.
- `incrementNonce()` bumps `nonceOf[msg.sender]`, emits `NonceIncremented`.
- Reverts on a scheme-1 meta-address that is not 66 bytes.

## 5. Library (`stealth/ts`)

Meta-address = 33-byte compressed spend public key || 33-byte compressed view public key. String form
`st:eth:0x<66 bytes hex>`.

| Function | Who | Does |
|---|---|---|
| `generateMetaAddress()` | recipient | New spend and view private keys, returns keys and the meta-address. |
| `deriveStealth(metaAddress)` | sender | Ephemeral key `r`, `R = r*G`, shared secret `s = r*V` (compressed, 33 bytes), `h = keccak256(s)`, `P = P_spend + h*G`. Returns `{ stealthAddress, ephemeralPubKey, viewTag }` where `viewTag` is the first byte of `h`. |
| `scan(announcements, viewKey, spendKey)` | recipient | For each announcement: `s = v*R` (compressed, 33 bytes), `h = keccak256(s)`, skip when the first byte of `h` differs from the view tag, else derive the address and, on a match, return `{ stealthAddress, privateKey = (k_spend + h) mod n }`. |

Shared-secret encoding: `h = keccak256(compressed ECDH point, 33 bytes)`, as the ScopeLift reference SDK does
(`keccak256(getSharedSecret(priv, pub))` with noble's default compressed output; read from
`src/utils/crypto/generateStealthAddress.ts`, 2026-10-15). An earlier draft of this spec said the 32-byte
x-coordinate; that was wrong and was corrected before implementation. It is pinned by a fixed test vector generated
by the reference SDK. If our output differs from the vector, our code is wrong, not the vector. The view tag is the
first byte of `h`.

## 6. Tests and checks

1. **Foundry** (`stealth/test`): Announcer emits the right fields; Registry stores per `(registrant, schemeId)`, rejects a wrong-length meta-address, and nonce increments.
2. **Library round trip** (vitest): `generateMetaAddress` -> `deriveStealth` -> `scan` returns the same address, and a `Wallet` built from the returned private key reports that address. Plus a non-matching announcement is skipped, and the reference vector matches.
3. **Besu smoke script** (`stealth/script`): deploy both contracts to the ACK Besu network, register keys, announce, scan the chain logs, and sign a transaction from the recovered stealth key. Prints chain id and gas price; **record them in this spec**, because sub-project 2 needs to know whether stealth addresses must be gas-sponsored. This is a throwaway-style check run once, not a CI test.

**Results (2026-10-15, ACK `besu` namespace, via `besu-node-validator-1-0`):**

- Chain id `1337`. Gas price `0`: a fresh stealth address can send a transaction with no funding, so **sub-project 2 needs no gas sponsor** on this network.
- EVM `shanghai` bytecode deploys and runs.
- Full flow passed: register meta-address, derive, announce, `scan` over chain logs recovers the address, and a transaction sent from the recovered key is signed by the stealth address.
- Besu rejects `eth_getLogs` from block 0 (`-32005 Requested range exceeds maximum RPC range limit`). Scanners must read from a start block in bounded ranges. Sub-projects 2 and 3 must keep a scan checkpoint; the smoke script now reads from the block before deploy.
- Contracts left on the network by the runs (throwaway, not for use): announcers `0x9703b5dBDdd7B027f5A82966E6924fBDEf67623f`, `0x7C298D65C6922AFEBDE2D91c48cFcE680394f009`; registries `0x15edd73F33284b40DEA47A1aa847e1cfC0C5666d`, `0xC80491851552a08F6C742DE8EBC643cB2777ead2`. The first run failed at the log read, so two deployments exist. The pair from the passing run is the second.

Not done here: sponsoring gas for stealth addresses, token transfers, KYC/whitelist, DvP.

## 7. Risks

- Announcement events are public and scannable by anyone; privacy rests on keeping the view key secret. Losing a view key exposes every past recipient of that investor.
- Anyone can call `announce` with garbage, so scanners must tolerate noise (the view tag filter handles cost, not correctness).
- A fresh stealth address holds no gas. If Besu gas price is not zero, sub-project 2 needs a sponsor.
