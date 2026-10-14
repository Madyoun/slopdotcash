// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @dev Bounds on the binding delay. Below one hour the owner cannot react; above 30 days a binding or a
/// committed award waits too long to be useful.
uint64 constant MIN_BINDING_DELAY = 1 hours;
uint64 constant MAX_BINDING_DELAY = 30 days;

/// @notice Version 3, immutable single-project, single-asset escrow.
/// @dev A binding needs the identity authority's transaction and the destination wallet's EIP-712 signature,
/// so the authority alone cannot point funds at a wallet it does not hold; it cannot change amounts. The
/// authority is read from the factory, which replaces it only through a public 7-day timelock. A new binding waits
/// bindingDelay before it can pay, and an award waits bindingDelay after it is committed, so a stolen
/// authority key cannot pay itself before the sponsor can react, even with a binding placed in advance.
/// Only the latest binding pays: while a newer binding waits out its delay or after the owner cancels it,
/// no payment goes to any earlier wallet, so a rotation away from a compromised wallet freezes payment
/// instead of racing it. The owner can cancel the latest binding only inside those windows, never after it
/// has paid, and at most MAX_CANCELS_BETWEEN_PAYMENTS times between two payments to the actor, so the owner
/// can delay a payout by a bounded number of delays but never retract it. Fees accrue in the vault and are pulled separately, so a blocked fee recipient cannot
/// stop payouts or refunds.
/// Tokens must have exact transfers and six decimals (USDC). No upgrade or reserve rescue exists.
contract ProjectEscrow {
    struct Award {
        uint64 actorId;
        uint64 gross;
        uint64 fee;
        bytes32 sourceDigest;
        uint64 committedAt;
        bool paid;
    }

    /// @dev The latest authority binding for an actor. It is pending until activatesAt and is the only
    /// binding that can pay.
    struct Binding {
        address destination;
        uint64 version;
        bytes32 claimDigest;
        uint64 activatesAt;
        bool cancelled;
    }

    /// @notice Cancels the owner may make for an actor between two payments to that actor. Each cancel can
    /// only delay the actor by one more bindingDelay, so this bounds the owner's delay power.
    uint8 public constant MAX_CANCELS_BETWEEN_PAYMENTS = 3;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant BINDING_TYPEHASH = keccak256(
        "DestinationBinding(uint64 actorId,address destination,uint64 expectedVersion,bytes32 claimDigest,uint64 expiresAt)"
    );
    /// @dev Upper bound on s for a canonical secp256k1 signature (EIP-2).
    bytes32 private constant MAX_S = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    IERC20 public immutable token;
    bytes32 public immutable projectId;
    address public immutable owner;
    address public immutable refundDestination;
    address public immutable feeRecipient;
    /// @notice The factory that created this vault and holds the identity authority in force.
    EscrowFactory public immutable factory;
    uint64 public immutable bindingDelay;
    uint64 public freeBalance;
    uint64 public reservedPrincipal;
    uint64 public reservedFees;
    uint64 public totalDeposited;
    uint64 public totalPaid;
    uint64 public totalPayoutFees;
    uint64 public totalGrossWithdrawn;
    uint64 public totalWithdrawalFees;
    uint64 public accruedFees;
    uint64 public totalServiceFees;
    mapping(bytes32 => Award) public awards;
    mapping(bytes32 => bool) public consumedSources;
    mapping(uint64 => Binding) public bindings;
    /// @notice The binding version the last payment to an actor used; 0 before the first payment.
    mapping(uint64 => uint64) public paidVersion;
    mapping(uint64 => uint64) public lastCommittedAt;
    /// @notice Cancels recorded for an actor since the actor's last payment.
    mapping(uint64 => uint8) public cancelCount;
    mapping(bytes32 => bool) public chargedInvoices;
    bool private entered;

    error Unauthorized();
    error InvalidInput();
    error InsufficientFreeBalance();
    error DuplicateAward();
    error InvalidBinding();
    error TransferFailed();
    error ReentrantCall();
    error DuplicateInvoice();
    error AwardPending();
    error CancelLimit();
    error InvalidWalletSignature();

    event Deposited(address indexed sponsor, uint256 amount);
    event AwardCommitted(bytes32 indexed id, uint64 indexed actorId, uint64 gross, uint64 fee, bytes32 sourceDigest);
    event DestinationBound(
        uint64 indexed actorId, address indexed destination, uint64 version, bytes32 claimDigest, uint64 activatesAt
    );
    event BindingCancelled(uint64 indexed actorId, uint64 version);
    event FeesClaimed(address indexed feeRecipient, uint256 amount);
    event Paid(
        bytes32 indexed id,
        uint64 indexed actorId,
        address indexed destination,
        uint64 version,
        uint64 gross,
        uint64 net,
        uint64 fee
    );
    event UnusedWithdrawn(address indexed destination, uint256 gross, uint256 net, uint256 fee);
    event ServiceCharged(bytes32 indexed invoiceDigest, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }
    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    /// @dev Only the factory creates vaults: the deployer is the factory, and reading its authority here
    /// reverts for any other deployer.
    constructor(
        bytes32 projectId_,
        IERC20 token_,
        address owner_,
        address refundDestination_,
        address feeRecipient_,
        uint64 bindingDelay_
    ) {
        EscrowFactory factory_ = EscrowFactory(msg.sender);
        address identityAuthority_ = factory_.identityAuthority();
        // Refunds go only to the sponsor that deposited them.
        if (
            projectId_ == bytes32(0) || address(token_).code.length == 0 || token_.decimals() != 6
                || owner_ == address(0) || refundDestination_ != owner_ || feeRecipient_ == address(0)
                || identityAuthority_ == address(0) || owner_ == identityAuthority_ || feeRecipient_ == address(this)
                || bindingDelay_ < MIN_BINDING_DELAY || bindingDelay_ > MAX_BINDING_DELAY
        ) revert InvalidInput();
        projectId = projectId_;
        token = token_;
        owner = owner_;
        refundDestination = refundDestination_;
        feeRecipient = feeRecipient_;
        factory = factory_;
        bindingDelay = bindingDelay_;
    }

    /// @notice The identity authority in force, held and rotated by the factory.
    function identityAuthority() public view returns (address) {
        return factory.identityAuthority();
    }

    /// @notice EIP-712 domain: the chain and this vault, so a wallet signature cannot be replayed elsewhere.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("SlopProjectEscrow"), keccak256("3"), block.chainid, address(this))
        );
    }

    /// @notice The digest the destination wallet signs to accept a binding. Every field must match the
    /// authority's call exactly.
    function bindingDigest(
        uint64 actorId,
        address destination,
        uint64 expectedVersion,
        bytes32 claimDigest,
        uint64 expiresAt
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(),
                keccak256(abi.encode(BINDING_TYPEHASH, actorId, destination, expectedVersion, claimDigest, expiresAt))
            )
        );
    }

    /// @dev Externally owned accounts only: a 65-byte canonical secp256k1 signature that recovers to the
    /// destination. A contract wallet cannot produce one and so cannot be bound in this version.
    function walletSigned(bytes32 digest, address destination, bytes calldata signature) private pure returns (bool) {
        if (signature.length != 65) return false;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (s > MAX_S || (v != 27 && v != 28)) return false;
        address signer = ecrecover(digest, v, r, s);
        return signer != address(0) && signer == destination;
    }

    /// @notice The only valid award ID for a source. Binding the chain and vault stops another vault from
    /// claiming the same ID first.
    function awardId(bytes32 sourceDigest) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), sourceDigest));
    }

    function payoutFee(uint64 gross) public pure returns (uint64) {
        return gross / 50;
    }

    /// @notice Only the declared sponsor deposits; direct donations do not grant refund rights.
    function deposit(uint64 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidInput();
        uint256 beforeBalance = token.balanceOf(address(this));
        callToken(abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert TransferFailed();
        freeBalance += amount;
        totalDeposited += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @param sourceDigest Unique per award origin (project/cycle/actor/allocation), not a whole-cycle digest.
    function commitAward(bytes32 id, uint64 actorId, uint64 gross, bytes32 sourceDigest) external onlyOwner {
        if (actorId == 0 || gross == 0 || sourceDigest == bytes32(0) || id != awardId(sourceDigest)) {
            revert InvalidInput();
        }
        if (awards[id].actorId != 0 || consumedSources[sourceDigest]) revert DuplicateAward();
        uint64 fee = payoutFee(gross);
        if (gross > freeBalance) revert InsufficientFreeBalance();
        freeBalance -= gross;
        reservedPrincipal += gross - fee;
        reservedFees += fee;
        uint64 committedAt = uint64(block.timestamp);
        awards[id] = Award(actorId, gross, fee, sourceDigest, committedAt, false);
        lastCommittedAt[actorId] = committedAt;
        consumedSources[sourceDigest] = true;
        emit AwardCommitted(id, actorId, gross, fee, sourceDigest);
    }

    /// @notice Direct authority transaction plus the destination wallet's EIP-712 signature over the same
    /// fields; chain ID and target contract bind both. The service must verify the GitHub actor before
    /// signing; the wallet signature proves the destination accepts the binding. Expiry limits submission
    /// of both signatures, not claim lifetime. expectedVersion prevents stale or reordered wallet updates.
    function bindDestination(
        uint64 actorId,
        address destination,
        uint64 expectedVersion,
        bytes32 claimDigest,
        uint64 expiresAt,
        bytes calldata walletSignature
    ) external {
        if (msg.sender != factory.identityAuthority()) revert Unauthorized();
        if (
            actorId == 0 || destination == address(0) || destination == address(this) || claimDigest == bytes32(0)
                || expiresAt < block.timestamp || bindings[actorId].version != expectedVersion
        ) revert InvalidBinding();
        if (!walletSigned(
                bindingDigest(actorId, destination, expectedVersion, claimDigest, expiresAt),
                destination,
                walletSignature
            )) {
            revert InvalidWalletSignature();
        }
        uint64 version = expectedVersion + 1;
        uint64 activatesAt = uint64(block.timestamp) + bindingDelay;
        bindings[actorId] = Binding(destination, version, claimDigest, activatesAt, false);
        emit DestinationBound(actorId, destination, version, claimDigest, activatesAt);
    }

    /// @notice The sponsor can stop the latest binding before it pays: while it waits out its own delay, or
    /// while an award committed to the actor is still inside its commit delay. A binding that has paid
    /// cannot be cancelled, and the owner can cancel at most MAX_CANCELS_BETWEEN_PAYMENTS times between two
    /// payments to the actor. Only a new authority binding can follow a cancel; no payment goes out until it
    /// is ready.
    function cancelBinding(uint64 actorId, uint64 expectedVersion) external onlyOwner {
        Binding storage binding = bindings[actorId];
        if (
            binding.version == 0 || binding.version != expectedVersion || binding.cancelled
                || binding.version == paidVersion[actorId]
        ) revert InvalidBinding();
        uint64 committedAt = lastCommittedAt[actorId];
        bool pending = block.timestamp < binding.activatesAt;
        bool commitWindow = committedAt != 0 && block.timestamp < committedAt + bindingDelay;
        if (!pending && !commitWindow) revert InvalidBinding();
        if (cancelCount[actorId] >= MAX_CANCELS_BETWEEN_PAYMENTS) revert CancelLimit();
        cancelCount[actorId] += 1;
        binding.cancelled = true;
        emit BindingCancelled(actorId, expectedVersion);
    }

    /// @notice The binding a payment to this actor would use now: the latest binding once its delay has
    /// passed and it is not cancelled. Version 0 means no binding can pay; an earlier binding never pays.
    function payableBinding(uint64 actorId) public view returns (address destination, uint64 version) {
        Binding storage binding = bindings[actorId];
        if (binding.version != 0 && !binding.cancelled && block.timestamp >= binding.activatesAt) {
            return (binding.destination, binding.version);
        }
        return (address(0), 0);
    }

    /// @notice Pays an award to its actor's payable binding once both the binding delay and the award's
    /// commit delay have passed. Anyone can call it, because the destination is fixed by the contract.
    function pay(bytes32 id, uint64 expectedBindingVersion) external nonReentrant {
        Award storage award = awards[id];
        if (award.actorId == 0 || award.paid) revert InvalidInput();
        if (block.timestamp < award.committedAt + bindingDelay) revert AwardPending();
        (address destination, uint64 version) = payableBinding(award.actorId);
        if (version == 0 || version != expectedBindingVersion) revert InvalidBinding();
        paidVersion[award.actorId] = version;
        cancelCount[award.actorId] = 0;
        uint64 net = award.gross - award.fee;
        award.paid = true;
        reservedPrincipal -= net;
        reservedFees -= award.fee;
        totalPaid += net;
        totalPayoutFees += award.fee;
        accruedFees += award.fee;
        sendExact(destination, net);
        emit Paid(id, award.actorId, destination, version, award.gross, net, award.fee);
    }

    /// @notice 10% of cumulative gross withdrawals, rounded down. Splitting cannot reduce fees.
    function withdrawUnused(uint64 gross) external onlyOwner nonReentrant {
        if (gross == 0) revert InvalidInput();
        if (gross > freeBalance) revert InsufficientFreeBalance();
        uint64 cumulative = totalGrossWithdrawn + gross;
        uint64 nextFee = cumulative / 10;
        uint64 fee = nextFee - totalWithdrawalFees;
        freeBalance -= gross;
        totalGrossWithdrawn = cumulative;
        totalWithdrawalFees = nextFee;
        accruedFees += fee;
        sendExact(refundDestination, gross - fee);
        emit UnusedWithdrawn(refundDestination, gross, gross - fee, fee);
    }

    /// @notice PAY-10: the owner pays one Slopbot invoice from free sponsor funds, exactly once per digest.
    /// The charge accrues for the fee recipient like other fees; reserved awards are never touched.
    function chargeService(uint64 amount, bytes32 invoiceDigest) external onlyOwner nonReentrant {
        if (amount == 0 || invoiceDigest == bytes32(0)) revert InvalidInput();
        if (chargedInvoices[invoiceDigest]) revert DuplicateInvoice();
        if (amount > freeBalance) revert InsufficientFreeBalance();
        chargedInvoices[invoiceDigest] = true;
        freeBalance -= amount;
        totalServiceFees += amount;
        accruedFees += amount;
        emit ServiceCharged(invoiceDigest, amount);
    }

    /// @notice Anyone can move accrued fees to the fee recipient. Only this call depends on that address.
    function claimFees() external nonReentrant {
        uint64 amount = accruedFees;
        if (amount == 0) revert InvalidInput();
        accruedFees = 0;
        sendExact(feeRecipient, amount);
        emit FeesClaimed(feeRecipient, amount);
    }

    function sendExact(address destination, uint256 amount) private {
        if (amount == 0) return;
        uint256 beforeVault = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(destination);
        callToken(abi.encodeCall(IERC20.transfer, (destination, amount)));
        if (
            token.balanceOf(address(this)) != beforeVault - amount
                || token.balanceOf(destination) != beforeRecipient + amount
        ) revert TransferFailed();
    }

    function callToken(bytes memory data) private {
        (bool ok, bytes memory result) = address(token).call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TransferFailed();
        }
    }
}

