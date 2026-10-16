# Pinned ABIs (Paladin v1.0.0)

Hardhat artifacts copied verbatim from the `abis.tar.gz` asset of the upstream release
`v1.0.0` (https://github.com/LFDT-Paladin/paladin/releases/tag/v1.0.0,
sha256 `3608c63573d8fd972236889e91acd26b8d08be4e77234557d6621b6a1c372c67`), so a clean
clone builds without network access to the release.

To refresh from the same pinned release: `cd ../../../common && npm run download-abi`
(defaults to v1.0.0, override with `PALADIN_ABI_VERSION`), then `npm run copy-abi` here.

## RestrictedAtom / RestrictedAtomFactory (not upstream)

`RestrictedAtom.json` and `RestrictedAtomFactory.json` are built from this repo's own
`contracts/src/RestrictedAtom*.sol` (forge, evm shanghai) and converted to the same
`{abi, bytecode}` shape. Unlike upstream's Atom, `cancel()`/`execute()` are restricted to the
trade parties / the executor. Rebuild with `forge build` in `contracts/` and re-copy after any
change to those two contracts.
