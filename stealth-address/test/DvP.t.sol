// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC5564Announcer} from "../src/ERC5564Announcer.sol";
import {DfabiBond} from "../src/DfabiBond.sol";
import {RupiahDigital} from "../src/RupiahDigital.sol";
import {DvPEscrow, Terms, Leg} from "../src/DvPEscrow.sol";
import {DvPFactory} from "../src/DvPFactory.sol";
import {ERC1400TokensValidator} from "../src/vendor/universal-token/extensions/tokenExtensions/ERC1400TokensValidator.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool, address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function etch(address, bytes calldata) external;
    function readFile(string calldata) external view returns (string memory);
    function parseBytes(string calldata) external pure returns (bytes memory);
    function sign(uint256, bytes32) external pure returns (uint8, bytes32, bytes32);
    function addr(uint256) external pure returns (address);
    function warp(uint256) external;
}

/// Atomic DvP, DFABI bond against RD, through one escrow per trade. The expected certificates, calldata and
/// announcement bytes are rebuilt here, not read back from the contracts.
contract DvPTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event Announcement(
        uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata
    );

    address constant ERC1820 = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;
    bytes32 constant TRANCHE_A = bytes32("TRANCHE-A");
    uint256 constant CUSTODIAN_KEY = 0xC0570D1A;
    address constant SELLER = address(0x5E11E2); // the seller's stealth address that holds the bond
    address constant BUYER = address(0xB0E2); // the buyer's stealth address that holds the RD
    address constant BOND_RECV = address(0xB0DD); // fresh stealth address of the buyer, receives the bond
    address constant RD_RECV = address(0x5DDD); // fresh stealth address of the seller, receives the RD
    address constant THIRD = address(0x7B1D);

    uint256 constant BOND_AMOUNT = 1000;
    uint256 constant RD_AMOUNT = 5_000_000;
    uint256 constant WINDOW = 7 days;
    uint256 constant TRADE_TTL = 1 days;
    bytes32 constant TRADE_ID = bytes32(uint256(1));

    address custodian;
    ERC5564Announcer announcer;
    ERC1400TokensValidator validator;
    DfabiBond bond;
    RupiahDigital rd;
    DvPFactory factory;
    uint256 expiry;

    function setUp() public {
        vm.warp(1_000_000);
        expiry = block.timestamp + TRADE_TTL;
        vm.etch(ERC1820, vm.parseBytes(vm.readFile("test/fixtures/erc1820-runtime.hex")));
        custodian = vm.addr(CUSTODIAN_KEY);
        announcer = new ERC5564Announcer();
        validator = new ERC1400TokensValidator();
        address[] memory controllers = new address[](1);
        controllers[0] = custodian;
        bytes32[] memory defaults = new bytes32[](1);
        defaults[0] = TRANCHE_A;
        bond = new DfabiBond("DFABI Series 1", "DFB1", controllers, defaults, address(announcer));
        bond.setTokenExtension(address(validator), "ERC1400TokensValidator", true, false, false);
        validator.registerTokenSetup(
            address(bond), ERC1400TokensValidator.CertificateValidation.NonceBased, true, false, false, false, new address[](0)
        );
        validator.addCertificateSigner(address(bond), custodian);
        validator.addAllowlisted(address(bond), custodian);
        bond.addMinter(custodian);
        rd = new RupiahDigital(address(this), address(announcer)); // this test contract is BI
        factory = new DvPFactory(custodian);
    }

    // ---- helpers ----

    function _eph() internal pure returns (bytes memory b) {
        b = new bytes(33);
        for (uint256 i; i < 33; i++) b[i] = 0x02;
    }

    function _memo(uint8 fill) internal pure returns (bytes memory b) {
        b = new bytes(102);
        for (uint256 i; i < 102; i++) b[i] = bytes1(fill);
    }

    function _terms(bytes32 tradeId) internal view returns (Terms memory t) {
        t.tradeId = tradeId;
        t.bond = address(bond);
        t.partition = TRANCHE_A;
        t.bondAmount = BOND_AMOUNT;
        t.rd = address(rd);
        t.rdAmount = RD_AMOUNT;
        t.seller = SELLER;
        t.buyer = BUYER;
        t.expiry = expiry;
        t.refundWindow = WINDOW;
        t.bondLeg = Leg({receiver: BOND_RECV, ephemeralPubKey: _eph(), viewTag: 0x20, memo: _memo(0xA1)});
        t.rdLeg = Leg({receiver: RD_RECV, ephemeralPubKey: _eph(), viewTag: 0x7f, memo: _memo(0xB2)});
    }

    function _strip(bytes memory b) internal pure returns (bytes memory) {
        assembly {
            mstore(b, sub(mload(b), 160))
        }
        return b;
    }

    function _cert(address msgSender, bytes memory payloadWithoutCert, uint256 certExpiry, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        bytes32 inner = keccak256(
            abi.encodePacked(
                msgSender, address(bond), payloadWithoutCert, certExpiry, validator.usedCertificateNonce(address(bond), msgSender)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked(bond.generateDomainSeparator(), inner)));
        return abi.encodePacked(certExpiry, r, s, v);
    }

    // What the custodian signs for an escrow, from the terms alone (the payload is the exact calldata the escrow sends).
    function _settleCert(address escrow, Terms memory t, uint256 certExpiry, uint256 key) internal view returns (bytes memory) {
        bytes memory payload = _strip(
            abi.encodeCall(
                bond.transferByPartitionStealth,
                (t.partition, t.bondLeg.receiver, t.bondAmount, t.bondLeg.ephemeralPubKey, t.bondLeg.viewTag, t.bondLeg.memo, new bytes(97))
            )
        );
        return _cert(escrow, payload, certExpiry, key);
    }

    function _refundCert(address escrow, Terms memory t, uint256 certExpiry, uint256 key) internal view returns (bytes memory) {
        bytes memory payload =
            _strip(abi.encodeCall(bond.transferByPartition, (t.partition, t.seller, t.bondAmount, new bytes(97))));
        return _cert(escrow, payload, certExpiry, key);
    }

    function _create(Terms memory t) internal returns (DvPEscrow) {
        address predicted = factory.predict(t);
        bytes memory sc = _settleCert(predicted, t, t.expiry, CUSTODIAN_KEY);
        bytes memory rc = _refundCert(predicted, t, t.expiry + t.refundWindow, CUSTODIAN_KEY);
        vm.prank(custodian);
        address e = factory.create(t, sc, rc);
        require(e == predicted, "address as predicted");
        return DvPEscrow(e);
    }

    function _fundBond(address escrow, uint256 amount) internal {
        vm.prank(custodian);
        bond.issueByPartitionStealth(TRANCHE_A, SELLER, amount, _eph(), 0x20, "");
        bytes memory payload = _strip(abi.encodeCall(bond.transferByPartition, (TRANCHE_A, escrow, amount, new bytes(97))));
        bytes memory c = _cert(SELLER, payload, block.timestamp + 600, CUSTODIAN_KEY);
        vm.prank(SELLER);
        bond.transferByPartition(TRANCHE_A, escrow, amount, c);
    }

    function _fundRd(address escrow, uint256 amount) internal {
        rd.mint(BUYER, amount);
        vm.prank(BUYER);
        rd.transfer(escrow, amount);
    }

    function _bondMeta(uint256 amount, bytes1 tag, bytes memory memo) internal view returns (bytes memory) {
        return bytes.concat(tag, bytes4(0xf3d490db), bytes20(address(bond)), bytes32(amount), TRANCHE_A, memo);
    }

    function _rdMeta(uint256 amount, bytes1 tag, bytes memory memo) internal view returns (bytes memory) {
        return bytes.concat(tag, bytes4(0xa9059cbb), bytes20(address(rd)), bytes32(amount), memo);
    }

    // ---- happy path ----

    function test_settle_by_a_third_party_moves_both_legs_to_the_fixed_receivers_and_announces_both() public {
        Terms memory t = _terms(TRADE_ID);
        DvPEscrow e = _create(t);
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);

        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, BOND_RECV, address(bond), _eph(), _bondMeta(BOND_AMOUNT, 0x20, _memo(0xA1)));
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, RD_RECV, address(rd), _eph(), _rdMeta(RD_AMOUNT, 0x7f, _memo(0xB2)));
        vm.prank(THIRD); // neither the seller nor the buyer
        e.settle();

        require(bond.balanceOfByPartition(TRANCHE_A, BOND_RECV) == BOND_AMOUNT, "buyer receiver holds the bond");
        require(rd.balanceOf(RD_RECV) == RD_AMOUNT, "seller receiver holds the RD");
        require(bond.balanceOfByPartition(TRANCHE_A, address(e)) == 0, "escrow bond empty");
        require(rd.balanceOf(address(e)) == 0, "escrow RD empty");
        require(bond.balanceOfByPartition(TRANCHE_A, SELLER) == 0 && rd.balanceOf(BUYER) == 0, "originals are gone");
        require(bond.balanceOfByPartition(TRANCHE_A, THIRD) == 0 && rd.balanceOf(THIRD) == 0, "the caller got nothing");
        require(e.settled(), "settled flag");
    }

    function test_settle_refunds_rd_overfunding_to_the_buyer() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT + 123);
        e.settle();
        require(rd.balanceOf(RD_RECV) == RD_AMOUNT, "seller side gets exactly the price");
        require(rd.balanceOf(BUYER) == 123, "excess goes back to the buyer");
        require(rd.balanceOf(address(e)) == 0, "nothing left in the escrow");
    }

    function test_settle_twice_reverts() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        e.settle();
        vm.expectRevert(DvPEscrow.AlreadySettled.selector);
        e.settle();
    }

    // ---- settle preconditions ----

    function test_settle_reverts_NotFunded_when_a_leg_is_missing_or_short() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        vm.expectRevert(DvPEscrow.NotFunded.selector);
        e.settle(); // nothing funded
        _fundBond(address(e), BOND_AMOUNT);
        vm.expectRevert(DvPEscrow.NotFunded.selector);
        e.settle(); // bond only
        _fundRd(address(e), RD_AMOUNT - 1);
        vm.expectRevert(DvPEscrow.NotFunded.selector);
        e.settle(); // RD one short
    }

    function test_settle_reverts_NotFunded_when_only_rd_is_funded_or_the_bond_is_short() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundRd(address(e), RD_AMOUNT);
        vm.expectRevert(DvPEscrow.NotFunded.selector);
        e.settle(); // RD only
        _fundBond(address(e), BOND_AMOUNT - 1);
        vm.expectRevert(DvPEscrow.NotFunded.selector);
        e.settle(); // bond one short
    }

    function test_settle_at_expiry_reverts_and_just_before_expiry_works() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        vm.warp(expiry);
        vm.expectRevert(DvPEscrow.Expired.selector);
        e.settle();
        vm.warp(expiry - 1);
        e.settle();
        require(e.settled(), "settled at expiry - 1");
    }

    // ---- atomicity ----

    function test_settle_is_atomic_when_the_rd_leg_fails() public {
        Terms memory t = _terms(TRADE_ID);
        t.rdLeg.ephemeralPubKey = new bytes(32); // RupiahDigital rejects it after the bond leg already moved
        DvPEscrow e = _create(t);
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        vm.expectRevert(RupiahDigital.InvalidEphemeralPubKey.selector);
        e.settle();
        require(bond.balanceOfByPartition(TRANCHE_A, address(e)) == BOND_AMOUNT, "bond still in escrow");
        require(bond.balanceOfByPartition(TRANCHE_A, BOND_RECV) == 0, "bond leg rolled back");
        require(rd.balanceOf(address(e)) == RD_AMOUNT, "RD still in escrow");
        require(!e.settled(), "not settled");
    }

    function test_settle_is_atomic_when_the_bond_leg_fails() public {
        Terms memory t = _terms(TRADE_ID);
        t.bondLeg.ephemeralPubKey = new bytes(32); // the certificate is valid for this calldata, the bond itself refuses
        DvPEscrow e = _create(t);
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        vm.expectRevert(DfabiBond.InvalidEphemeralPubKey.selector);
        e.settle();
        require(rd.balanceOf(RD_RECV) == 0 && rd.balanceOf(address(e)) == RD_AMOUNT, "RD untouched");
        require(bond.balanceOfByPartition(TRANCHE_A, address(e)) == BOND_AMOUNT, "bond untouched");
    }

    // ---- certificates ----

    function test_certificate_signed_for_another_address_cannot_settle() public {
        Terms memory t = _terms(TRADE_ID);
        address predicted = factory.predict(t);

        // signed for THIRD instead of the escrow: the certificate binds msgSender
        bytes memory sc = _settleCert(THIRD, t, t.expiry, CUSTODIAN_KEY);
        bytes memory rc = _refundCert(predicted, t, t.expiry + WINDOW, CUSTODIAN_KEY);
        vm.prank(custodian);
        address e1 = factory.create(t, sc, rc);
        _fundBond(e1, BOND_AMOUNT);
        _fundRd(e1, RD_AMOUNT);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "54"));
        DvPEscrow(e1).settle();
        require(bond.balanceOfByPartition(TRANCHE_A, e1) == BOND_AMOUNT, "nothing moved");
    }

    function test_certificate_bound_to_the_memo_in_the_terms() public {
        Terms memory t = _terms(TRADE_ID);
        address predicted = factory.predict(t);
        Terms memory other = _terms(TRADE_ID);
        other.bondLeg.memo = _memo(0xFF); // the custodian signed a different memo
        bytes memory sc = _settleCert(predicted, other, t.expiry, CUSTODIAN_KEY);
        bytes memory rc = _refundCert(predicted, t, t.expiry + WINDOW, CUSTODIAN_KEY);
        vm.prank(custodian);
        DvPEscrow e = DvPEscrow(factory.create(t, sc, rc));
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "54"));
        e.settle();
    }

    // ---- cancel ----

    function test_cancel_before_expiry_reverts_and_at_expiry_works() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        vm.warp(expiry - 1);
        vm.expectRevert(DvPEscrow.NotExpired.selector);
        e.cancel();
        vm.warp(expiry);
        vm.prank(THIRD); // anyone
        e.cancel();
        require(bond.balanceOfByPartition(TRANCHE_A, SELLER) == BOND_AMOUNT, "seller got the bond back");
        require(rd.balanceOf(BUYER) == RD_AMOUNT, "buyer got the RD back");
        require(bond.balanceOfByPartition(TRANCHE_A, THIRD) == 0 && rd.balanceOf(THIRD) == 0, "caller got nothing");
        require(bond.balanceOfByPartition(TRANCHE_A, address(e)) == 0 && rd.balanceOf(address(e)) == 0, "escrow empty");
    }

    function test_cancel_when_only_the_seller_funded_returns_the_bond() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT);
        vm.warp(expiry);
        e.cancel();
        require(bond.balanceOfByPartition(TRANCHE_A, SELLER) == BOND_AMOUNT, "bond back");
        require(rd.totalSupply() == 0, "no RD existed");
    }

    function test_cancel_when_only_the_buyer_funded_returns_the_rd() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundRd(address(e), RD_AMOUNT);
        vm.warp(expiry);
        e.cancel();
        require(rd.balanceOf(BUYER) == RD_AMOUNT, "RD back");
        require(bond.totalSupply() == 0, "no bond existed");
    }

    function test_cancel_refunds_all_rd_when_overfunded_but_only_the_exact_bond_amount() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT + 50);
        _fundRd(address(e), RD_AMOUNT + 77);
        vm.warp(expiry);
        e.cancel();
        require(rd.balanceOf(BUYER) == RD_AMOUNT + 77, "all RD returned");
        require(bond.balanceOfByPartition(TRANCHE_A, SELLER) == BOND_AMOUNT, "exact bondAmount returned (the certificate binds it)");
        require(bond.balanceOfByPartition(TRANCHE_A, address(e)) == 50, "bond excess stays: only the controller can move it");
    }

    function test_cancel_with_nothing_funded_reverts_and_a_second_cancel_reverts() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        vm.warp(expiry);
        vm.expectRevert(DvPEscrow.NothingToRefund.selector);
        e.cancel();
        _fundRd(address(e), 10);
        e.cancel();
        vm.expectRevert(DvPEscrow.NothingToRefund.selector);
        e.cancel();
    }

    function test_cancel_after_settle_reverts() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        e.settle();
        vm.warp(expiry + 1);
        vm.expectRevert(DvPEscrow.AlreadySettled.selector);
        e.cancel();
    }

    function test_a_failing_bond_refund_does_not_block_the_rd_refund() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        vm.warp(expiry + WINDOW + 1); // the refund certificate has expired; the window is over
        e.cancel();
        require(rd.balanceOf(BUYER) == RD_AMOUNT, "RD still refunded");
        require(bond.balanceOfByPartition(TRANCHE_A, address(e)) == BOND_AMOUNT, "bond waits for the controller");
    }

    function test_refund_certificate_is_valid_for_the_whole_refund_window() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT);
        vm.warp(expiry + WINDOW); // the last second of the window
        e.cancel();
        require(bond.balanceOfByPartition(TRANCHE_A, SELLER) == BOND_AMOUNT, "bond refunded at the end of the window");
    }

    // ---- creation: salt, certificate expiry, who may create ----

    function test_address_depends_on_trade_id_and_a_trade_cannot_be_created_twice() public {
        Terms memory a = _terms(bytes32(uint256(1)));
        Terms memory b = _terms(bytes32(uint256(2)));
        require(factory.predict(a) != factory.predict(b), "same terms, different tradeId, different escrow");
        _create(a);
        _create(b);
        address predicted = factory.predict(a);
        bytes memory sc = _settleCert(predicted, a, a.expiry, CUSTODIAN_KEY);
        bytes memory rc = _refundCert(predicted, a, a.expiry + WINDOW, CUSTODIAN_KEY);
        vm.prank(custodian);
        vm.expectRevert(); // CREATE2 collision
        factory.create(a, sc, rc);
    }

    function test_only_the_custodian_creates_escrows() public {
        Terms memory t = _terms(TRADE_ID);
        address predicted = factory.predict(t);
        bytes memory sc = _settleCert(predicted, t, t.expiry, CUSTODIAN_KEY);
        bytes memory rc = _refundCert(predicted, t, t.expiry + WINDOW, CUSTODIAN_KEY);
        vm.prank(THIRD);
        vm.expectRevert(DvPFactory.OnlyCustodian.selector);
        factory.create(t, sc, rc);
    }

    function test_certificate_expiry_is_checked_when_the_escrow_is_created() public {
        Terms memory t = _terms(TRADE_ID);
        address p = factory.predict(t);
        bytes memory goodS = _settleCert(p, t, t.expiry, CUSTODIAN_KEY);
        bytes memory goodR = _refundCert(p, t, t.expiry + WINDOW, CUSTODIAN_KEY);
        bytes memory shortS = _settleCert(p, t, t.expiry - 1, CUSTODIAN_KEY);
        bytes memory shortR = _refundCert(p, t, t.expiry + WINDOW - 1, CUSTODIAN_KEY);

        vm.prank(custodian);
        vm.expectRevert(DvPEscrow.CertificateExpiresTooEarly.selector);
        factory.create(t, shortS, goodR);
        vm.prank(custodian);
        vm.expectRevert(DvPEscrow.CertificateExpiresTooEarly.selector);
        factory.create(t, goodS, shortR);
        vm.prank(custodian);
        vm.expectRevert(DvPEscrow.BadCertificateLength.selector);
        factory.create(t, new bytes(96), goodR);
        vm.prank(custodian);
        factory.create(t, goodS, goodR); // exactly at the limits is accepted
    }

    function test_the_terms_are_readable_back_and_cannot_be_changed() public {
        Terms memory t = _terms(TRADE_ID);
        DvPEscrow e = _create(t);
        Terms memory got = e.getTerms();
        require(keccak256(abi.encode(got)) == keccak256(abi.encode(t)), "terms as created");
        require(e.factory() == address(factory), "created by the factory");
        vm.expectRevert(DvPEscrow.OnlyFactory.selector);
        e.setCertificates(new bytes(97), new bytes(97)); // a second set is refused whoever calls
    }

    // ---- refund tracking (analyst gate before S17): on-chain state + a retry path for a stuck bond ----

    function test_refundStatus_of_a_fresh_escrow_is_empty() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        (bool held, bool refunded, uint256 rdRef, bool stuck) = e.refundStatus();
        require(!held && !refunded && rdRef == 0 && !stuck, "nothing held, nothing refunded, not stuck");
    }

    function test_cancel_records_what_was_refunded() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        vm.warp(expiry);
        e.cancel();
        (bool held, bool refunded, uint256 rdRef, bool stuck) = e.refundStatus();
        require(!held && refunded && rdRef == RD_AMOUNT && !stuck, "both refunded, bond no longer held, not stuck");
        require(e.bondRefunded() && e.rdRefunded() == RD_AMOUNT, "public getters");
    }

    function test_an_expired_refund_certificate_marks_the_bond_stuck_and_keeps_the_rd_refund() public {
        DvPEscrow e = _create(_terms(TRADE_ID));
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        vm.warp(expiry + WINDOW + 1);
        e.cancel();
        (bool held, bool refunded, uint256 rdRef, bool stuck) = e.refundStatus();
        require(held && !refunded && rdRef == RD_AMOUNT && stuck, "bond held, not refunded, stuck; RD refunded");
    }

    function test_a_stuck_bond_is_refunded_to_the_seller_with_a_fresh_certificate_by_anyone() public {
        Terms memory t = _terms(TRADE_ID);
        DvPEscrow e = _create(t);
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT); // with an RD leg cancel() succeeds (it reverts NothingToRefund when nothing at all moves)
        vm.warp(expiry + WINDOW + 1);
        e.cancel();
        require(bond.balanceOfByPartition(TRANCHE_A, address(e)) == BOND_AMOUNT, "stuck");
        bytes memory fresh = _refundCert(address(e), t, block.timestamp + 600, CUSTODIAN_KEY);
        vm.prank(THIRD);
        e.refundBond(fresh);
        require(bond.balanceOfByPartition(TRANCHE_A, SELLER) == BOND_AMOUNT, "bond back with the seller");
        require(bond.balanceOfByPartition(TRANCHE_A, address(e)) == 0, "escrow empty");
        (bool held, bool refunded,, bool stuck) = e.refundStatus();
        require(!held && refunded && !stuck, "tracking updated");
    }

    function test_refundBond_cannot_redirect_a_certificate_for_another_destination_is_refused() public {
        Terms memory t = _terms(TRADE_ID);
        DvPEscrow e = _create(t);
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT); // with an RD leg cancel() succeeds (it reverts NothingToRefund when nothing at all moves)
        vm.warp(expiry + WINDOW + 1);
        e.cancel();
        Terms memory other = _terms(TRADE_ID);
        other.seller = THIRD; // a certificate that pays THIRD
        bytes memory evil = _refundCert(address(e), other, block.timestamp + 600, CUSTODIAN_KEY);
        vm.expectRevert();
        e.refundBond(evil);
        require(bond.balanceOfByPartition(TRANCHE_A, THIRD) == 0, "nothing reached the stranger");
        require(bond.balanceOfByPartition(TRANCHE_A, address(e)) == BOND_AMOUNT, "still held");
    }

    function test_refundBond_cannot_run_twice_nor_after_a_successful_cancel() public {
        Terms memory t = _terms(TRADE_ID);
        DvPEscrow e = _create(t);
        _fundBond(address(e), BOND_AMOUNT);
        vm.warp(expiry);
        e.cancel(); // refunds with the stored certificate
        bytes memory fresh = _refundCert(address(e), t, block.timestamp + 600, CUSTODIAN_KEY);
        vm.expectRevert(DvPEscrow.AlreadyRefunded.selector);
        e.refundBond(fresh);
    }

    function test_refundBond_guards_not_expired_settled_not_held_bad_length() public {
        Terms memory t = _terms(TRADE_ID);
        DvPEscrow e = _create(t);
        _fundBond(address(e), BOND_AMOUNT);
        _fundRd(address(e), RD_AMOUNT);
        bytes memory fresh = _refundCert(address(e), t, expiry + WINDOW, CUSTODIAN_KEY);
        vm.expectRevert(DvPEscrow.NotExpired.selector);
        e.refundBond(fresh); // before expiry
        e.settle();
        vm.warp(expiry);
        vm.expectRevert(DvPEscrow.AlreadySettled.selector);
        e.refundBond(fresh);
        DvPEscrow e2 = _create(_terms(bytes32(uint256(2)))); // nothing funded
        vm.expectRevert(DvPEscrow.NotFunded.selector);
        e2.refundBond(fresh);
        vm.expectRevert(DvPEscrow.BadCertificateLength.selector);
        e2.refundBond(new bytes(96));
    }
}