/// @notice One vault per immutable project ID in this version of the deployment registry.
/// The registrar is a disclosed project-registration trust boundary, not a money authority. It also holds
/// the only mutable authority: the identity authority every vault reads, replaced through a public 7-day
/// timelock that the registrar proposes and may cancel, and that the current authority cannot block.
contract EscrowFactory {
    uint64 public constant AUTHORITY_ROTATION_DELAY = 7 days;
    address public immutable registrar;
    IERC20 public immutable token;
    address public immutable feeRecipient;
    uint64 public immutable bindingDelay;
    address public identityAuthority;
    address public pendingIdentityAuthority;
    uint64 public identityAuthorityEffectiveAt;
    mapping(bytes32 => address) public vaults;

    error RotationPending();
    error NoRotationPending();
    error RotationNotReady();

    event VaultCreated(
        bytes32 indexed projectId, address indexed vault, address indexed owner, address refundDestination
    );
    event IdentityAuthorityRotationProposed(address indexed current, address indexed proposed, uint64 effectiveAt);
    event IdentityAuthorityRotationCancelled(address indexed proposed);
    event IdentityAuthorityRotated(address indexed previous, address indexed current);

    modifier onlyRegistrar() {
        if (msg.sender != registrar) revert ProjectEscrow.Unauthorized();
        _;
    }

    constructor(IERC20 token_, address feeRecipient_, address identityAuthority_, uint64 bindingDelay_) {
        if (
            address(token_).code.length == 0 || token_.decimals() != 6 || feeRecipient_ == address(0)
                || identityAuthority_ == address(0) || identityAuthority_ == msg.sender
                || bindingDelay_ < MIN_BINDING_DELAY || bindingDelay_ > MAX_BINDING_DELAY
        ) revert ProjectEscrow.InvalidInput();
        registrar = msg.sender;
        token = token_;
        feeRecipient = feeRecipient_;
        identityAuthority = identityAuthority_;
        bindingDelay = bindingDelay_;
    }

    function create(bytes32 projectId, address owner, address refundDestination)
        external
        onlyRegistrar
        returns (address vault)
    {
        if (vaults[projectId] != address(0)) revert ProjectEscrow.DuplicateAward();
        vault = address(
            new ProjectEscrow{salt: projectId}(projectId, token, owner, refundDestination, feeRecipient, bindingDelay)
        );
        vaults[projectId] = vault;
        emit VaultCreated(projectId, vault, owner, refundDestination);
    }

    /// @notice Starts the public notice period for a replacement identity authority. One proposal at a time.
    function proposeIdentityAuthority(address next) external onlyRegistrar {
        if (next == address(0) || next == identityAuthority || next == registrar) revert ProjectEscrow.InvalidInput();
        if (pendingIdentityAuthority != address(0)) revert RotationPending();
        uint64 effectiveAt = uint64(block.timestamp) + AUTHORITY_ROTATION_DELAY;
        pendingIdentityAuthority = next;
        identityAuthorityEffectiveAt = effectiveAt;
        emit IdentityAuthorityRotationProposed(identityAuthority, next, effectiveAt);
    }

    /// @notice The registrar withdraws its own pending proposal; nobody else can.
    function cancelIdentityAuthorityRotation() external onlyRegistrar {
        address proposed = pendingIdentityAuthority;
        if (proposed == address(0)) revert NoRotationPending();
        delete pendingIdentityAuthority;
        delete identityAuthorityEffectiveAt;
        emit IdentityAuthorityRotationCancelled(proposed);
    }

    /// @notice Anyone may execute a proposal once its notice period has passed. Bindings never reference
    /// the authority, so every existing binding stays valid; only who may bind next changes.
    function executeIdentityAuthorityRotation() external {
        address next = pendingIdentityAuthority;
        if (next == address(0)) revert NoRotationPending();
        if (block.timestamp < identityAuthorityEffectiveAt) revert RotationNotReady();
        address previous = identityAuthority;
        identityAuthority = next;
        delete pendingIdentityAuthority;
        delete identityAuthorityEffectiveAt;
        emit IdentityAuthorityRotated(previous, next);
    }
}
