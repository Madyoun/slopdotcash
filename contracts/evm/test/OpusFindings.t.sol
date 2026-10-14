// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./OpusBase.sol";

contract OpusFindingsTest is OpusBase {
    uint64 constant ALICE = 4242;

    function setUp() public {
        deployWithDelay(DELAY);
        fund(10_000e6);
    }

    /// F-1 (fixed, review M-1): a binding placed before the actor has an award no longer pays in the block
    /// the award is committed. The award waits its own bindingDelay, and the owner can cancel the unpaid
    /// binding inside that window.
    function test_F1_preArmedBindingWaitsForCommitDelay() public {
        // Compromised authority pre-binds a future contributor's actor id to the attacker.
        uint64 v = bindAs(ALICE, ATTACKER);
        vm.warp(block.timestamp + DELAY);
        // With no award there is nothing to protect, so the owner has no cancel window yet.
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, v);
        // Weeks later the owner approves Alice's monthly award.
        vm.warp(block.timestamp + 30 days);
        bytes32 id = commit(keccak256("eliza/2026-11/alice"), ALICE, 1_000e6);
        // Same block, the relayer's pay waits for the commit delay.
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.AwardPending.selector);
        escrow.pay(id, v);
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.AwardPending.selector);
        escrow.pay(id, v);
        // The owner reviews the binding attached to the money and cancels it inside the window.
        vm.prank(OWNER);
        escrow.cancelBinding(ALICE, v);
        vm.warp(block.timestamp + 1);
        vm.prank(RELAYER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.pay(id, v);
        check(usdc.balanceOf(ATTACKER) == 0, "attacker received nothing");
        check(escrow.reservedPrincipal() == 980e6, "award still reserved for alice");
    }

    /// F-2 (fixed, review M-2): the owner's cancel is capped at MAX_CANCELS_BETWEEN_PAYMENTS between two
    /// payments to an actor, so the owner can delay the first payment by at most three more delays.
    function test_F2_ownerCancelIsCappedBeforeFirstPayment() public {
        bytes32 id = commit(keccak256("eliza/2026-11/alice"), ALICE, 1_000e6);
        uint64 v;
        for (uint256 i = 0; i < escrow.MAX_CANCELS_BETWEEN_PAYMENTS(); i++) {
            v = bindAs(ALICE, ALICE_WALLET);
            vm.prank(OWNER);
            escrow.cancelBinding(ALICE, v);
            vm.warp(block.timestamp + DELAY + 1);
            vm.prank(RELAYER);
            vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
            escrow.pay(id, v);
        }
        v = bindAs(ALICE, ALICE_WALLET);
        vm.prank(OWNER);
        vm.expectRevert(ProjectEscrow.CancelLimit.selector);
        escrow.cancelBinding(ALICE, v);
        (,,,,, bool paid) = escrow.awards(id);
        check(!paid, "not paid yet");
        vm.warp(block.timestamp + DELAY);
        vm.prank(RELAYER);
        escrow.pay(id, v);
        check(usdc.balanceOf(ALICE_WALLET) == 980e6, "alice paid after the cap");
    }

    /// F-4 (fixed, review L-1): the factory rejects a delay below one hour or above 30 days, so a zero
    /// delay cannot make the cancel unreachable and an oversized delay cannot overflow every binding.
    function test_F4_delayIsBounded() public {
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        new EscrowFactory(IERC20(address(usdc)), FEE, AUTHORITY, 0);
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        new EscrowFactory(IERC20(address(usdc)), FEE, AUTHORITY, 1 hours - 1);
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        new EscrowFactory(IERC20(address(usdc)), FEE, AUTHORITY, 30 days + 1);
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        new EscrowFactory(IERC20(address(usdc)), FEE, AUTHORITY, type(uint64).max - 1_000);
        deployWithDelay(1 hours);
        check(escrow.bindingDelay() == 1 hours, "floor accepted");
        deployWithDelay(30 days);
        check(escrow.bindingDelay() == 30 days, "ceiling accepted");
    }

    /// F-5 (fixed, review L-5): cancelBinding on an already-cancelled binding reverts, so BindingCancelled
    /// is emitted once per version.
    function test_F5_cancelIsNotRepeatable() public {
        uint64 v = bindAs(ALICE, ALICE_WALLET);
        vm.recordLogs();
        vm.startPrank(OWNER);
        escrow.cancelBinding(ALICE, v);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, v);
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        escrow.cancelBinding(ALICE, v);
        vm.stopPrank();
        OpusVmLog[] memory logs = vm.getRecordedLogs();
        check(logs.length == 1, "one BindingCancelled event for one binding");
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
