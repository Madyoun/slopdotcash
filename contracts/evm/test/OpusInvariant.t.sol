// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./OpusBase.sol";

/// Drives random owner / authority / payer / anyone sequences against one vault and tracks ghost totals.
contract OpusHandler {
    OpusVm internal constant vm = OpusVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ProjectEscrow public escrow;
    TestDollar public usdc;
    address public owner;
    address public authority;

    bytes32[] public ids;
    uint64[] public actorOf;
    mapping(bytes32 => bool) public ghostPaid;
    uint256 public ghostClaimed;
    uint256 public ghostDonated;
    uint256 public ghostNetToContributors;
    uint256 public ghostPayCount;
    uint256 public nonce;
    mapping(bytes32 => uint256) public timesPaid;
    // Track that a paid award went to the binding that was active at that instant.
    bool public paidToWrongDestination;
    bool public paidBeforeActivation;

    constructor(ProjectEscrow e, TestDollar t, address o, address a) {
        escrow = e;
        usdc = t;
        owner = o;
        authority = a;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function _actor(uint256 s) internal pure returns (uint64) {
        return uint64(1 + (s % 5));
    }

    function _destKey(uint256 s) internal pure returns (uint256) {
        return OpusWallets.HANDLER_KEY_BASE + (s % 7);
    }

    function _dest(uint256 s) internal pure returns (address) {
        return vm.addr(_destKey(s));
    }

    function deposit(uint256 amount) external {
        amount = 1 + (amount % 50_000e6);
        usdc.mint(owner, amount);
        vm.prank(owner);
        escrow.deposit(uint64(amount));
    }

    function commit(uint256 actorSeed, uint256 gross) external {
        uint64 free = escrow.freeBalance();
        if (free == 0) return;
        gross = 1 + (gross % free);
        bytes32 src = keccak256(abi.encode("src", nonce++));
        bytes32 id = escrow.awardId(src);
        uint64 actor = _actor(actorSeed);
        vm.prank(owner);
        escrow.commitAward(id, actor, uint64(gross), src);
        ids.push(id);
        actorOf.push(actor);
    }

    function bind(uint256 actorSeed, uint256 destSeed) external {
        uint64 actor = _actor(actorSeed);
        (, uint64 v,,,) = escrow.bindings(actor);
        address dest = _dest(destSeed);
        bytes32 claim = keccak256(abi.encode(nonce++));
        uint64 expiresAt = uint64(block.timestamp);
        bytes memory signature = OpusWallets.sign(vm, escrow, _destKey(destSeed), actor, dest, v, claim, expiresAt);
        vm.prank(authority);
        escrow.bindDestination(actor, dest, v, claim, expiresAt, signature);
    }

    function cancel(uint256 actorSeed) external {
        uint64 actor = _actor(actorSeed);
        (, uint64 v,,,) = escrow.bindings(actor);
        vm.prank(owner);
        escrow.cancelBinding(actor, v);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + (dt % 4 days));
    }

    function pay(uint256 idx, address caller) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idx % ids.length];
        (uint64 actor, uint64 gross, uint64 fee,, uint64 committedAt,) = escrow.awards(id);
        (address dest, uint64 v) = escrow.payableBinding(actor);
        (, uint64 latest,, uint64 activatesAt, bool cancelled) = escrow.bindings(actor);
        uint256 before = usdc.balanceOf(dest);
        vm.prank(caller);
        escrow.pay(id, v);
        if (block.timestamp < committedAt + escrow.bindingDelay()) paidBeforeActivation = true;
        if (v == latest && (block.timestamp < activatesAt || cancelled)) paidBeforeActivation = true;
        if (usdc.balanceOf(dest) - before != gross - fee) paidToWrongDestination = true;
        timesPaid[id] += 1;
        ghostNetToContributors += gross - fee;
        ghostPayCount++;
    }

    function payStaleVersion(uint256 idx, uint64 version) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idx % ids.length];
        (uint64 actor,,,,,) = escrow.awards(id);
        (, uint64 v) = escrow.payableBinding(actor);
        if (version == v) return;
        try escrow.pay(id, version) {
            paidToWrongDestination = true; // a non-current version must never pay
        } catch {}
    }

    function withdraw(uint256 gross) external {
        uint64 free = escrow.freeBalance();
        if (free == 0) return;
        gross = 1 + (gross % free);
        vm.prank(owner);
        escrow.withdrawUnused(uint64(gross));
    }

    function charge(uint256 amount) external {
        uint64 free = escrow.freeBalance();
        if (free == 0) return;
        amount = 1 + (amount % free);
        vm.prank(owner);
        escrow.chargeService(uint64(amount), keccak256(abi.encode("inv", nonce++)));
    }

    function claim() external {
        uint64 amt = escrow.accruedFees();
        escrow.claimFees();
        ghostClaimed += amt;
    }

    function donate(uint256 amount) external {
        amount = amount % 1_000e6;
        usdc.mint(address(escrow), amount);
        ghostDonated += amount;
    }
}

contract OpusInvariantTest is OpusBase {
    OpusHandler internal handler;

    function setUp() public {
        deployWithDelay(DELAY);
        handler = new OpusHandler(escrow, usdc, OWNER, AUTHORITY);
    }

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(handler);
    }

    function invariant_supplyIdentity() public view {
        uint256 lhs = escrow.totalDeposited();
        uint256 rhs = uint256(escrow.freeBalance()) + escrow.reservedPrincipal() + escrow.reservedFees()
            + escrow.totalPaid() + escrow.totalPayoutFees() + escrow.totalGrossWithdrawn() + escrow.totalServiceFees();
        require(lhs == rhs, "totalDeposited identity");
    }

    function invariant_balanceIdentity() public view {
        uint256 accounted =
            uint256(escrow.freeBalance()) + escrow.reservedPrincipal() + escrow.reservedFees() + escrow.accruedFees();
        require(usdc.balanceOf(address(escrow)) == accounted + handler.ghostDonated(), "vault balance identity");
    }

    function invariant_feeIdentity() public view {
        require(
            uint256(escrow.accruedFees()) + handler.ghostClaimed()
                == uint256(escrow.totalPayoutFees()) + escrow.totalWithdrawalFees() + escrow.totalServiceFees(),
            "fee identity"
        );
        require(usdc.balanceOf(FEE) == handler.ghostClaimed(), "fee recipient balance");
    }

    function invariant_withdrawalFeeIsTenPercentCumulative() public view {
        require(escrow.totalWithdrawalFees() == escrow.totalGrossWithdrawn() / 10, "withdrawal fee");
    }

    function invariant_paymentsExactOnceAndRouted() public view {
        require(!handler.paidToWrongDestination(), "payment routed wrongly or stale version paid");
        require(!handler.paidBeforeActivation(), "paid before activation");
        require(escrow.totalPaid() == handler.ghostNetToContributors(), "totalPaid tracks contributor receipts");
        uint256 n = handler.idsLength();
        uint256 reservedP;
        uint256 reservedF;
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.ids(i);
            (, uint64 gross, uint64 fee,,, bool paid) = escrow.awards(id);
            require(handler.timesPaid(id) <= 1, "paid twice");
            require(paid == (handler.timesPaid(id) == 1), "paid flag");
            require(fee == gross / 50, "fee formula");
            if (!paid) {
                reservedP += gross - fee;
                reservedF += fee;
            }
        }
        require(reservedP == escrow.reservedPrincipal(), "reservedPrincipal equals unpaid net");
        require(reservedF == escrow.reservedFees(), "reservedFees equals unpaid fees");
    }
}
