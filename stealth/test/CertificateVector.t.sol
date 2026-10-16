// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface Vm {
    function addr(uint256) external pure returns (address);
}

/// Cross-language check: the same inputs and expected values are pinned in ts/bond.test.ts, where the digest
/// came from manual byte concatenation and the certificate from ethers' SigningKey. Here the digest is
/// rebuilt with abi.encodePacked (the validator's rule) and the certificate is checked with ecrecover.
contract CertificateVectorTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function test_digest_and_certificate_match_typescript_vector() public view {
        bytes32 domainSeparator = bytes32(hex"1111111111111111111111111111111111111111111111111111111111111111");
        address msgSender = address(uint160(0xA11CE));
        address token = address(uint160(0xDFAB));
        bytes memory payload = hex"0102030405";
        uint256 expiry = 2000000000;
        uint256 nonce = 7;

        bytes32 digest = keccak256(
            abi.encodePacked(domainSeparator, keccak256(abi.encodePacked(msgSender, token, payload, expiry, nonce)))
        );
        require(digest == 0xddaa44b410b3e9fe06d836fcc8d71e4343a24f58b1757b285252b6e941a9fa7c, "digest");

        bytes32 r = 0x7440fafcd4b250b61e5c90fe16b579ed2f89e7fbcb775173b7eaf2c5694733f1;
        bytes32 s = 0x422c40d3ac9ae04a87702e59353bbb935efc24f6f5973aa1a369cb8f2ecbbcef;
        require(ecrecover(digest, 27, r, s) == vm.addr(0xC0570D1A), "signer");
    }
}
