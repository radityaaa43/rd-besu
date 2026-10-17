// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPenteExternalCall} from "paladin-domains/interfaces/IPenteExternalCall.sol";
import {RestrictedAtom} from "./RestrictedAtom.sol";
import {RestrictedAtomFactory} from "./RestrictedAtomFactory.sol";

/**
 * Fork of upstream BondSubscription (solidity/contracts/private/BondSubscription.sol at tag
 * v1.0.0), so primary-sale issuance settles through RestrictedAtom instead of upstream's Atom,
 * whose cancel() has no access control (anyone could cancel a delegated sale mid-flight).
 *
 * Changes from upstream, all of them:
 *  1. Imports RestrictedAtom / RestrictedAtomFactory (this repo) instead of ../shared/Atom* .
 *     `atomFactory` must be a RestrictedAtomFactory address.
 *  2. preparePayment / prepareBond take two more arguments, `lockId` and `cancelCall` (the
 *     lockId and cancelCall of the Noto lock's prepareUnlock receipt), and store them.
 *  3. distribute() requires both cancel records, then calls RestrictedAtomFactory.create with
 *     (operations, cancelOperations, parties, executor) instead of AtomFactory.create(operations):
 *       - cancelOperations: one entry per leg ({token, lockId, cancelCall}), so a cancel releases
 *         whichever leg was already delegated to the atom (RestrictedAtom.cancel);
 *       - parties: [owner() = the investor, custodian];
 *       - executor: custodian (BI's bond custodian account, which runs execute()).
 *  4. IPenteExternalCall import path (vendored copy of the same file at v1.0.0).
 * Everything else (storage, modifiers, onlyOwner / onlyCustodian gates, operation order: bond
 * first, payment second) is unchanged.
 */
contract RestrictedBondSubscription is Ownable, IPenteExternalCall {
    address public bondAddress;
    address public custodian;
    uint256 public requestedUnits;
    address public atomFactory;

    address internal distributeBondAddress;
    bytes internal distributeBondCall;
    bytes32 internal distributeBondLockId;
    bytes internal distributeBondCancelCall;
    address internal distributePaymentAddress;
    bytes internal distributePaymentCall;
    bytes32 internal distributePaymentLockId;
    bytes internal distributePaymentCancelCall;

    modifier onlyCustodian() {
        require(_msgSender() == custodian, "Sender is not custodian");
        _;
    }

    constructor(
        address bondAddress_,
        uint256 units_,
        address custodian_,
        address atomFactory_
    ) Ownable(_msgSender()) {
        bondAddress = bondAddress_;
        requestedUnits = units_;
        custodian = custodian_;
        atomFactory = atomFactory_;
    }

    function preparePayment(
        address to,
        bytes calldata encodedCall,
        bytes32 lockId,
        bytes calldata cancelCall
    ) external onlyOwner {
        distributePaymentAddress = to;
        distributePaymentCall = encodedCall;
        distributePaymentLockId = lockId;
        distributePaymentCancelCall = cancelCall;
    }

    function prepareBond(
        address to,
        bytes calldata encodedCall,
        bytes32 lockId,
        bytes calldata cancelCall
    ) external onlyCustodian {
        distributeBondAddress = to;
        distributeBondCall = encodedCall;
        distributeBondLockId = lockId;
        distributeBondCancelCall = cancelCall;
    }

    function distribute() external onlyCustodian {
        require(
            distributeBondCall.length > 0,
            "Bond transfer has not been prepared"
        );
        require(
            distributePaymentCall.length > 0,
            "Payment transfer has not been prepared"
        );
        require(
            distributeBondCancelCall.length > 0 && distributeBondLockId != bytes32(0),
            "Bond cancel call has not been prepared"
        );
        require(
            distributePaymentCancelCall.length > 0 && distributePaymentLockId != bytes32(0),
            "Payment cancel call has not been prepared"
        );

        RestrictedAtom.Operation[] memory operations = new RestrictedAtom.Operation[](2);
        operations[0] = RestrictedAtom.Operation(
            distributeBondAddress,
            distributeBondCall
        );
        operations[1] = RestrictedAtom.Operation(
            distributePaymentAddress,
            distributePaymentCall
        );

        RestrictedAtom.CancelOperation[] memory cancelOperations = new RestrictedAtom.CancelOperation[](2);
        cancelOperations[0] = RestrictedAtom.CancelOperation(
            distributeBondAddress,
            distributeBondLockId,
            distributeBondCancelCall
        );
        cancelOperations[1] = RestrictedAtom.CancelOperation(
            distributePaymentAddress,
            distributePaymentLockId,
            distributePaymentCancelCall
        );

        address[] memory parties = new address[](2);
        parties[0] = owner();
        parties[1] = custodian;

        emit PenteExternalCall(
            atomFactory,
            abi.encodeCall(
                RestrictedAtomFactory.create,
                (operations, cancelOperations, parties, custodian)
            )
        );
    }
}
