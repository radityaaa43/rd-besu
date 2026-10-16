// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC6538Registry} from "../src/ERC6538Registry.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool) external;
    function expectRevert(bytes4) external;
    function prank(address) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external returns (address);
    function chainId(uint256) external;
}

/// ERC-1271 wallet mock: accepts exactly one digest, returns anything else as the "invalid" value.
contract Wallet1271 {
    bytes32 public okDigest;
    bytes4 public answer;

    constructor(bytes32 okDigest_, bytes4 answer_) {
        okDigest = okDigest_;
        answer = answer_;
    }

    function isValidSignature(bytes32 digest, bytes memory) external view returns (bytes4) {
        return digest == okDigest ? answer : bytes4(0xffffffff);
    }
}

contract ERC6538RegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress);
    event NonceIncremented(address indexed registrant, uint256 newNonce);

    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    ERC6538Registry r;

    function setUp() public {
        r = new ERC6538Registry();
    }

    function _meta(uint8 fill, uint256 len) internal pure returns (bytes memory m) {
        m = new bytes(len);
        for (uint256 i; i < len; i++) m[i] = bytes1(fill);
    }

    function test_registerKeys_stores_and_emits() public {
        bytes memory m = _meta(0x02, 66);
        vm.expectEmit(true, true, false, true);
        emit StealthMetaAddressSet(ALICE, 1, m);
        vm.prank(ALICE);
        r.registerKeys(1, m);
        require(keccak256(r.stealthMetaAddressOf(ALICE, 1)) == keccak256(m), "stored");
    }

    function test_registerKeys_scheme1_wrong_length_reverts() public {
        vm.expectRevert(ERC6538Registry.InvalidMetaAddressLength.selector);
        r.registerKeys(1, _meta(0x02, 65));
    }

    // Review focus 4: non-scheme-1 ids accept any length.
    function test_registerKeys_other_scheme_accepts_any_length() public {
        bytes memory m = _meta(0x07, 3);
        vm.prank(ALICE);
        r.registerKeys(2, m);
        require(keccak256(r.stealthMetaAddressOf(ALICE, 2)) == keccak256(m), "stored");
    }

    // Review focus 4: re-registering overwrites, and another registrant is untouched.
    function test_register_overwrites_and_isolates_registrants() public {
        bytes memory first = _meta(0x02, 66);
        bytes memory second = _meta(0x03, 66);
        vm.prank(ALICE);
        r.registerKeys(1, first);
        vm.prank(BOB);
        r.registerKeys(1, first);
        vm.prank(ALICE);
        r.registerKeys(1, second);
        require(keccak256(r.stealthMetaAddressOf(ALICE, 1)) == keccak256(second), "alice overwritten");
        require(keccak256(r.stealthMetaAddressOf(BOB, 1)) == keccak256(first), "bob untouched");
    }

    // Review focus 4: nonces are per registrant.
    function test_incrementNonce_is_per_registrant() public {
        require(r.nonceOf(ALICE) == 0, "starts at 0");
        vm.expectEmit(true, false, false, true);
        emit NonceIncremented(ALICE, 1);
        vm.prank(ALICE);
        r.incrementNonce();
        require(r.nonceOf(ALICE) == 1, "alice 1");
        require(r.nonceOf(BOB) == 0, "bob 0");
    }

    // ---- registerKeysOnBehalf (EIP-712 + ERC-1271), expected values rebuilt here from the EIP text ----

    uint256 constant PK = 0xA11CE5;
    string constant ENTRY = "Erc6538RegistryEntry(uint256 schemeId,bytes stealthMetaAddress,uint256 nonce)";
    bytes4 constant MAGIC = 0x1626ba7e;

    function _domain(address reg, uint256 chainId_) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC6538Registry"),
                keccak256("1.0"),
                chainId_,
                reg
            )
        );
    }

    function _digest(bytes32 domain, uint256 schemeId, bytes memory meta, uint256 nonce) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", domain, keccak256(abi.encode(keccak256(bytes(ENTRY)), schemeId, keccak256(meta), nonce))
            )
        );
    }

    function _sig(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(pk, digest);
        return abi.encodePacked(rr, ss, v);
    }

    function test_onBehalf_valid_eoa_signature_registers_and_consumes_nonce() public {
        address reg = vm.addr(PK);
        bytes memory m = _meta(0x02, 66);
        bytes memory sig = _sig(PK, _digest(_domain(address(r), block.chainid), 1, m, 0));
        vm.expectEmit(true, true, false, true);
        emit StealthMetaAddressSet(reg, 1, m);
        vm.prank(BOB); // a relayer, not the registrant
        r.registerKeysOnBehalf(reg, 1, sig, m);
        require(keccak256(r.stealthMetaAddressOf(reg, 1)) == keccak256(m), "stored for the registrant");
        require(r.stealthMetaAddressOf(BOB, 1).length == 0, "nothing stored for the relayer");
        require(r.nonceOf(reg) == 1, "nonce consumed");
    }

    function test_onBehalf_replay_reverts() public {
        address reg = vm.addr(PK);
        bytes memory m = _meta(0x02, 66);
        bytes memory sig = _sig(PK, _digest(_domain(address(r), block.chainid), 1, m, 0));
        r.registerKeysOnBehalf(reg, 1, sig, m);
        vm.expectRevert(ERC6538Registry.ERC6538Registry__InvalidSignature.selector);
        r.registerKeysOnBehalf(reg, 1, sig, m);
    }

    function test_onBehalf_wrong_key_reverts() public {
        address reg = vm.addr(PK);
        bytes memory m = _meta(0x02, 66);
        bytes memory sig = _sig(0xBAD, _digest(_domain(address(r), block.chainid), 1, m, 0));
        vm.expectRevert(ERC6538Registry.ERC6538Registry__InvalidSignature.selector);
        r.registerKeysOnBehalf(reg, 1, sig, m);
    }

    function test_onBehalf_wrong_scheme_or_tampered_meta_reverts() public {
        address reg = vm.addr(PK);
        bytes memory m = _meta(0x02, 66);
        bytes memory sig = _sig(PK, _digest(_domain(address(r), block.chainid), 1, m, 0));
        vm.expectRevert(ERC6538Registry.ERC6538Registry__InvalidSignature.selector);
        r.registerKeysOnBehalf(reg, 2, sig, m);
        vm.expectRevert(ERC6538Registry.ERC6538Registry__InvalidSignature.selector);
        r.registerKeysOnBehalf(reg, 1, sig, _meta(0x03, 66));
    }

    function test_onBehalf_incrementNonce_invalidates_pending_signature() public {
        address reg = vm.addr(PK);
        bytes memory m = _meta(0x02, 66);
        bytes memory sig = _sig(PK, _digest(_domain(address(r), block.chainid), 1, m, 0));
        vm.prank(reg);
        r.incrementNonce();
        vm.expectRevert(ERC6538Registry.ERC6538Registry__InvalidSignature.selector);
        r.registerKeysOnBehalf(reg, 1, sig, m);
    }

    function test_onBehalf_scheme1_wrong_length_reverts_before_signature_check() public {
        address reg = vm.addr(PK);
        bytes memory m = _meta(0x02, 65);
        bytes memory sig = _sig(PK, _digest(_domain(address(r), block.chainid), 1, m, 0));
        vm.expectRevert(ERC6538Registry.InvalidMetaAddressLength.selector);
        r.registerKeysOnBehalf(reg, 1, sig, m);
    }

    function test_onBehalf_erc1271_wallet_accepts_magic_value_only() public {
        bytes memory m = _meta(0x02, 66);
        bytes32 digest = _digest(_domain(address(r), block.chainid), 1, m, 0);
        Wallet1271 ok = new Wallet1271(digest, MAGIC);
        r.registerKeysOnBehalf(address(ok), 1, hex"1234", m); // signature bytes are the wallet's business
        require(keccak256(r.stealthMetaAddressOf(address(ok), 1)) == keccak256(m), "contract wallet registered");
        require(r.nonceOf(address(ok)) == 1, "nonce consumed");

        // The same wallet logic answering with a non-magic value, and a wallet that signed a different digest.
        Wallet1271 wrongAnswer = new Wallet1271(digest, 0xdeadbeef);
        vm.expectRevert(ERC6538Registry.ERC6538Registry__InvalidSignature.selector);
        r.registerKeysOnBehalf(address(wrongAnswer), 1, hex"1234", m);
        Wallet1271 wrongDigest = new Wallet1271(bytes32(uint256(1)), MAGIC);
        vm.expectRevert(ERC6538Registry.ERC6538Registry__InvalidSignature.selector);
        r.registerKeysOnBehalf(address(wrongDigest), 1, hex"1234", m);
    }

    function test_domain_separator_follows_chain_id() public {
        bytes32 before = r.DOMAIN_SEPARATOR();
        require(before == _domain(address(r), block.chainid), "initial domain");
        address reg = vm.addr(PK);
        bytes memory m = _meta(0x02, 66);
        bytes memory oldSig = _sig(PK, _digest(before, 1, m, 0));
        bytes memory newSig = _sig(PK, _digest(_domain(address(r), 999), 1, m, 0));

        vm.chainId(999);
        require(r.DOMAIN_SEPARATOR() != before, "domain changed");
        require(r.DOMAIN_SEPARATOR() == _domain(address(r), 999), "recomputed for the new chain");
        vm.expectRevert(ERC6538Registry.ERC6538Registry__InvalidSignature.selector);
        r.registerKeysOnBehalf(reg, 1, oldSig, m);
        r.registerKeysOnBehalf(reg, 1, newSig, m);
    }

    function test_entry_typehash_matches_the_eip_string() public view {
        require(r.ERC6538REGISTRY_ENTRY_TYPE_HASH() == keccak256(bytes(ENTRY)), "typehash");
    }
}
