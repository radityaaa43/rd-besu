# Vendored: Consensys UniversalToken (ERC-1400)

- Source: https://github.com/Consensys/UniversalToken, commit `54320c6f7a8ee1fd7fcb19073e9c122e1e8f96f9` (2024-01-23), `contracts/` subtree, license Apache-2.0 (`LICENSE` in this folder).
- Files: the 22 Solidity files that `ERC1400.sol` and `ERC1400TokensValidator.sol` import, at their upstream relative paths. Copied byte for byte; never edit them here. To check: clone the repository at the commit above and `cmp` each file against `contracts/<same path>`.
- **The upstream repository is archived and its files say "This code has not been reviewed. Do not use or deploy this code before reviewing it personally first." Nothing in this repository audits it.**
- It is compiled against OpenZeppelin Contracts 4.9.6 (npm alias `oz4`) through the context remapping in `stealth/foundry.toml`; the rest of `stealth/src` uses OpenZeppelin 5.4.0.
- It registers itself in the ERC1820 registry at `0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24`, so that registry must exist on the network (`stealth/script/deploy-erc1820.ts`).
