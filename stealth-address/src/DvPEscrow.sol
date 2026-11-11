// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// One leg's destination, fixed at creation: the fresh stealth address, and the announcement data the token publishes.
struct Leg {
    address receiver;
    bytes ephemeralPubKey;
    bytes1 viewTag;
    bytes memo; // encrypted sender memo, opaque here (ts/memo.ts)
}

/// Everything a trade is. Immutable once the escrow exists. The custodian certificates are not part of the terms:
/// they must be signed for the escrow address, and the address depends on the terms (see `setCertificates`).
struct Terms {
    bytes32 tradeId; // chosen by the seller, unique per trade; part of the CREATE2 address
    address bond;
    bytes32 partition;
    uint256 bondAmount;
    address rd;
    uint256 rdAmount;
    address seller; // funds the bond leg, gets the bond back on cancel
    address buyer; // funds the RD leg, gets the RD back on cancel
    uint256 expiry; // settle only before it, cancel only from it on
    uint256 refundWindow; // the refund certificate must stay valid this long after `expiry`
    Leg bondLeg; // receiver: the buyer's fresh stealth address
    Leg rdLeg; // receiver: the seller's fresh stealth address
}

interface IDvPBond {
    function balanceOfByPartition(bytes32 partition, address holder) external view returns (uint256);
    function transferByPartition(bytes32 partition, address to, uint256 value, bytes calldata data) external returns (bytes32);
    function transferByPartitionStealth(
        bytes32 partition,
        address stealthAddress,
        uint256 value,
        bytes memory ephemeralPubKey,
        bytes1 viewTag,
        bytes memory memo,
        bytes memory data
    ) external;
}

interface IDvPRd is IERC20 {
    function sendStealth(address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes1 viewTag, bytes calldata memo)
        external;
}

