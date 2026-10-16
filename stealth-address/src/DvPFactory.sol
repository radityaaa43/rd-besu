// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {DvPEscrow, Terms} from "./DvPEscrow.sol";

/// @notice Creates one `DvPEscrow` per trade at a CREATE2 address the custodian can compute before it exists, so it
/// can sign the bond certificates for that address. Only the custodian creates: it has checked both parties' terms
/// (KYC of both receivers) and a third party cannot squat the address with bad certificates.
contract DvPFactory {
    error OnlyCustodian();

    event EscrowCreated(bytes32 indexed tradeId, address indexed escrow);

    address public immutable custodian;

    constructor(address custodian_) {
        custodian = custodian_;
    }

    function _salt(Terms memory t) private pure returns (bytes32) {
        return keccak256(abi.encode(t)); // includes tradeId
    }

    /// The escrow address for these terms, before it exists.
    function predict(Terms memory t) public view returns (address) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(DvPEscrow).creationCode, abi.encode(t)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(t), initCodeHash)))));
    }

    function create(Terms memory t, bytes calldata settleCert, bytes calldata refundCert) external returns (address) {
        if (msg.sender != custodian) revert OnlyCustodian();
        DvPEscrow e = new DvPEscrow{salt: _salt(t)}(t);
        e.setCertificates(settleCert, refundCert);
        emit EscrowCreated(t.tradeId, address(e));
        return address(e);
    }
}
