// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {BondTrackerPublic} from "../src/BondTrackerPublic.sol";

// Same minimal inline cheatcode pattern as RestrictedAtom.t.sol -- no forge-std import.
// The public tracker carries lifecycle STATUS only (see BondTrackerPublic.sol). The private
// BondTracker side and the two together are covered in BondTracker.t.sol / BondTrackerPair.t.sol.
interface Vm {
    function expectRevert() external;
    function prank(address) external;
    function addr(uint256 privateKey) external returns (address);
    function recordLogs() external;
    function readFile(string calldata path) external view returns (string memory);
    function keyExistsJson(string calldata json, string calldata key) external view returns (bool);
    function parseJsonString(string calldata json, string calldata key) external view returns (string memory);
    function toLowercase(string calldata input) external pure returns (string memory);

    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function getRecordedLogs() external returns (Log[] memory);
}

contract BondTrackerPublicTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address issuer = vm.addr(1);
    address custodian = vm.addr(2);
    address currencyToken = vm.addr(3);
    address stranger = vm.addr(4);

    function _fresh() internal returns (BondTrackerPublic) {
        vm.prank(issuer);
        return new BondTrackerPublic(issuer, 1000, 2000, currencyToken, 1);
    }

    // issue -> begin -> sold out -> close -> active, one full tranche cycle
    function _cycle(BondTrackerPublic t) internal {
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution();
        vm.prank(issuer);
        t.onDistributionComplete();
        vm.prank(issuer);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive();
    }

    function testOnIssueSetsCustodianAndCountsTranches() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian);
        assert(t.custodian() == custodian);
        assert(t.trancheCount() == 1);
        assert(t.status() == BondTrackerPublic.Status.ISSUED);
    }

    function testTrancheIssuedEventNumbersAreOneIndexedAndSequential() external {
        BondTrackerPublic t = _fresh();
        vm.recordLogs();
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution();
        vm.prank(issuer);
        t.onDistributionComplete();
        vm.prank(issuer);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive();
        vm.prank(issuer);
        t.onIssue(custodian);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 seen = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == keccak256("TrancheIssued(uint256)")) {
                seen++;
                assert(abi.decode(logs[i].data, (uint256)) == seen);
            }
        }
        assert(seen == 2);
        assert(t.trancheCount() == 2);
    }

    function testBeginDistributionRejectsReopeningWhilePreviousRoundStillOpen() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution();

        vm.prank(issuer);
        vm.expectRevert();
        t.beginDistribution();
    }

    function testBeginDistributionAllowedOnceThePreviousRoundIsComplete() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution();
        vm.prank(issuer);
        t.onDistributionComplete();
        assert(t.status() == BondTrackerPublic.Status.DISTRIBUTION_COMPLETE);

        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution(); // must NOT revert
        assert(t.status() == BondTrackerPublic.Status.DISTRIBUTION_STARTED);
    }

    function testOnDistributionCompleteRejectedOutsideARound() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        vm.expectRevert();
        t.onDistributionComplete(); // INITIALIZED

        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        vm.expectRevert();
        t.onDistributionComplete(); // ISSUED

        vm.prank(issuer);
        t.beginDistribution();
        vm.prank(issuer);
        t.onDistributionComplete();
        vm.prank(issuer);
        vm.expectRevert();
        t.onDistributionComplete(); // already COMPLETE: a second call must not pass
    }

    function testForceCompleteDistributionWritesOffStuckRemainder() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution();
        vm.prank(issuer);
        t.forceCompleteDistribution();
        assert(t.status() == BondTrackerPublic.Status.DISTRIBUTION_COMPLETE);

        vm.prank(issuer);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive();
        assert(t.status() == BondTrackerPublic.Status.ACTIVE);
    }

    function testBeginDistributionSucceedsAfterForceComplete() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution();
        vm.prank(issuer);
        t.forceCompleteDistribution();
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution();
        assert(t.status() == BondTrackerPublic.Status.DISTRIBUTION_STARTED);
    }

    function testForceCompleteDistributionRejectsWhenNoRoundInProgress() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        vm.expectRevert();
        t.forceCompleteDistribution();
    }

    function testOnIssueRejectedAtIssued() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        vm.expectRevert();
        t.onIssue(custodian);
    }

    function testOnIssueRejectedAtDistributionStarted() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution();
        vm.prank(issuer);
        vm.expectRevert();
        t.onIssue(custodian);
    }

    function testOnIssueRejectedAtDistributionClosed() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution();
        vm.prank(issuer);
        t.onDistributionComplete();
        vm.prank(issuer);
        t.closeDistribution();
        vm.prank(issuer);
        vm.expectRevert();
        t.onIssue(custodian);
    }

    function testOnIssueSucceedsAtDistributionCompleteAndActive() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian);
        vm.prank(issuer);
        t.beginDistribution();
        vm.prank(issuer);
        t.onDistributionComplete();
        vm.prank(issuer);
        t.onIssue(custodian); // burn-on-reopen path: COMPLETE -> ISSUED
        assert(t.trancheCount() == 2);

        BondTrackerPublic u = _fresh();
        _cycle(u);
        vm.prank(issuer);
        u.onIssue(custodian); // ACTIVE -> ISSUED
        assert(u.trancheCount() == 2);
    }

    function testOnlyOwnerMayDriveTheLifecycle() external {
        BondTrackerPublic t = _fresh();
        vm.prank(stranger);
        vm.expectRevert();
        t.onIssue(custodian);
        vm.prank(stranger);
        vm.expectRevert();
        t.beginDistribution();
        vm.prank(stranger);
        vm.expectRevert();
        t.onDistributionComplete();
        vm.prank(stranger);
        vm.expectRevert();
        t.forceCompleteDistribution();
        vm.prank(stranger);
        vm.expectRevert();
        t.closeDistribution();
        vm.prank(stranger);
        vm.expectRevert();
        t.setActive();
    }

    // ---- privacy guard: no amount-like field may ever reappear on the PUBLIC tracker ----
    // Walks the compiled ABI of every function (inputs and outputs), event and the constructor.
    // A parameter fails if its name looks like an amount/units/price/supply/quantity/balance, or
    // if it is a uint that is not on the explicit allowlist (instrument terms, tranche number,
    // status enums). The allowlist is deliberately closed: a new uint must be justified here.

    function testPublicTrackerAbiCarriesNoAmounts() external view {
        string memory json = vm.readFile("out/BondTrackerPublic.sol/BondTrackerPublic.json");
        assert(_violations(json) == 0);
    }

    // The guard itself must catch what it is for (upstream-shaped ABI with amounts).
    function testAbiGuardCatchesAmountParametersAndGetters() external view {
        string memory badFunction =
            '{"abi":[{"type":"function","name":"onDistribute","inputs":[{"name":"amount","type":"uint256","internalType":"uint256"}],"outputs":[]}]}';
        assert(_violations(badFunction) >= 1);
        string memory badEvent =
            '{"abi":[{"type":"event","name":"TrancheIssued","inputs":[{"name":"trancheNo","type":"uint256","internalType":"uint256"},{"name":"amount","type":"uint256","internalType":"uint256"}]}]}';
        assert(_violations(badEvent) >= 1);
        string memory badGetter =
            '{"abi":[{"type":"function","name":"totalSupply","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}]}]}';
        assert(_violations(badGetter) >= 1);
        string memory unnamedUint =
            '{"abi":[{"type":"function","name":"onSomething","inputs":[{"name":"x","type":"uint256","internalType":"uint256"}],"outputs":[]}]}';
        assert(_violations(unnamedUint) >= 1);
    }

    function _violations(string memory json) internal view returns (uint256 count) {
        for (uint256 i = 0; vm.keyExistsJson(json, string.concat(".abi[", _s(i), "]")); i++) {
            string memory base = string.concat(".abi[", _s(i), "]");
            string memory kind = vm.parseJsonString(json, string.concat(base, ".type"));
            string memory owner = _eq(kind, "constructor") ? "constructor" : vm.parseJsonString(json, string.concat(base, ".name"));
            if (_deniedMember(owner)) count++;
            count += _paramViolations(json, string.concat(base, ".inputs"), owner);
            if (_eq(kind, "function")) count += _paramViolations(json, string.concat(base, ".outputs"), owner);
        }
    }

    function _paramViolations(string memory json, string memory list, string memory owner)
        internal
        view
        returns (uint256 count)
    {
        for (uint256 j = 0; vm.keyExistsJson(json, string.concat(list, "[", _s(j), "]")); j++) {
            string memory p = string.concat(list, "[", _s(j), "]");
            string memory name = vm.parseJsonString(json, string.concat(p, ".name"));
            string memory typ = vm.parseJsonString(json, string.concat(p, ".type"));
            string memory internalType = vm.parseJsonString(json, string.concat(p, ".internalType"));
            if (_deniedName(name)) count++;
            if (_startsWith(typ, "uint") && !_startsWith(internalType, "enum ") && !_allowedUint(owner, name)) count++;
        }
    }

    function _allowedUint(string memory owner, string memory name) internal pure returns (bool) {
        string memory k = string.concat(owner, ".", name);
        return _eq(k, "constructor.issueDate_") || _eq(k, "constructor.maturityDate_") || _eq(k, "constructor.faceValue_")
            || _eq(k, "BondDetailsChanged.issueDate") || _eq(k, "BondDetailsChanged.maturityDate")
            || _eq(k, "BondDetailsChanged.faceValue") || _eq(k, "TrancheIssued.trancheNo") || _eq(k, "trancheCount.");
    }

    function _deniedName(string memory name) internal view returns (bool) {
        string memory n = vm.toLowercase(name);
        return _contains(n, "amount") || _contains(n, "unit") || _contains(n, "price") || _contains(n, "supply")
            || _contains(n, "quantity") || _contains(n, "balance") || _contains(n, "denomination") || _contains(n, "total");
    }

    function _deniedMember(string memory name) internal view returns (bool) {
        return _deniedName(name) || _eq(name, "onDistribute") || _eq(name, "onBurn") || _eq(name, "onStaleLockSettled")
            || _eq(name, "distribution");
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _startsWith(string memory h, string memory n) internal pure returns (bool) {
        bytes memory hb = bytes(h);
        bytes memory nb = bytes(n);
        if (nb.length > hb.length) return false;
        for (uint256 i = 0; i < nb.length; i++) if (hb[i] != nb[i]) return false;
        return true;
    }

    function _contains(string memory h, string memory n) internal pure returns (bool) {
        bytes memory hb = bytes(h);
        bytes memory nb = bytes(n);
        if (nb.length > hb.length) return false;
        for (uint256 i = 0; i + nb.length <= hb.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < nb.length; j++) {
                if (hb[i + j] != nb[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    function _s(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}
