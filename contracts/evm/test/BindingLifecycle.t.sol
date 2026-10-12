// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./OpusBase.sol";

/// Binding lifecycle after the 12 October 2026 review (M-1, M-2, L-1, L-5): the delay is anchored to the
/// award's commit as well as the bind, the binding a payment used stays payable through later rotations
/// and cancels, the owner's cancel is capped before the first payment, the delay is bounded, and cancel
/// is an explicit one-shot flag.
contract BindingLifecycleTest is OpusBase {
    uint64 constant ALICE = 4242;

    function setUp() public {
        deployWithDelay(DELAY);
        fund(10_000e6);
    }

    function payAs(bytes32 id, uint64 version) internal {
        vm.prank(RELAYER);
        escrow.pay(id, version);
    }

    function cancelAs(uint64 actor, uint64 version) internal {
        vm.prank(OWNER);
        escrow.cancelBinding(actor, version);
    }

    /// M-1: a binding armed long before any award waits bindingDelay from the commit, and the owner can
    /// cancel it in that window even though its own delay passed weeks ago.
    function test_preArmedBindingWaitsForCommitDelayAndOwnerCanCancel() public {
        uint64 v = bindAs(ALICE, ATTACKER);
        vm.warp(block.timestamp + 30 days);
        bytes32 id = commit(keccak256("award"), ALICE, 1_000e6);
        uint64 committedAt = uint64(block.timestamp);
        (,,,, uint64 stored,) = escrow.awards(id);
        check(stored == committedAt && escrow.lastCommittedAt(ALICE) == committedAt, "commit time recorded");
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.AwardPending.selector);
        escrow.pay(id, v);
        vm.warp(committedAt + DELAY - 1);
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.AwardPending.selector);
        escrow.pay(id, v);
        cancelAs(ALICE, v);
        vm.warp(committedAt + DELAY);
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.pay(id, v);
        check(usdc.balanceOf(ATTACKER) == 0 && escrow.reservedPrincipal() == 980e6, "nothing left the vault");
    }

    /// M-1: at exactly committedAt + delay the owner's window closes and pay opens; no instant allows both.
    function test_commitWindowClosesWhenPayOpens() public {
        uint64 v = bindAs(ALICE, ALICE_WALLET);
        vm.warp(block.timestamp + DELAY);
        bytes32 id = commit(keccak256("award"), ALICE, 100e6);
        vm.warp(block.timestamp + DELAY);
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, v);
        payAs(id, v);
        check(usdc.balanceOf(ALICE_WALLET) == 98e6, "paid at the boundary");
    }

    /// M-1 and M-2 together: a later award to an actor with an active binding still waits its commit
    /// delay, but the owner cannot cancel the binding that has already paid.
    function test_laterAwardWaitsButActiveBindingIsNotCancellable() public {
        bytes32 first = commit(keccak256("first"), ALICE, 100e6);
        uint64 v = bindAs(ALICE, ALICE_WALLET);
        vm.warp(block.timestamp + DELAY);
        payAs(first, v);
        bytes32 second = commit(keccak256("second"), ALICE, 100e6);
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.AwardPending.selector);
        escrow.pay(second, v);
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, v);
        vm.warp(block.timestamp + DELAY);
        payAs(second, v);
        check(usdc.balanceOf(ALICE_WALLET) == 196e6, "both paid to the active binding");
    }

    /// M-2: rotation leaves the active binding payable during the new binding's delay, and moves the
    /// destination only once that delay has passed.
    function test_rotationLeavesActiveBindingPayable() public {
        bytes32 first = commit(keccak256("first"), ALICE, 100e6);
        bytes32 second = commit(keccak256("second"), ALICE, 100e6);
        uint64 v1 = bindAs(ALICE, ALICE_WALLET);
        vm.warp(block.timestamp + DELAY);
        payAs(first, v1);
        (address active, uint64 activeVersion) = escrow.activeBindings(ALICE);
        check(active == ALICE_WALLET && activeVersion == v1, "first payment activated v1");
        address newWallet = address(0xA2);
        uint64 v2 = bindAs(ALICE, newWallet);
        (address payable_, uint64 payableVersion) = escrow.payableBinding(ALICE);
        check(payable_ == ALICE_WALLET && payableVersion == v1, "v1 payable while v2 pending");
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.pay(second, v2);
        payAs(second, v1);
        check(usdc.balanceOf(ALICE_WALLET) == 196e6, "second award paid to the active binding");
        bytes32 third = commit(keccak256("third"), ALICE, 100e6);
        vm.warp(block.timestamp + DELAY);
        (payable_, payableVersion) = escrow.payableBinding(ALICE);
        check(payable_ == newWallet && payableVersion == v2, "v2 payable after its delay");
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.pay(third, v1);
        payAs(third, v2);
        check(usdc.balanceOf(newWallet) == 98e6, "third award follows the rotation");
        (active, activeVersion) = escrow.activeBindings(ALICE);
        check(active == newWallet && activeVersion == v2, "v2 is now the active binding");
    }

    /// M-2: cancelling the pending rotation drops only the pending slot; the active binding keeps paying.
    function test_cancelPendingLeavesActiveBindingPayable() public {
        bytes32 first = commit(keccak256("first"), ALICE, 100e6);
        bytes32 second = commit(keccak256("second"), ALICE, 100e6);
        uint64 v1 = bindAs(ALICE, ALICE_WALLET);
        vm.warp(block.timestamp + DELAY);
        payAs(first, v1);
        uint64 v2 = bindAs(ALICE, ATTACKER);
        cancelAs(ALICE, v2);
        vm.warp(block.timestamp + 10 * DELAY);
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.pay(second, v2);
        payAs(second, v1);
        check(usdc.balanceOf(ALICE_WALLET) == 196e6 && usdc.balanceOf(ATTACKER) == 0, "active paid, pending not");
        // The cap does not apply once the actor has an active binding: the owner may refuse every later
        // rotation, and each refusal only keeps payments on the binding already in use.
        for (uint64 i = 0; i < 10; i++) {
            uint64 v = bindAs(ALICE, ATTACKER);
            cancelAs(ALICE, v);
        }
        check(escrow.cancelCount(ALICE) == 0, "cancels after activation are not counted");
    }

    /// M-2 cap: before the first payment the owner can cancel at most MAX_CANCELS_BEFORE_ACTIVE times.
    function test_cancelCapBeforeFirstPayment() public {
        bytes32 id = commit(keccak256("award"), ALICE, 100e6);
        uint8 cap = escrow.MAX_CANCELS_BEFORE_ACTIVE();
        for (uint8 i = 0; i < cap; i++) {
            uint64 v = bindAs(ALICE, ATTACKER);
            cancelAs(ALICE, v);
            check(escrow.cancelCount(ALICE) == i + 1, "cancel counted");
        }
        uint64 last = bindAs(ALICE, ALICE_WALLET);
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.CancelLimit.selector);
        escrow.cancelBinding(ALICE, last);
        vm.warp(block.timestamp + DELAY);
        payAs(id, last);
        check(usdc.balanceOf(ALICE_WALLET) == 98e6, "fourth binding pays");
    }

    /// L-1: both constructors bound the delay to [1 hour, 30 days].
    function test_delayBounds() public {
        uint64[4] memory bad = [uint64(0), 1 hours - 1, 30 days + 1, type(uint64).max];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(ProjectEscrow.InvalidInput.selector);
            new EscrowFactory(IERC20(address(usdc)), FEE, AUTHORITY, bad[i]);
            vm.expectRevert(ProjectEscrow.InvalidInput.selector);
            new ProjectEscrow(keccak256("p"), IERC20(address(usdc)), OWNER, OWNER, FEE, AUTHORITY, bad[i]);
        }
        ProjectEscrow low =
            new ProjectEscrow(keccak256("p"), IERC20(address(usdc)), OWNER, OWNER, FEE, AUTHORITY, 1 hours);
        ProjectEscrow high =
            new ProjectEscrow(keccak256("p"), IERC20(address(usdc)), OWNER, OWNER, FEE, AUTHORITY, 30 days);
        check(low.bindingDelay() == 1 hours && high.bindingDelay() == 30 days, "bounds inclusive");
    }

    /// L-5: cancel reverts on a missing binding, a cancelled binding, and a binding that has paid.
    function test_cancelOnCancelledOrMissingBindingReverts() public {
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, 1);
        uint64 v = bindAs(ALICE, ALICE_WALLET);
        cancelAs(ALICE, v);
        (,,,, bool cancelled) = escrow.bindings(ALICE);
        check(cancelled, "flag set");
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, v);
        check(escrow.cancelCount(ALICE) == 1, "second attempt not counted");
        // A fresh binding replaces the cancelled one and can be cancelled once.
        uint64 next = bindAs(ALICE, ALICE_WALLET);
        (,,,, cancelled) = escrow.bindings(ALICE);
        check(!cancelled && next == v + 1, "replacement is live");
    }
}
