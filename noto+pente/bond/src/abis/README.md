# Pinned ABIs (Paladin v1.0.0)

Hardhat artifacts copied verbatim from the `abis.tar.gz` asset of the upstream release
`v1.0.0` (https://github.com/LFDT-Paladin/paladin/releases/tag/v1.0.0,
sha256 `3608c63573d8fd972236889e91acd26b8d08be4e77234557d6621b6a1c372c67`), so a clean
clone builds without network access to the release.

To refresh from the same pinned release: `cd ../../../common && npm run download-abi`
(defaults to v1.0.0, override with `PALADIN_ABI_VERSION`), then `npm run copy-abi` here.

## RestrictedAtom / RestrictedAtomFactory / RestrictedBondSubscription (not upstream)

`RestrictedAtom.json`, `RestrictedAtomFactory.json` and `RestrictedBondSubscription.json` are built from this repo's own
`contracts/src/Restricted*.sol` (forge, evm shanghai) and converted to the same
`{abi, bytecode}` shape. Unlike upstream's Atom, `cancel()`/`execute()` are restricted to the
trade parties / the executor. Rebuild with `forge build` in `contracts/` and re-copy after any
change to those contracts. `RestrictedBondSubscription` is the fork of upstream `BondSubscription`
used for primary-sale issuance (header of the .sol lists every change); `BondSubscription.json`,
`AtomFactory.json` and `Atom.json` above are no longer used by `bond/src`.

## BondTracker / BondTrackerPublic (platform forks, not the upstream release asset)

`BondTracker.json` and `BondTrackerPublic.json` here are built from this repo's
`contracts/src/BondTracker.sol` and `BondTrackerPublic.sol` (the status-only public tracker, the
cancel-outcome fix and `lockedBalanceOf`), so a series issued by `npm run start` carries the same
tracker pair the platform deploys. The upstream v1.0.0 versions of these two files are in git
history (commit 8fa44ab). `InvestorList.json` and `NotoTrackerERC20.json` stay upstream.