/// @notice Escrow for one DvP trade: a DFABI bond tranche against RD. Settlement moves both legs to fixed stealth
/// receivers in one transaction, or reverts and moves nothing. After `expiry`, anyone can return each funded leg to its
/// owner. No function takes a destination, so a caller can only trigger what the terms already say.
/// @dev The escrow calls the tokens itself, so the Announcement `caller` is the token, and it is its own `msgSender`
/// for the bond's custodian certificate (nonce-based, both certificates use the escrow's nonce 0: whichever runs first
/// consumes it, so settle and refund can never both execute).
contract DvPEscrow {
    error OnlyFactory();
    error CertificatesAlreadySet();
    error BadCertificateLength();
    error CertificateExpiresTooEarly();
    error NotReady();
    error AlreadySettled();
    error Expired();
    error NotExpired();
    error NotFunded();
    error NothingToRefund();
    error AlreadyRefunded();

    event Settled(bytes32 indexed tradeId);
    event Cancelled(bytes32 indexed tradeId, bool bondRefunded, uint256 rdRefunded);
    event BondRefundFailed(bytes32 indexed tradeId);
    event BondRefunded(bytes32 indexed tradeId);

    address public immutable factory;
    Terms internal terms;
    bytes internal settleCert;
    bytes internal refundCert;
    bool public certificatesSet;
    bool public settled;
    // Refund tracking (read by the signer/Lensa instead of scanning logs): did the bond go back, how much RD went back in total.
    bool public bondRefunded;
    uint256 public rdRefunded;

    constructor(Terms memory terms_) {
        factory = msg.sender;
        terms = terms_;
    }

    function getTerms() external view returns (Terms memory) {
        return terms;
    }

    /// The custodian signs both certificates for this escrow's address, so the address must exist before the
    /// certificates do: they are attached right after creation, by the factory, in the same transaction.
    /// The certificate expiry is read from its first 32 bytes (the validator's format: expiry | r | s | v, 97 bytes).
    function setCertificates(bytes calldata settleCert_, bytes calldata refundCert_) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (certificatesSet) revert CertificatesAlreadySet();
        if (settleCert_.length != 97 || refundCert_.length != 97) revert BadCertificateLength();
        if (uint256(bytes32(settleCert_[:32])) < terms.expiry) revert CertificateExpiresTooEarly();
        if (uint256(bytes32(refundCert_[:32])) < terms.expiry + terms.refundWindow) revert CertificateExpiresTooEarly();
        settleCert = settleCert_;
        refundCert = refundCert_;
        certificatesSet = true;
    }

    /// Anyone may call, strictly before `expiry`, once both legs are fully funded.
    function settle() external {
        if (settled) revert AlreadySettled();
        if (!certificatesSet) revert NotReady();
        Terms memory t = terms;
        if (block.timestamp >= t.expiry) revert Expired();
        if (IDvPBond(t.bond).balanceOfByPartition(t.partition, address(this)) < t.bondAmount) revert NotFunded();
        uint256 rdBalance = IDvPRd(t.rd).balanceOf(address(this));
        if (rdBalance < t.rdAmount) revert NotFunded();

        settled = true;
        IDvPBond(t.bond).transferByPartitionStealth(
            t.partition, t.bondLeg.receiver, t.bondAmount, t.bondLeg.ephemeralPubKey, t.bondLeg.viewTag, t.bondLeg.memo, settleCert
        );
        IDvPRd(t.rd).sendStealth(t.rdLeg.receiver, t.rdAmount, t.rdLeg.ephemeralPubKey, t.rdLeg.viewTag, t.rdLeg.memo);
        if (rdBalance > t.rdAmount) require(IDvPRd(t.rd).transfer(t.buyer, rdBalance - t.rdAmount), "RD excess refund");
        emit Settled(t.tradeId);
    }

    /// Anyone may call, from `expiry` on, if settlement did not happen. Each funded leg goes back to its owner and
    /// an unfunded leg is skipped. May be called again if more is sent later (the bond refund certificate is
    /// single use, so a bond sent after the first refund stays until the controller moves it).
    function cancel() external {
        if (settled) revert AlreadySettled();
        Terms memory t = terms;
        if (block.timestamp < t.expiry) revert NotExpired();

        bool bondRefunded_;
        if (certificatesSet && IDvPBond(t.bond).balanceOfByPartition(t.partition, address(this)) >= t.bondAmount) {
            // The refund must not block the RD refund: if the certificate has expired the bond waits for the controller.
            try IDvPBond(t.bond).transferByPartition(t.partition, t.seller, t.bondAmount, refundCert) {
                bondRefunded_ = true;
                bondRefunded = true;
            } catch {
                emit BondRefundFailed(t.tradeId);
            }
        }
        uint256 rdBalance = IDvPRd(t.rd).balanceOf(address(this));
        if (rdBalance > 0) {
            rdRefunded += rdBalance;
            require(IDvPRd(t.rd).transfer(t.buyer, rdBalance), "RD refund");
        }
        if (!bondRefunded_ && rdBalance == 0) revert NothingToRefund();
        emit Cancelled(t.tradeId, bondRefunded_, rdBalance);
    }

    /// Anyone may call, from `expiry` on, while the bond is still held, not settled and not yet refunded: the bond goes
    /// to the seller with a FRESH custodian certificate. This is the way out when `cancel()` emitted BondRefundFailed
    /// because the stored refund certificate had expired. The destination is fixed to the seller by the terms, and the
    /// token's validator accepts the certificate only for this escrow as msgSender and for exactly this payload
    /// (transferByPartition(partition, seller, bondAmount, ...)), so a caller cannot redirect it.
    function refundBond(bytes calldata freshCert) external {
        if (settled) revert AlreadySettled();
        if (bondRefunded) revert AlreadyRefunded();
        Terms memory t = terms;
        if (block.timestamp < t.expiry) revert NotExpired();
        if (freshCert.length != 97) revert BadCertificateLength();
        if (IDvPBond(t.bond).balanceOfByPartition(t.partition, address(this)) < t.bondAmount) revert NotFunded();
        bondRefunded = true; // effects before the external call; a failing transfer reverts it
        IDvPBond(t.bond).transferByPartition(t.partition, t.seller, t.bondAmount, freshCert);
        emit BondRefunded(t.tradeId);
    }

    /// Tracking for off-chain readers. `bondStuck`: past expiry, not settled, the bond is still here and not refunded.
    function refundStatus() external view returns (bool bondHeld, bool bondRefunded_, uint256 rdRefunded_, bool bondStuck) {
        Terms memory t = terms;
        bondHeld = !settled && IDvPBond(t.bond).balanceOfByPartition(t.partition, address(this)) >= t.bondAmount;
        bondRefunded_ = bondRefunded;
        rdRefunded_ = rdRefunded;
        bondStuck = bondHeld && !bondRefunded && block.timestamp >= t.expiry;
    }
}
