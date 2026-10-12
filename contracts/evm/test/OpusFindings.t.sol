// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./OpusBase.sol";

contract OpusFindingsTest is OpusBase {
    uint64 constant ALICE = 4242;

    function setUp() public {
        deployWithDelay(DELAY);
        fund(10_000e6);
    }

    /// F-1: a binding made while the actor has no award in this vault matures unobserved; once active it
    /// cannot be cancelled, and any later award to that actor pays the bound wallet in the same block it is
    /// committed. The owner never gets a delay window tied to the money.
    function test_F1_preArmedBindingPaysInstantlyAfterCommit() public {
        // Compromised authority pre-binds a future contributor's actor id to the attacker.
        uint64 v = bindAs(ALICE, ATTACKER);
        vm.warp(block.timestamp + DELAY);
        // Owner can no longer cancel: the binding is active and final.
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, v);
        // Weeks later the owner approves Alice's monthly award.
        vm.warp(block.timestamp + 30 days);
        bytes32 id = commit(keccak256("eliza/2026-11/alice"), ALICE, 1_000e6);
        // Same block, permissionless relayer pays the attacker. No delay, no veto.
        vm.prank(RELAYER);
        escrow.pay(id, v);
        check(usdc.balanceOf(ATTACKER) == 980e6, "attacker received net");
        check(usdc.balanceOf(ALICE_WALLET) == 0, "alice received nothing");
    }

    /// F-2: the owner can cancel every binding the authority issues, forever. The award stays reserved,
    /// can never be paid, and the owner cannot reclaim it either: a permanent lock chosen by the owner.
    function test_F2_ownerCanBlockCommittedAwardIndefinitely() public {
        bytes32 id = commit(keccak256("eliza/2026-11/alice"), ALICE, 1_000e6);
        for (uint256 i = 0; i < 25; i++) {
            uint64 v = bindAs(ALICE, ALICE_WALLET);
            vm.prank(OWNER);
            escrow.cancelBinding(ALICE, v);
            vm.warp(block.timestamp + DELAY + 1);
            vm.prank(RELAYER);
            vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
            escrow.pay(id, v);
        }
        (,,,, bool paid) = escrow.awards(id);
        check(!paid, "never paid");
        check(escrow.reservedPrincipal() == 980e6, "still reserved");
        // Owner cannot withdraw the reserved gross either.
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InsufficientFreeBalance.selector);
        escrow.withdrawUnused(9_001e6);
    }

    /// F-3: once the immutable authority key is compromised, the honest owner can only cancel. The attacker
    /// rotates an ACTIVE honest binding (destroying it), the owner cancels, and only the same compromised key
    /// can rebind. Every cycle either repeats or ends in theft; the award can never reach Alice safely.
    function test_F3_compromisedAuthorityConvertsToLockOrTheft() public {
        uint64 good = bindAs(ALICE, ALICE_WALLET);
        vm.warp(block.timestamp + DELAY);
        bytes32 id = commit(keccak256("eliza/2026-11/alice"), ALICE, 1_000e6);
        // Attacker front-runs the pay with a rotation; the relayer's pay for the honest version fails.
        uint64 bad = bindAs(ALICE, ATTACKER);
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.pay(id, good);
        // Owner cancels the bad rotation. The honest binding is gone; nothing the owner can do restores it.
        vm.prank(OWNER);
        escrow.cancelBinding(ALICE, bad);
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.pay(id, bad);
        // Any honest re-bind by the operator is raced by the attacker holding the same immutable key.
        uint64 honest = bindAs(ALICE, ALICE_WALLET);
        uint64 bad2 = bindAs(ALICE, ATTACKER);
        check(bad2 == honest + 1, "attacker overwrote honest rebind");
        // If the owner misses a single 48h window, the attacker is paid.
        vm.warp(block.timestamp + DELAY);
        vm.prank(RELAYER);
        escrow.pay(id, bad2);
        check(usdc.balanceOf(ATTACKER) == 980e6, "theft after one missed window");
    }

    /// F-4a: bindingDelay has no on-chain floor. With delay 0 the owner veto is unreachable.
    function test_F4_zeroDelayMakesCancelUnreachable() public {
        deployWithDelay(0);
        fund(1_000e6);
        bytes32 id = commit(keccak256("s"), ALICE, 100e6);
        uint64 v = bindAs(ALICE, ATTACKER);
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, v);
        escrow.pay(id, v);
        check(usdc.balanceOf(ATTACKER) == 98e6, "paid with no veto");
    }

    /// F-4b: an oversized bindingDelay makes every bindDestination overflow, so every award is locked.
    function test_F4_hugeDelayBricksBinding() public {
        deployWithDelay(type(uint64).max - 1_000);
        fund(1_000e6);
        commit(keccak256("s"), ALICE, 100e6);
        vm.prank(AUTHORITY);
        vm.expectRevert(); // panic 0x11
        escrow.bindDestination(ALICE, ALICE_WALLET, 0, keccak256("c"), uint64(block.timestamp + 1));
    }

    /// F-5: cancelBinding on an already-cancelled binding succeeds again and re-emits BindingCancelled.
    function test_F5_cancelIsRepeatable() public {
        uint64 v = bindAs(ALICE, ALICE_WALLET);
        vm.recordLogs();
        vm.startPrank(OWNER);
        escrow.cancelBinding(ALICE, v);
        escrow.cancelBinding(ALICE, v);
        vm.warp(block.timestamp + 365 days);
        escrow.cancelBinding(ALICE, v);
        vm.stopPrank();
        OpusVmLog[] memory logs = vm.getRecordedLogs();
        check(logs.length == 3, "three BindingCancelled events for one binding");
    }

    /// Info: a one-unit withdrawal can carry a 100% fee (net zero transfer, event net 0).
    function test_withdrawFeeCanEqualGross() public {
        vm.startPrank(OWNER);
        escrow.withdrawUnused(9);
        uint256 before = usdc.balanceOf(OWNER);
        escrow.withdrawUnused(1);
        vm.stopPrank();
        check(usdc.balanceOf(OWNER) == before, "net zero");
        check(escrow.totalWithdrawalFees() == 1, "fee 1 on gross 1");
    }

    /// Sound: a cancelled binding never pays, even far in the future, and a rotation after it pays only
    /// after its own delay.
    function test_sound_cancelledNeverPaysAndRotationWaits() public {
        bytes32 id = commit(keccak256("s"), ALICE, 100e6);
        uint64 v = bindAs(ALICE, ATTACKER);
        vm.prank(OWNER);
        escrow.cancelBinding(ALICE, v);
        vm.warp(block.timestamp + 3650 days);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.pay(id, v);
        uint64 v2 = bindAs(ALICE, ALICE_WALLET);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.pay(id, v2);
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.pay(id, v2);
        vm.warp(block.timestamp + 1);
        // Exactly at activatesAt the owner can no longer cancel and pay succeeds: no overlap.
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, v2);
        escrow.pay(id, v2);
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        escrow.pay(id, v2);
        // Owner cannot pre-cancel a version that does not exist yet.
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, v2 + 1);
    }

    /// Sound: award IDs are vault-bound; another vault cannot commit this vault's ID.
    function test_sound_awardIdIsVaultBound() public {
        vm.prank(REGISTRAR);
        ProjectEscrow other = ProjectEscrow(factory.create(keccak256("project-2"), OWNER, OWNER));
        bytes32 src = keccak256("same-source");
        bytes32 idHere = escrow.awardId(src);
        check(other.awardId(src) != idHere, "distinct");
        usdc.mint(OWNER, 0);
        vm.prank(OWNER);
        usdc.approve(address(other), type(uint256).max);
        vm.prank(OWNER);
        other.deposit(10e6);
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        other.commitAward(idHere, ALICE, 1e6, src);
        vm.prank(REGISTRAR);
        vm.expectRevert(ProjectEscrow.DuplicateAward.selector);
        factory.create(keccak256("project"), OWNER, OWNER);
    }
}
