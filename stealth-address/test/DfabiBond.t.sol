// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC5564Announcer} from "../src/ERC5564Announcer.sol";
import {DfabiBond} from "../src/DfabiBond.sol";
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

contract DfabiBondTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    address constant ERC1820 = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;
    bytes32 constant TRANCHE_A = bytes32("TRANCHE-A");
    bytes32 constant TRANCHE_B = bytes32("TRANCHE-B");
    uint256 constant CUSTODIAN_KEY = 0xC0570D1A;
    uint256 constant ROGUE_KEY = 0xBAD;
    address constant SENDER = address(0x5E4DE2);
    address constant STEALTH = address(0x57EA17);
    address constant OTHER = address(0x07E2);
    address constant SIGNER2 = address(0x51612);

    address custodian;
    ERC5564Announcer announcer;
    ERC1400TokensValidator validator;
    DfabiBond token;

    // The test contract deploys everything, so it is the token owner.
    function setUp() public {
        vm.warp(1_000_000);
        vm.etch(ERC1820, vm.parseBytes(vm.readFile("test/fixtures/erc1820-runtime.hex")));
        custodian = vm.addr(CUSTODIAN_KEY);
        announcer = new ERC5564Announcer();
        validator = new ERC1400TokensValidator();
        address[] memory controllers = new address[](1);
        controllers[0] = custodian;
        bytes32[] memory defaults = new bytes32[](1);
        defaults[0] = TRANCHE_A;
        token = new DfabiBond("DFABI Series 1", "DFB1", controllers, defaults, address(announcer));
        token.setTokenExtension(address(validator), "ERC1400TokensValidator", true, false, false);
        validator.registerTokenSetup(
            address(token), ERC1400TokensValidator.CertificateValidation.NonceBased, true, false, false, false, new address[](0)
        );
        validator.addCertificateSigner(address(token), custodian);
        validator.addAllowlisted(address(token), custodian);
        token.addMinter(custodian);
    }

    // 89-byte announcement metadata, built independently of the contract's encoding.
    function _meta(bytes1 tag, uint256 amount, bytes32 partition) internal view returns (bytes memory) {
        return bytes.concat(tag, bytes4(0xf3d490db), bytes20(address(token)), bytes32(amount), partition);
    }

    function _eph(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i++) b[i] = 0x02;
    }

    function _fund(address to, uint256 amount) internal {
        vm.prank(custodian);
        token.issueByPartitionStealth(TRANCHE_A, to, amount, _eph(33), 0x20, "");
    }

    // The validator signs calldata minus its last 160 bytes (97-byte certificate padded to 128 + length word).
    function _strip(bytes memory b) internal pure returns (bytes memory) {
        assembly {
            mstore(b, sub(mload(b), 160))
        }
        return b;
    }

    function _certFor(address msgSender, bytes memory payloadWithoutCert, uint256 expiry, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        bytes32 inner = keccak256(
            abi.encodePacked(
                msgSender, address(token), payloadWithoutCert, expiry, validator.usedCertificateNonce(address(token), msgSender)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(token.generateDomainSeparator(), inner));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(expiry, r, s, v);
    }

    function _transferPayload(address to, uint256 value) internal view returns (bytes memory) {
        return _strip(abi.encodeCall(token.transferByPartitionStealth, (TRANCHE_A, to, value, _eph(33), 0x20, "", new bytes(97))));
    }

    function _certTransfer(address from, address to, uint256 value, uint256 expiry, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        return _certFor(from, _transferPayload(to, value), expiry, key);
    }

    function _send(address from, address to, uint256 value, bytes memory cert) internal {
        vm.prank(from);
        token.transferByPartitionStealth(TRANCHE_A, to, value, _eph(33), 0x20, "", cert);
    }

    bytes constant ERR_54 = abi.encodeWithSignature("Error(string)", "54");

    function test_setup_roles() public view {
        require(token.isMinter(custodian), "minter");
        require(validator.isCertificateSigner(address(token), custodian), "signer");
        require(token.announcer() == announcer, "announcer");
        require(token.granularity() == 1, "granularity");
    }

    function test_issue_only_minter() public {
        // SIGNER2 passes the validator's certificate gate but is not a minter, so only onlyMinter can stop it.
        validator.addCertificateSigner(address(token), SIGNER2);
        vm.prank(SIGNER2);
        vm.expectRevert(bytes(""));
        token.issueByPartitionStealth(TRANCHE_A, STEALTH, 1, _eph(33), 0x20, "");
        _fund(STEALTH, 1);
        require(token.balanceOfByPartition(TRANCHE_A, STEALTH) == 1, "minter can issue");
    }

    function test_issue_moves_and_announces() public {
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(token), _eph(33), _meta(0x20, 1000, TRANCHE_A));
        _fund(STEALTH, 1000);
        require(token.balanceOfByPartition(TRANCHE_A, STEALTH) == 1000, "partition balance");
        require(token.balanceOf(STEALTH) == 1000, "balance");
        require(token.totalSupplyByPartition(TRANCHE_A) == 1000, "partition supply");
        require(token.totalSupply() == 1000, "supply");
    }

    function test_transfer_with_certificate_moves_and_announces() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 400, block.timestamp + 600, CUSTODIAN_KEY);
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(token), _eph(33), _meta(0x20, 400, TRANCHE_A));
        _send(SENDER, STEALTH, 400, cert);
        require(token.balanceOfByPartition(TRANCHE_A, STEALTH) == 400, "recipient");
        require(token.balanceOfByPartition(TRANCHE_A, SENDER) == 600, "remainder");
        require(token.totalSupplyByPartition(TRANCHE_A) == 1000, "supply");
        require(validator.usedCertificateNonce(address(token), SENDER) == 1, "nonce");
    }

    function test_transfer_without_certificate_reverts() public {
        _fund(SENDER, 1000);
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 400, "");
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 400, new bytes(97));
    }

    function test_transfer_with_expired_certificate_reverts() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 400, block.timestamp - 1, CUSTODIAN_KEY);
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 400, cert);
    }

    function test_transfer_with_wrong_signer_reverts() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 400, block.timestamp + 600, ROGUE_KEY);
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 400, cert);
    }

    function test_certificate_is_bound_to_recipient_and_amount() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 400, block.timestamp + 600, CUSTODIAN_KEY);
        vm.expectRevert(ERR_54);
        _send(SENDER, OTHER, 400, cert);
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 401, cert);
    }

    function test_certificate_cannot_be_replayed() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 100, block.timestamp + 600, CUSTODIAN_KEY);
        _send(SENDER, STEALTH, 100, cert);
        vm.expectRevert(ERR_54);
        _send(SENDER, STEALTH, 100, cert);
    }

    function test_certificate_is_bound_to_sender() public {
        _fund(SENDER, 1000);
        _fund(OTHER, 1000);
        bytes memory cert = _certTransfer(SENDER, STEALTH, 100, block.timestamp + 600, CUSTODIAN_KEY);
        vm.expectRevert(ERR_54);
        _send(OTHER, STEALTH, 100, cert);
    }

    function test_bad_ephemeral_key_length_reverts() public {
        _fund(SENDER, 1000);
        uint256[4] memory lens = [uint256(0), 32, 34, 65];
        for (uint256 i; i < 4; i++) {
            vm.prank(custodian);
            vm.expectRevert(DfabiBond.InvalidEphemeralPubKey.selector);
            token.issueByPartitionStealth(TRANCHE_A, STEALTH, 1, _eph(lens[i]), 0x20, "");
            vm.prank(SENDER);
            vm.expectRevert(DfabiBond.InvalidEphemeralPubKey.selector);
            token.transferByPartitionStealth(TRANCHE_A, STEALTH, 1, _eph(lens[i]), 0x20, "", "");
        }
    }

    function test_zero_value_reverts() public {
        vm.prank(custodian);
        vm.expectRevert(DfabiBond.ZeroAmount.selector);
        token.issueByPartitionStealth(TRANCHE_A, STEALTH, 0, _eph(33), 0x20, "");
        vm.prank(SENDER);
        vm.expectRevert(DfabiBond.ZeroAmount.selector);
        token.transferByPartitionStealth(TRANCHE_A, STEALTH, 0, _eph(33), 0x20, "", "");
    }

    function test_erc20_paths_are_locked() public {
        _fund(SENDER, 1000);
        vm.prank(SENDER);
        vm.expectRevert(ERR_54);
        token.transfer(STEALTH, 1);
        vm.prank(SENDER);
        token.approve(OTHER, 10);
        vm.prank(OTHER);
        vm.expectRevert(ERR_54);
        token.transferFrom(SENDER, STEALTH, 1);
    }

    function test_redeem_needs_certificate() public {
        _fund(SENDER, 1000);
        vm.prank(SENDER);
        vm.expectRevert(ERR_54);
        token.redeemByPartition(TRANCHE_A, 100, "");
        bytes memory payload = _strip(abi.encodeCall(token.redeemByPartition, (TRANCHE_A, 100, new bytes(97))));
        bytes memory cert = _certFor(SENDER, payload, block.timestamp + 600, CUSTODIAN_KEY);
        vm.prank(SENDER);
        token.redeemByPartition(TRANCHE_A, 100, cert);
        require(token.totalSupplyByPartition(TRANCHE_A) == 900, "supply after redeem");
        require(token.balanceOfByPartition(TRANCHE_A, SENDER) == 900, "holder after redeem");
    }

    // Every other test uses TRANCHE_A and tag 0x20, so this one pins that the announcement follows the arguments.
    // TRANCHE_B is not in the default partitions; the vendored _issueByPartition registers a new partition itself.
    function test_announcement_follows_tranche_and_view_tag() public {
        _fund(SENDER, 500); // tranche A, must stay untouched
        vm.prank(custodian);
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, SENDER, address(token), _eph(33), _meta(0x7f, 1000, TRANCHE_B));
        token.issueByPartitionStealth(TRANCHE_B, SENDER, 1000, _eph(33), 0x7f, "");

        bytes memory payload =
            _strip(abi.encodeCall(token.transferByPartitionStealth, (TRANCHE_B, STEALTH, 400, _eph(33), 0x7f, "", new bytes(97))));
        bytes memory cert = _certFor(SENDER, payload, block.timestamp + 600, CUSTODIAN_KEY);
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(token), _eph(33), _meta(0x7f, 400, TRANCHE_B));
        vm.prank(SENDER);
        token.transferByPartitionStealth(TRANCHE_B, STEALTH, 400, _eph(33), 0x7f, "", cert);

        require(token.balanceOfByPartition(TRANCHE_B, STEALTH) == 400, "B recipient");
        require(token.balanceOfByPartition(TRANCHE_B, SENDER) == 600, "B remainder");
        require(token.balanceOfByPartition(TRANCHE_A, SENDER) == 500, "A sender untouched");
        require(token.balanceOfByPartition(TRANCHE_A, STEALTH) == 0, "A recipient untouched");
        require(token.totalSupplyByPartition(TRANCHE_A) == 500, "A supply");
        require(token.totalSupplyByPartition(TRANCHE_B) == 1000, "B supply");
    }

    function test_document_can_be_set_and_read() public {
        vm.prank(custodian);
        token.setDocument("PROSPECTUS", "ipfs://prospectus", bytes32(uint256(0xD0C)));
        (string memory uri, bytes32 h,) = token.getDocument("PROSPECTUS");
        require(keccak256(bytes(uri)) == keccak256("ipfs://prospectus"), "uri");
        require(h == bytes32(uint256(0xD0C)), "hash");
    }

    // ---- sender memo: appended after the fixed 89-byte prefix; the contract only bounds its length ----

    function _memo(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i++) b[i] = 0xAB;
    }

    function _memoPayload(address to, uint256 value, bytes memory memo) internal view returns (bytes memory) {
        return _strip(
            abi.encodeCall(token.transferByPartitionStealth, (TRANCHE_A, to, value, _eph(33), 0x20, memo, new bytes(97)))
        );
    }

    function test_issue_and_transfer_append_memo_after_prefix() public {
        bytes memory memo = _memo(102);
        vm.prank(custodian);
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, SENDER, address(token), _eph(33), bytes.concat(_meta(0x20, 1000, TRANCHE_A), memo));
        token.issueByPartitionStealth(TRANCHE_A, SENDER, 1000, _eph(33), 0x20, memo);

        bytes memory cert = _certFor(SENDER, _memoPayload(STEALTH, 400, memo), block.timestamp + 600, CUSTODIAN_KEY);
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(token), _eph(33), bytes.concat(_meta(0x20, 400, TRANCHE_A), memo));
        vm.prank(SENDER);
        token.transferByPartitionStealth(TRANCHE_A, STEALTH, 400, _eph(33), 0x20, memo, cert);
        require(token.balanceOfByPartition(TRANCHE_A, STEALTH) == 400, "recipient");
    }

    // The custodian certificate signs the whole calldata, memo included: a certificate cannot be reused with
    // a different memo, so the custodian also vouches for the memo it saw.
    function test_certificate_is_bound_to_the_memo() public {
        _fund(SENDER, 1000);
        bytes memory cert = _certFor(SENDER, _memoPayload(STEALTH, 400, _memo(102)), block.timestamp + 600, CUSTODIAN_KEY);
        vm.prank(SENDER);
        vm.expectRevert(ERR_54);
        token.transferByPartitionStealth(TRANCHE_A, STEALTH, 400, _eph(33), 0x20, _memo(103), cert);
        vm.prank(SENDER);
        token.transferByPartitionStealth(TRANCHE_A, STEALTH, 400, _eph(33), 0x20, _memo(102), cert);
    }

    function test_memo_longer_than_256_bytes_reverts_and_256_is_accepted() public {
        require(token.MAX_MEMO() == 256, "bound");
        _fund(SENDER, 10);
        vm.prank(custodian);
        token.issueByPartitionStealth(TRANCHE_A, STEALTH, 1, _eph(33), 0x20, _memo(256));
        vm.prank(custodian);
        vm.expectRevert(DfabiBond.MemoTooLong.selector);
        token.issueByPartitionStealth(TRANCHE_A, STEALTH, 1, _eph(33), 0x20, _memo(257));

        bytes memory ok = _certFor(SENDER, _memoPayload(STEALTH, 1, _memo(256)), block.timestamp + 600, CUSTODIAN_KEY);
        vm.prank(SENDER);
        token.transferByPartitionStealth(TRANCHE_A, STEALTH, 1, _eph(33), 0x20, _memo(256), ok);
        bytes memory tooLong =
            _certFor(SENDER, _memoPayload(STEALTH, 1, _memo(257)), block.timestamp + 600, CUSTODIAN_KEY);
        vm.prank(SENDER);
        vm.expectRevert(DfabiBond.MemoTooLong.selector);
        token.transferByPartitionStealth(TRANCHE_A, STEALTH, 1, _eph(33), 0x20, _memo(257), tooLong);
    }
}
