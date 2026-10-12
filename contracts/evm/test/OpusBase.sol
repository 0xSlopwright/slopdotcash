// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProjectEscrow, EscrowFactory, IERC20} from "../src/ProjectEscrow.sol";
import {TestDollar} from "../integration/TestDollar.sol";

struct OpusVmLog {
    bytes32[] topics;
    bytes data;
    address emitter;
}

interface OpusVm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function assume(bool) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (OpusVmLog[] memory);
}

abstract contract OpusBase {
    OpusVm internal constant vm = OpusVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint64 internal constant DELAY = 48 hours;
    address internal constant OWNER = address(0xA11CE);
    address internal constant AUTHORITY = address(0xA77E);
    address internal constant FEE = address(0xFEE);
    address internal constant REGISTRAR = address(0x4E6);
    address internal constant ALICE_WALLET = address(0xA1);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant RELAYER = address(0x4E1A);

    TestDollar internal usdc;
    EscrowFactory internal factory;
    ProjectEscrow internal escrow;

    function deployWithDelay(uint64 delay) internal {
        vm.warp(1_800_000_000);
        usdc = new TestDollar();
        vm.prank(REGISTRAR);
        factory = new EscrowFactory(IERC20(address(usdc)), FEE, AUTHORITY, delay);
        vm.prank(REGISTRAR);
        escrow = ProjectEscrow(factory.create(keccak256("project"), OWNER, OWNER));
        usdc.mint(OWNER, 1_000_000e6);
        vm.prank(OWNER);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function fund(uint64 amount) internal {
        vm.prank(OWNER);
        escrow.deposit(amount);
    }

    function commit(bytes32 source, uint64 actor, uint64 gross) internal returns (bytes32 id) {
        id = escrow.awardId(source);
        vm.prank(OWNER);
        escrow.commitAward(id, actor, gross, source);
    }

    function bindAs(uint64 actor, address dest) internal returns (uint64 version) {
        (, uint64 current,,) = escrow.bindings(actor);
        vm.prank(AUTHORITY);
        escrow.bindDestination(
            actor, dest, current, keccak256(abi.encode(actor, dest, current)), uint64(block.timestamp + 1 hours)
        );
        version = current + 1;
    }

    function check(bool ok, string memory why) internal pure {
        require(ok, why);
    }
}
