// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {RestrictedAtom} from "./RestrictedAtom.sol";

/**
 * Fork of upstream AtomFactory.sol (solidity/contracts/shared/AtomFactory.sol).
 * Task #3: back on the upstream minimal-proxy-clone pattern (Clones.clone + initialize),
 * now that the OpenZeppelin dependency is approved -- cheaper per-atom deploy gas than the
 * task-#2 version's full `new RestrictedAtom(...)` constructor deploy.
 * `create` now also takes `parties` and `executor`, passed straight into RestrictedAtom's
 * `initialize`. `event AtomDeployed(address addr)` is kept byte-for-byte identical to upstream
 * so existing ABI-based event listeners (e.g. Paladin/bond/src/helpers/atom.ts's
 * `ev.soliditySignature.startsWith("event AtomDeployed")`) keep working unchanged.
 *
 * Task #8: `create` also takes `cancelOperations` (RestrictedAtom.CancelOperation[]) -- the
 * per-leg cancelLock calls the atom may need to run if cancelled after one or more legs have
 * already delegated to it (see RestrictedAtom.cancel()'s own doc comment for why this exists).
 * Not required to be the same length as `operations` -- a leg that's never expected to need
 * releasing (e.g. the caller's own leg, already proven safe some other way) can simply be
 * omitted.
 */
contract RestrictedAtomFactory {
    address public immutable logic;

    event AtomDeployed(address addr);

    constructor() {
        logic = address(new RestrictedAtom());
    }

    function create(
        RestrictedAtom.Operation[] calldata operations,
        RestrictedAtom.CancelOperation[] calldata cancelOperations,
        address[] calldata parties,
        address executor
    ) external returns (address) {
        address instance = Clones.clone(logic);
        RestrictedAtom(instance).initialize(operations, cancelOperations, parties, executor);
        emit AtomDeployed(instance);
        return instance;
    }
}
