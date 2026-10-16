# Vendored Paladin contracts (v1.0.0)

Verbatim copies of the upstream Solidity files this package imports, taken with
`git show v1.0.0:solidity/contracts/<path>` from LF-Decentralized-Trust-labs/paladin
(tag v1.0.0 = commit 6d4b91343426d17d713a0d61dfbcb2e262cb346d). Do not edit; to update,
re-extract from a newer tag and re-run `forge test`.

Files (upstream path under `solidity/contracts/`):
- domains/interfaces/ILockableCapability.sol, INotoHooks.sol, IPenteExternalCall.sol
- private/InvestorList.sol, NotoLocks.sol, NotoTrackerERC20.sol, interfaces/ITransferPolicy.sol
- shared/TokenDistribution.sol

OpenZeppelin 5.4.0 comes from npm (`package.json` + `package-lock.json`): run `npm ci` in
`contracts/` before `forge test`.
