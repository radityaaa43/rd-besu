# Pinned ABIs (Paladin v1.0.0)

Hardhat artifacts copied verbatim from the `abis.tar.gz` asset of the upstream release
`v1.0.0` (https://github.com/LFDT-Paladin/paladin/releases/tag/v1.0.0,
sha256 `3608c63573d8fd972236889e91acd26b8d08be4e77234557d6621b6a1c372c67`), so a clean
clone builds without network access to the release.

To refresh from the same pinned release: `cd ../../../common && npm run download-abi`
(defaults to v1.0.0, override with `PALADIN_ABI_VERSION`), then `npm run copy-abi` here.

## RestrictedAtom / RestrictedAtomFactory (not upstream)

`RestrictedAtom.json` and `RestrictedAtomFactory.json` are copied from `bond/src/abis/` (built from
this repo's `contracts/src/Restricted*.sol`, forge, evm shanghai). `src/index.ts` settles the swap
through them: unlike upstream's Atom, `cancel()`/`execute()` are limited to the two investors and
the executor. `AtomFactory.json` and `Atom.json` above are no longer used by `swap-noto/src`.
