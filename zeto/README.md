# Zeto RD + DFABI exploration (Paladin on Besu)

This is a standalone exploration of Paladin's `zeto` domain for RD (cash) and DFABI (bond). It
runs on the Alibaba ACK Paladin v1.0.0 cluster (`paladin-node1..4`, namespace `paladin`). It is
not integrated with the Noto+Pente backend in `platform-rd-dfabi`.

## Setup

1. Start the port-forwards to the four Paladin nodes on 127.0.0.1:31548, 31648, 31748 and 31848,
   as listed in `config.json`. The script that does this is `alibaba-kube/Paladin/scripts/port-forward-start.sh`.
2. Run `npm install`. The SDK is resolved from the local Paladin source at
   `/home/ecs-user/eksplorasi-paladin/paladin/sdk/typescript`.
3. Run `npm run typecheck`.

All three scripts are dry-run by default. Pass `--execute` to send transactions.

| Script | What it does |
|---|---|
| `bootstrap-zeto.ts` | Phase 1. Deploys RD-Zeto and DFABI-Zeto. Both are `Zeto_AnonNullifierKyc` tokens backed by an ERC20, following Paladin's `examples/private-stablecoin`. Writes `out/zeto-contract-data.json`, which is gitignored. |
| `smoke-zeto.ts` | Makes a 1-unit private transfer and a withdraw on each token. |
| `spike-zeto-dvp.ts` | Phase 2. Runs a DvP of a Noto DFABI bond against Zeto_Anon RD cash through an Atom, following `examples/swap` and `tutorials/atomic-swap.md`. The run has 29 checks across happy path, privacy, negative, failure and 4-parallel scenarios. It takes about 15 minutes. |

Run a script like this: `npx ts-node spike-zeto-dvp.ts --execute`.

## Layout

- `src/common.ts` is a minimal stand-in for Paladin's `examples/common`.
- `src/atom.ts` and the Atom ABIs in `abis/` are copied from `examples/swap`.
- `ops/backup-pld-node*-1792061433.yaml` holds the `pld` CRs as they were before the Zeto domain
  install. They are the rollback artifacts.

## Zeto domain install (2026-10-15)

The cluster runs `zeto` alongside `noto` and `pente`. The steps were applied in this order, after
a clean pre-check on all 4 nodes:

1. `kubectl apply -n paladin` every `~/paladin-v1/core_v1alpha1_*zeto*.yaml`. This covers the
   PaladinDomain `zeto`, 24 SmartContractDeployments and 4 `registerImplementation` TransactionInvokes.
2. The 4 invokes reverted with `OwnableUnauthorizedAccount`. The samples send from `zeto.operator`,
   but the factory's owner is the proxy deployer. The fix was
   `kubectl patch transactioninvoke <name> --type merge -p '{"spec":{"from":"zeto_factory_proxy.operator"}}'`.
3. `{labelSelector: {matchLabels: {paladin.io/domain-name: zeto}}}` was added to `pld node4`,
   then to node3, node2 and node1 (JSON patch `add /spec/domains/-`). Each pod restarts once and
   logs `Domain plugin registered name=zeto address=0x753a64ea...`.

Rollback: remove the zeto entry from each `pld` `spec.domains`. The on-chain Zeto contracts
stay but are unused.

The log line `PD210102: Not implemented. See state receipt for coin transfers` is known noise.
The v1.0.0 Zeto domain has no domain receipt, so it is harmless.

## DvP findings

- KYC tokens cannot do DvP. Upstream (`domains/integration-test/zeto_fungible_test.go:264` at
  v1.0.0) supports lock and transferLocked only on `Zeto_Anon`, and the v1.0.0 image ships no KYC
  transferLocked circuit (`build.gradle:266-272` at v1.0.0).
- On the Noto leg, the owner can no longer `unlock` once `prepareUnlock` has run. Only the lock
  spender can cancel. In basic mode the spender is the notary, which sends the prepared `cancelCall`.
- On the Zeto leg, a locked UTXO cannot be reclaimed once `prepareTransferLocked` has run. The
  reclaim fails with `PD210134: Failed to query states by IDs`
  (`domains/zeto/internal/zeto/fungible/handler_transferLocked.go:325` at v1.0.0), because the
  UTXO is no longer available to the reclaim. This is observed in test F1b; the root cause was
  not traced in the source.
- `Atom.cancel()` has no access control. If anyone cancels an Atom after both legs are delegated,
  both locks are stuck permanently. To avoid that, create the Atom, delegate both legs and execute
  in one step.
