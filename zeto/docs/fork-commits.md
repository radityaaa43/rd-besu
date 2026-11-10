# Fork commits not in upstream (tracking table)

Our Paladin fork: `radityaaa43/paladin` branch `lensa/prepare-dispatch-flush` at `0da5af7b6`, origin `LFDT-Paladin/paladin`. It is the image the cluster runs (`ghcr.io/radityaaa43/paladin@sha256:6f113f38…`; the image-to-commit link is from project notes, [unverified] against the registry).
Base: upstream `main` merge base `559567e38` (2026-10-06, PR #1377). Counted with `git log origin/main..HEAD` on 2026-11-10 (`origin/main` = `66a554f5e`): **68 commits = 50 + 13 merges (PR #1189 branch) + 5 fork-only**. Diff: 175 files, +21,949 / -11,699.
Goal of this file: track upstream status so the fork can shrink when upstream catches up. States read with `gh` on 2026-11-10.

## Summary

| Group | Commits | Upstream | State | Notes |
|---|---|---|---|---|
| A. Zeto V1 / v0.5.x multi-version support | 50 non-merge + 13 merges | LFDT-Paladin/paladin#1189 "Zeto V1 support with multi-version support" | **OPEN**, 62 commits, not draft, review required, last update 2026-09-24 | Not merged and in no release. Everything V1 (Zeto v0.5.1 tokens, createLock/spendLock/cancelLock) depends on it. |
| B. Vendored thread-safe go-rapidsnark | `dc5a8241d` | none in Paladin. Related library issue: iden3/rapidsnark#18 "Full Prover handle multiple requests at the same time" | OPEN (last update 2024-04-18) | Not a fix upstream; we vendor rapidsnark main 81eddf1. |
| C. Failure receipts for stuck private txs | `1d600fc6f` (part 1 and 2) | none. Related but different scope: LFDT-Paladin/paladin#820 "bug: Verifier resolution errors do not result in a failure receipt" | #820 OPEN (last update 2025-10-03) | Upstream status monitored; nothing filed (user decision 2026-11-10). Why we carry it: assemble errors repeat forever without a receipt and hold the contract's assembly slot. |
| D. Batch circuit for more than 2 outputs | `1d600fc6f` (part 3) | LFDT-Paladin/paladin#1393 "Use both inputs and outputs size to determine the circuit" (commit `7e140f063`) | **MERGED** 2026-11-02 to main; not in v1.0.0 / v1.0.1-rc.1 | Drop our part when we rebase onto a main that has #1393. |
| E. Prepare-only dispatch must not hold the epoch/step-down flush | `1953f5dff`, `ca2418e94`, `0da5af7b6` | none found (searched: prepare, Active_Flush, dispatched) | - | Upstream `main` still counts every `State_Dispatched` tx in `guard_HasUnconfirmedDispatchedTransactions` (`core/go/internal/sequencer/coordinator/state_transition_guards.go:27-33` at 66a554f5e). Upstream status monitored; nothing filed (user decision 2026-11-10). |

## A. PR #1189 commits (50 non-merge, in order)

All carry upstream reference **LFDT-Paladin/paladin#1189 (OPEN)**.

| # | sha | date | subject |
|---|---|---|---|
| 1 | `3d9bc32a6` | 2026-05-06 | update domain config to support V0 and V1 |
| 2 | `ee1138333` | 2026-05-06 | Switch to use LFDT-Paladin/smt; update zeto to v0.2.2 |
| 3 | `054abc1f9` | 2026-05-08 | add ZetoFactoryV1.sol and handling of events from multiple versions |
| 4 | `daed4c6fe` | 2026-05-08 | add version awareness in tests |
| 5 | `0533c9884` | 2026-05-08 | use zeto version to switch event ABIs |
| 6 | `a62a72a1a` | 2026-05-08 | add multiple version support with zeto artifacts handling |
| 7 | `5616c071d` | 2026-05-11 | multi-version support on Zeto for the integration-test |
| 8 | `888fbf756` | 2026-05-11 | rename zeto suite name |
| 9 | `75a07810e` | 2026-05-11 | add support for zeto v0.5.0 tx and events |
| 10 | `ccacbf04e` | 2026-05-19 | add LockInfo schema for state storage |
| 11 | `d13de1098` | 2026-05-20 | support createLock, spendLock in V1 contract |
| 12 | `1db5d0aa8` | 2026-05-20 | update integration test suite labels |
| 13 | `7dd478388` | 2026-05-20 | rename V050 to V1 |
| 14 | `13bafec41` | 2026-05-20 | cleanup and integration test suite adjustments |
| 15 | `24e342fbe` | 2026-05-20 | update integration test for non-fungible zeto |
| 16 | `35fa7abcf` | 2026-05-20 | add test of dual versions from the same testbed instance |
| 17 | `3763d6c66` | 2026-05-20 | consolidate the spendLockedOutputs and cancelLockedOutputs in the lock info |
| 18 | `8ec43f7e3` | 2026-05-20 | createLock to set spendCommitment and cancelCommitment |
| 19 | `d2763f6d5` | 2026-05-20 | add cancelLock support |
| 20 | `70a031679` | 2026-05-21 | fix unit test failures |
| 21 | `4281f297d` | 2026-05-21 | unit test coverage |
| 22 | `cb20d065b` | 2026-05-21 | remove internal/zeto/factoryabis from source control |
| 23 | `d31c4f17e` | 2026-05-21 | deploy ZetoFactoryV1 with an ERC1967Proxy |
| 24 | `0037fa6ac` | 2026-05-26 | make sure dependent builds can find zeto artifacts |
| 25 | `72a39af6c` | 2026-05-26 | wait for canceled tokens to be finalized |
| 26 | `5674b5323` | 2026-05-26 | add evaluation dependency to :domains:zeto |
| 27 | `4b8c1ad7a` | 2026-05-26 | update golang version to 1.24 |
| 28 | `7d2d9e491` | 2026-06-01 | upgrade Zeto V1 to v0.5.1 release for contract size optimization |
| 29 | `401d5c289` | 2026-06-01 | set explicit rootDir due to TS 6.x |
| 30 | `2d4f4f997` | 2026-06-01 | add missing linked contract in operator tests for Zeto |
| 31 | `3d1c9a0f7` | 2026-06-01 | fix component test failure |
| 32 | `d09f130dd` | 2026-06-24 | restore go.mod and go.sum in core/go from main |
| 33 | `ef051e634` | 2026-06-24 | revert go.mod and go.sum updates and go with main branch content |
| 34 | `80487c380` | 2026-06-24 | use main branch go.mod and go.sum |
| 35 | `792ee6e9a` | 2026-06-24 | use main branch go.mod and go.sum |
| 36 | `13c16ed46` | 2026-06-24 | fix integration build failure |
| 37 | `c0716b835` | 2026-06-24 | use version specific reference to zeto contracts module |
| 38 | `6648818e8` | 2026-09-02 | consolidate ZetoFactory versions to ZetoFactory_V0 |
| 39 | `d1ec59c6e` | 2026-09-02 | rename IZetoFungible.sol to IZetoFungible_V0.sol |
| 40 | `0e88e4a3a` | 2026-09-21 | explicit versioning with V0, V1 etc. as generation series |
| 41 | `a243d5eae` | 2026-09-22 | rename hyperledger/firefly-signer to hyperledger-firefly/signer |
| 42 | `e6144d1d8` | 2026-09-22 | add hook to redirect logrus to zap for SMT dependency that still uses logrus |
| 43 | `b5b1c3751` | 2026-09-22 | update pvp test to use v0.5.1 zeto |
| 44 | `3c1ea809a` | 2026-09-22 | unit tests for log bridge in common/go |
| 45 | `c9bf5a0a7` | 2026-09-23 | use version variant types instead of uint64 |
| 46 | `c7d7f9d41` | 2026-09-23 | update operator test to use zeto v0.5.1 with V1 interface |
| 47 | `74eb68966` | 2026-09-23 | enhance the ts SDK to support the multiple zeto interface versions |
| 48 | `5a448222c` | 2026-09-23 | update examples involving zeto to use V1 |
| 49 | `df5e8a886` | 2026-09-23 | update the ts sdk to zeto V1 |
| 50 | `28c72b76f` | 2026-09-24 | update package-lock.json for solidity |

### A2. Merge commits on the same branch (13)

| sha | date | subject | Upstream |
|---|---|---|---|
| `82fbd49ce` | 2026-10-20 | merge LFDT-Paladin/paladin#1189 (zeto-v1) into main 559567e38 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `8ca381980` | 2026-09-24 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `2e4e9b90e` | 2026-09-22 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `1ce47d688` | 2026-09-21 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `ba527408f` | 2026-09-02 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `3ac2c725a` | 2026-08-31 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `954a973aa` | 2026-08-05 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `5f2dae8e9` | 2026-08-03 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `44dbbedfe` | 2026-06-24 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `4ff01a8c1` | 2026-06-24 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `81cbf090a` | 2026-06-01 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `f66c286ec` | 2026-05-26 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |
| `6752aa3cb` | 2026-05-20 | Merge branch 'main' into zeto-v1 | #1189 (OPEN); `82fbd49ce` is our own merge of the branch into our main |

## B to E. Fork-only commits (5)

| sha | date | subject | Group | Upstream |
|---|---|---|---|---|
| `dc5a8241d` | 2026-10-20 | build: vendor thread-safe go-rapidsnark prover (rapidsnark main 81eddf1) | B | none (related iden3/rapidsnark#18, OPEN) |
| `1d600fc6f` | 2026-10-21 | fix: give stuck private txs a failure receipt; batch circuit for >2 outputs | C and D | C: none (related #820, OPEN); D: #1393 (MERGED 2026-11-02) |
| `1953f5dff` | 2026-11-03 | fix(sequencer): a prepare-only dispatch must not hold the epoch/step-down flush | E | none |
| `ca2418e94` | 2026-11-03 | test(sequencer): prepare-only dispatch through the real path, step-down flush, flag cleared on revert/repool | E | none |
| `0da5af7b6` | 2026-11-03 | docs(sequencer): state the prepare-only residual and why the tx is kept in memory | E | none |

## Checks used

- Split of the 68: the PR's commit ids (`gh pr view 1189 --json commits`, 62) were compared with the fork's non-merge commits: 50 match, 5 do not (the fork-only list above).
- Upstream searches used `gh search issues` keywords; "none" means not found by those terms, not proof of absence.
