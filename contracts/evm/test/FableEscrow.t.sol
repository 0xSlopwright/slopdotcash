// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProjectEscrow, EscrowFactory, IERC20} from "../src/ProjectEscrow.sol";
import {TestDollar} from "../integration/TestDollar.sol";

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function assume(bool) external;
}

/// @dev Minimal harness: no forge-std is vendored in the scratch project.
contract FableBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant OWNER = address(0xA11CE);
    address internal constant AUTHORITY = address(0xA07);
    address internal constant FEE = address(0xFEE);
    address internal constant REGISTRAR = address(0x5E6);
    address internal constant CONTRIBUTOR = address(0xC0DE);
    address internal constant ATTACKER = address(0xBAD);
    uint64 internal constant DELAY = 48 hours;
    bytes32 internal constant PROJECT = keccak256("project");

    TestDollar internal usdc;
    EscrowFactory internal factory;
    ProjectEscrow internal vault;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdc = new TestDollar();
        vm.prank(REGISTRAR);
        factory = new EscrowFactory(IERC20(address(usdc)), FEE, AUTHORITY, DELAY);
        vm.prank(REGISTRAR);
        vault = ProjectEscrow(factory.create(PROJECT, OWNER, OWNER));
        usdc.mint(OWNER, 1_000_000_000e6);
        vm.prank(OWNER);
        usdc.approve(address(vault), type(uint256).max);
    }

    function depositAs(uint64 amount) internal {
        vm.prank(OWNER);
        vault.deposit(amount);
    }

    function commit(bytes32 source, uint64 actor, uint64 gross) internal returns (bytes32 id) {
        id = vault.awardId(source);
        vm.prank(OWNER);
        vault.commitAward(id, actor, gross, source);
    }

    function bind(uint64 actor, address dest, uint64 expected) internal {
        vm.prank(AUTHORITY);
        vault.bindDestination(
            actor, dest, expected, keccak256(abi.encode(actor, dest, expected)), uint64(block.timestamp + 1 hours)
        );
    }

    function conservationHolds() internal view returns (bool) {
        uint256 lhs = vault.totalDeposited();
        uint256 rhs = uint256(vault.freeBalance()) + vault.reservedPrincipal() + vault.reservedFees()
            + vault.totalPaid() + vault.totalPayoutFees() + vault.totalGrossWithdrawn() + vault.totalServiceFees();
        uint256 bal = usdc.balanceOf(address(vault));
        uint256 held =
            uint256(vault.freeBalance()) + vault.reservedPrincipal() + vault.reservedFees() + vault.accruedFees();
        return lhs == rhs && bal == held;
    }
}

contract FableEscrowTest is FableBase {
    // ------------------------------------------------------------------
    // F-1: no authority rotation, no award cancel, no rescue. A lost or
    // compromised authority key strands every unpaid award for actors that
    // have no active binding. Owner veto converts theft into indefinite lock.
    // ------------------------------------------------------------------
    function test_F1_lostAuthorityStrandsUnpaidAwards() public {
        depositAs(1_000e6);
        bytes32 id = commit(keccak256("src-1"), 42, 100e6);
        // Authority key is "lost": nobody can bind actor 42. Payment is impossible.
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(id, 1);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(id, 0);
        // The reserved 100e6 is unreachable by the owner: free is 900e6 only.
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InsufficientFreeBalance.selector);
        vault.withdrawUnused(900e6 + 1);
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InsufficientFreeBalance.selector);
        vault.chargeService(900e6 + 1, keccak256("inv"));
        // Compromised-key variant: attacker binds, owner vetoes, forever. The
        // honest contributor can never be bound because only the compromised
        // key can bind, and the award cannot be refunded or cancelled.
        for (uint64 round = 0; round < 5; round++) {
            bind(42, ATTACKER, round);
            vm.warp(block.timestamp + DELAY - 1);
            vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
            vault.pay(id, round + 1);
            vm.prank(OWNER);
            vault.cancelBinding(42, round + 1);
            vm.warp(block.timestamp + 365 days);
            vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
            vault.pay(id, round + 1);
        }
        require(vault.reservedPrincipal() == 98e6 && vault.reservedFees() == 2e6, "reserve still locked");
        require(conservationHolds(), "conservation");
    }

    // ------------------------------------------------------------------
    // F-2: an ACTIVE ("final") binding is stripped by authority rotation plus
    // owner cancel; the owner can repeat the cancel for every later version
    // without bound, so the documented "delay" is unbounded in practice.
    // ------------------------------------------------------------------
    function test_F2_activeBindingLostAfterRotateAndCancel() public {
        depositAs(1_000e6);
        bytes32 id = commit(keccak256("src-2"), 7, 50e6);
        bind(7, CONTRIBUTOR, 0);
        vm.warp(block.timestamp + DELAY);
        // v1 is active and final: owner cannot cancel it.
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.cancelBinding(7, 1);
        // Authority rotates (to the same destination even) before anyone pays.
        bind(7, CONTRIBUTOR, 1);
        // Owner now cancels v2; v1 is gone, nothing pays.
        vm.prank(OWNER);
        vault.cancelBinding(7, 2);
        vm.warp(block.timestamp + 10 * DELAY);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(id, 1);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(id, 2);
        // Owner can keep doing this for every future version.
        for (uint64 v = 2; v < 12; v++) {
            bind(7, CONTRIBUTOR, v);
            vm.prank(OWNER);
            vault.cancelBinding(7, v + 1);
        }
        vm.warp(block.timestamp + 10 * DELAY);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(id, 12);
        (,,,, bool paid) = vault.awards(id);
        require(!paid, "never paid");
    }

    // ------------------------------------------------------------------
    // F-3: bindingDelay is unbounded at the factory. Two failure modes:
    // (a) delay near uint64 max makes every bindDestination revert on checked
    //     overflow, so no award in any vault of that factory can ever pay;
    // (b) delay == uint64.max - now yields activatesAt == the cancel sentinel,
    //     so the binding is born cancelled and pay never succeeds.
    // ------------------------------------------------------------------
    function test_F3a_hugeDelayBricksBinding() public {
        vm.prank(REGISTRAR);
        EscrowFactory f = new EscrowFactory(IERC20(address(usdc)), FEE, AUTHORITY, type(uint64).max);
        vm.prank(REGISTRAR);
        ProjectEscrow v = ProjectEscrow(f.create(keccak256("p2"), OWNER, OWNER));
        vm.prank(AUTHORITY);
        vm.expectRevert(); // arithmetic overflow panic, not InvalidBinding
        v.bindDestination(1, CONTRIBUTOR, 0, keccak256("c"), uint64(block.timestamp));
    }

    function test_F3b_sentinelCollision() public {
        uint64 delay = type(uint64).max - uint64(block.timestamp);
        vm.prank(REGISTRAR);
        EscrowFactory f = new EscrowFactory(IERC20(address(usdc)), FEE, AUTHORITY, delay);
        vm.prank(REGISTRAR);
        ProjectEscrow v = ProjectEscrow(f.create(keccak256("p3"), OWNER, OWNER));
        vm.prank(AUTHORITY);
        v.bindDestination(1, CONTRIBUTOR, 0, keccak256("c"), uint64(block.timestamp));
        (,,, uint64 activatesAt) = v.bindings(1);
        require(activatesAt == type(uint64).max, "born cancelled");
    }

    // ------------------------------------------------------------------
    // F-4: cancelBinding is idempotent and re-emits BindingCancelled for a
    // version that is already cancelled (event duplication for indexers).
    // ------------------------------------------------------------------
    event BindingCancelled(uint64 indexed actorId, uint64 version);

    function test_F4_cancelIsIdempotentAndReemits() public {
        bind(9, CONTRIBUTOR, 0);
        vm.prank(OWNER);
        vault.cancelBinding(9, 1);
        vm.warp(block.timestamp + 10 * DELAY);
        // Second cancel of the same version succeeds long after the original window.
        vm.prank(OWNER);
        vault.cancelBinding(9, 1);
        vm.prank(OWNER);
        vault.cancelBinding(9, 1);
        (, uint64 version,, uint64 activatesAt) = vault.bindings(9);
        require(version == 1 && activatesAt == type(uint64).max, "still cancelled");
    }

    // ------------------------------------------------------------------
    // Soundness checks (expected to pass, documenting what resists attack).
    // ------------------------------------------------------------------
    function test_sound_cancelledBindingNeverPays_andBoundaryInstants() public {
        depositAs(1_000e6);
        bytes32 id = commit(keccak256("src-s1"), 3, 100e6);
        bind(3, CONTRIBUTOR, 0);
        (,,, uint64 activatesAt) = vault.bindings(3);
        // One second before activation: pay fails, cancel allowed.
        vm.warp(activatesAt - 1);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(id, 1);
        // At activation: cancel fails, pay succeeds. No instant allows both.
        vm.warp(activatesAt);
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.cancelBinding(3, 1);
        vault.pay(id, 1);
        require(usdc.balanceOf(CONTRIBUTOR) == 98e6, "net 98");
        require(vault.accruedFees() == 2e6, "fee 2");
        // Replay fails.
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        vault.pay(id, 1);
        // Same source cannot be re-committed.
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.DuplicateAward.selector);
        vault.commitAward(id, 3, 1e6, keccak256("src-s1"));
        require(conservationHolds(), "conservation");
    }

    function test_sound_rotationInvalidatesStalePay() public {
        depositAs(1_000e6);
        bytes32 id = commit(keccak256("src-s2"), 5, 100e6);
        bind(5, CONTRIBUTOR, 0);
        vm.warp(block.timestamp + DELAY);
        bind(5, ATTACKER, 1); // rotation by authority, pending again
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(id, 1);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(id, 2);
        vm.prank(OWNER);
        vault.cancelBinding(5, 2);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(id, 2);
        require(usdc.balanceOf(ATTACKER) == 0, "attacker got nothing");
    }

    function test_sound_cannotCancelNonexistentOrFutureVersion() public {
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.cancelBinding(77, 1);
        bind(77, CONTRIBUTOR, 0);
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.cancelBinding(77, 2);
    }

    function test_sound_destinationEqualsFeeRecipientOrOwner() public {
        depositAs(1_000e6);
        bytes32 a = commit(keccak256("src-fee"), 11, 100e6);
        bytes32 b = commit(keccak256("src-own"), 12, 100e6);
        bind(11, FEE, 0);
        bind(12, OWNER, 0);
        vm.warp(block.timestamp + DELAY);
        uint256 feeBefore = usdc.balanceOf(FEE);
        uint256 ownerBefore = usdc.balanceOf(OWNER);
        vault.pay(a, 1);
        vault.pay(b, 1);
        require(usdc.balanceOf(FEE) == feeBefore + 98e6, "fee dest net");
        require(usdc.balanceOf(OWNER) == ownerBefore + 98e6, "owner dest net");
        require(vault.accruedFees() == 4e6, "fees still accrued, not swept");
        vault.claimFees();
        require(usdc.balanceOf(FEE) == feeBefore + 98e6 + 4e6, "claimed");
        require(conservationHolds(), "conservation");
    }

    function test_sound_withdrawalFeeSplitInvariant(uint8 parts, uint64 total) public {
        vm.assume(parts > 0 && parts < 50);
        vm.assume(total > 0 && total <= 1_000_000e6);
        depositAs(total);
        uint64 remaining = total;
        for (uint8 i = 0; i < parts && remaining > 0; i++) {
            uint64 g = i == parts - 1 ? remaining : remaining / (parts - i);
            if (g == 0) g = remaining;
            vm.prank(OWNER);
            vault.withdrawUnused(g);
            remaining -= g;
        }
        require(vault.totalGrossWithdrawn() == total, "all out");
        require(vault.totalWithdrawalFees() == total / 10, "fee == floor(total/10) regardless of split");
        require(vault.accruedFees() == total / 10, "accrued");
        require(usdc.balanceOf(OWNER) == 1_000_000_000e6 - total + (total - total / 10), "owner net");
        require(conservationHolds(), "conservation");
    }

    function test_sound_oneUnitWithdrawalCanBeAllFee() public {
        depositAs(100);
        vm.prank(OWNER);
        vault.withdrawUnused(9); // cumulative 9, fee 0
        uint256 before = usdc.balanceOf(OWNER);
        vm.prank(OWNER);
        vault.withdrawUnused(1); // cumulative 10, fee 1, net 0: sendExact(0) returns early, no revert
        require(usdc.balanceOf(OWNER) == before, "net zero");
        require(vault.totalWithdrawalFees() == 1 && vault.accruedFees() == 1, "fee 1");
        require(conservationHolds(), "conservation");
    }

    function test_sound_chargeServiceOnlyFreeFunds_andConservation() public {
        depositAs(1_000e6);
        commit(keccak256("src-c"), 21, 400e6);
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InsufficientFreeBalance.selector);
        vault.chargeService(600e6 + 1, keccak256("inv-1"));
        vm.prank(OWNER);
        vault.chargeService(600e6, keccak256("inv-1"));
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.DuplicateInvoice.selector);
        vault.chargeService(1, keccak256("inv-1"));
        // Owner can "drain" its own free funds to the fee recipient under any digest; nothing else moves.
        require(
            vault.freeBalance() == 0 && vault.accruedFees() == 600e6 && vault.totalServiceFees() == 600e6, "charged"
        );
        require(vault.reservedPrincipal() == 392e6 && vault.reservedFees() == 8e6, "reserve untouched");
        require(conservationHolds(), "conservation");
    }

    function test_sound_factoryDuplicateAndCreate2() public {
        vm.prank(REGISTRAR);
        vm.expectRevert(ProjectEscrow.DuplicateAward.selector);
        factory.create(PROJECT, ATTACKER, ATTACKER);
        vm.prank(ATTACKER);
        vm.expectRevert(ProjectEscrow.Unauthorized.selector);
        factory.create(keccak256("other"), ATTACKER, ATTACKER);
        // Second factory, same project id, different vault address, different award ids.
        vm.prank(REGISTRAR);
        EscrowFactory f2 = new EscrowFactory(IERC20(address(usdc)), FEE, AUTHORITY, DELAY);
        vm.prank(REGISTRAR);
        ProjectEscrow v2 = ProjectEscrow(f2.create(PROJECT, OWNER, OWNER));
        require(address(v2) != address(vault), "distinct");
        require(v2.awardId(keccak256("x")) != vault.awardId(keccak256("x")), "ids differ");
    }

    function test_sound_constructorGuards() public {
        vm.prank(REGISTRAR);
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        factory.create(keccak256("g1"), OWNER, ATTACKER); // refund != owner
        vm.prank(REGISTRAR);
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        factory.create(keccak256("g2"), AUTHORITY, AUTHORITY); // owner == authority
        vm.prank(REGISTRAR);
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        factory.create(bytes32(0), OWNER, OWNER);
    }

    function test_sound_bindRejectsVaultAndExpired() public {
        vm.prank(AUTHORITY);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.bindDestination(1, address(vault), 0, keccak256("c"), uint64(block.timestamp));
        vm.prank(AUTHORITY);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.bindDestination(1, CONTRIBUTOR, 0, keccak256("c"), uint64(block.timestamp - 1));
        vm.prank(AUTHORITY);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.bindDestination(1, CONTRIBUTOR, 1, keccak256("c"), uint64(block.timestamp)); // wrong expected version
    }

    function test_sound_blockedDestinationLeavesReserve() public {
        depositAs(1_000e6);
        bytes32 id = commit(keccak256("src-b"), 31, 100e6);
        bind(31, CONTRIBUTOR, 0);
        vm.warp(block.timestamp + DELAY);
        usdc.blockAddress(CONTRIBUTOR);
        vm.expectRevert(); // token revert propagates as TransferFailed via callToken
        vault.pay(id, 1);
        (,,,, bool paidB) = vault.awards(id);
        require(vault.reservedPrincipal() == 98e6 && !paidB, "reserve intact");
        usdc.blockAddress(FEE);
        vm.prank(OWNER);
        vault.withdrawUnused(100e6); // refunds continue while fee recipient blocked
        vm.expectRevert(ProjectEscrow.TransferFailed.selector);
        vault.claimFees();
    }
}

/// @dev Non-standard token return data: nothing returned, 32-byte true, 64 bytes, non-bool word.
contract OddToken {
    uint8 public mode; // 0 = returns nothing, 1 = returns 64 bytes, 2 = returns word 2
    mapping(address => uint256) public balanceOf;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emitReturn();
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emitReturn();
    }

    function emitReturn() private view {
        uint8 m = mode;
        assembly {
            switch m
            case 0 { return(0, 0) }
            case 1 {
                mstore(0, 1)
                mstore(32, 1)
                return(0, 64)
            }
            case 2 {
                mstore(0, 2)
                return(0, 32)
            }
        }
    }
}

contract FableOddTokenTest is FableBase {
    OddToken internal odd;
    ProjectEscrow internal oddVault;

    function setUp() public override {
        vm.warp(1_800_000_000);
        odd = new OddToken();
        vm.prank(REGISTRAR);
        EscrowFactory f = new EscrowFactory(IERC20(address(odd)), FEE, AUTHORITY, DELAY);
        vm.prank(REGISTRAR);
        oddVault = ProjectEscrow(f.create(PROJECT, OWNER, OWNER));
        odd.mint(OWNER, 1_000e6);
    }

    function test_sound_callTokenReturnData() public {
        odd.setMode(0); // no return data: accepted (USDT-style)
        vm.prank(OWNER);
        oddVault.deposit(100e6);
        require(oddVault.freeBalance() == 100e6, "deposited");
        odd.setMode(1); // 64 bytes: rejected
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.TransferFailed.selector);
        oddVault.deposit(1e6);
        odd.setMode(2); // 32-byte word that is not a bool: abi.decode reverts (generic revert)
        vm.prank(OWNER);
        vm.expectRevert();
        oddVault.deposit(1e6);
        require(oddVault.freeBalance() == 100e6, "no drift");
    }
}
