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

/// @notice Version 4, immutable single-project, single-asset escrow for any standard ERC-20.
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
/// Anyone may deposit; deposits join one free balance that only the owner commits or refunds to its refund
/// destination. Payout and unused-fund withdrawal fees are both 2% (floor(gross / 50)). Tokens must have exact
/// transfers: a fee-on-transfer deposit or payout reverts. Decimals are stored for display only; amounts are
/// token base units. No upgrade or reserve rescue exists.
contract ProjectEscrow {
    struct Award {
        uint64 actorId;
        uint128 gross;
        uint128 fee;
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
    /// @notice The token's decimals at vault creation, for display only. The vault never scales amounts.
    uint8 public immutable decimals;
    bytes32 public immutable projectId;
    address public immutable owner;
    address public immutable refundDestination;
    address public immutable feeRecipient;
    /// @notice The factory that created this vault and holds the identity authority in force.
    EscrowFactory public immutable factory;
    uint64 public immutable bindingDelay;
    uint128 public freeBalance;
    uint128 public reservedPrincipal;
    uint128 public reservedFees;
    uint128 public totalDeposited;
    uint128 public totalPaid;
    uint128 public totalPayoutFees;
    uint128 public totalGrossWithdrawn;
    uint128 public totalWithdrawalFees;
    uint128 public accruedFees;
    uint128 public totalServiceFees;
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

    event Deposited(address indexed depositor, uint128 amount);
    event AwardCommitted(bytes32 indexed id, uint64 indexed actorId, uint128 gross, uint128 fee, bytes32 sourceDigest);
    event DestinationBound(
        uint64 indexed actorId, address indexed destination, uint64 version, bytes32 claimDigest, uint64 activatesAt
    );
    event BindingCancelled(uint64 indexed actorId, uint64 version);
    event FeesClaimed(address indexed feeRecipient, uint128 amount);
    event Paid(
        bytes32 indexed id,
        uint64 indexed actorId,
        address indexed destination,
        uint64 version,
        uint128 gross,
        uint128 net,
        uint128 fee
    );
    event UnusedWithdrawn(address indexed destination, uint128 gross, uint128 net, uint128 fee);
    event ServiceCharged(bytes32 indexed invoiceDigest, uint128 amount);

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
        // Free funds are refunded only to the owner, whoever deposited them.
        if (
            projectId_ == bytes32(0) || address(token_).code.length == 0 || owner_ == address(0)
                || owner_ == address(this) || refundDestination_ != owner_ || feeRecipient_ == address(0)
                || identityAuthority_ == address(0) || owner_ == identityAuthority_ || feeRecipient_ == address(this)
                || bindingDelay_ < MIN_BINDING_DELAY || bindingDelay_ > MAX_BINDING_DELAY
        ) revert InvalidInput();
        projectId = projectId_;
        token = token_;
        decimals = readDecimals(token_);
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
            abi.encode(DOMAIN_TYPEHASH, keccak256("SlopProjectEscrow"), keccak256("4"), block.chainid, address(this))
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

    /// @notice The 2% fee on a payout or on cumulative unused-fund withdrawals, rounded down.
    function payoutFee(uint128 gross) public pure returns (uint128) {
        return gross / 50;
    }

    /// @notice Every counter in one call, so a reader gets one consistent block. Equal to the public getters.
    function totals()
        external
        view
        returns (
            uint128 deposited,
            uint128 paid,
            uint128 payoutFees,
            uint128 grossWithdrawn,
            uint128 withdrawalFees,
            uint128 serviceFees,
            uint128 free,
            uint128 principalReserved,
            uint128 feesReserved,
            uint128 feesAccrued,
            uint256 balance
        )
    {
        return (
            totalDeposited,
            totalPaid,
            totalPayoutFees,
            totalGrossWithdrawn,
            totalWithdrawalFees,
            totalServiceFees,
            freeBalance,
            reservedPrincipal,
            reservedFees,
            accruedFees,
            token.balanceOf(address(this))
        );
    }

    /// @notice Anyone may deposit. The amount joins the free balance, which only the owner can commit to awards
    /// or refund to its refund destination; a depositor gets no refund right. Direct transfers are not credited.
    function deposit(uint128 amount) external nonReentrant {
        if (amount == 0) revert InvalidInput();
        uint256 beforeBalance = token.balanceOf(address(this));
        callToken(abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert TransferFailed();
        freeBalance += amount;
        totalDeposited += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @param sourceDigest Unique per award origin (project/cycle/actor/allocation), not a whole-cycle digest.
    function commitAward(bytes32 id, uint64 actorId, uint128 gross, bytes32 sourceDigest) external onlyOwner {
        if (actorId == 0 || gross == 0 || sourceDigest == bytes32(0) || id != awardId(sourceDigest)) {
            revert InvalidInput();
        }
        if (awards[id].actorId != 0 || consumedSources[sourceDigest]) revert DuplicateAward();
        uint128 fee = payoutFee(gross);
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
        uint128 net = award.gross - award.fee;
        award.paid = true;
        reservedPrincipal -= net;
        reservedFees -= award.fee;
        totalPaid += net;
        totalPayoutFees += award.fee;
        accruedFees += award.fee;
        sendExact(destination, net);
        emit Paid(id, award.actorId, destination, version, award.gross, net, award.fee);
    }

    /// @notice 2% of cumulative gross withdrawals (payoutFee), rounded down. Splitting cannot reduce fees.
    function withdrawUnused(uint128 gross) external onlyOwner nonReentrant {
        if (gross == 0) revert InvalidInput();
        if (gross > freeBalance) revert InsufficientFreeBalance();
        uint128 cumulative = totalGrossWithdrawn + gross;
        uint128 nextFee = payoutFee(cumulative);
        uint128 fee = nextFee - totalWithdrawalFees;
        freeBalance -= gross;
        totalGrossWithdrawn = cumulative;
        totalWithdrawalFees = nextFee;
        accruedFees += fee;
        sendExact(refundDestination, gross - fee);
        emit UnusedWithdrawn(refundDestination, gross, gross - fee, fee);
    }

    /// @notice PAY-10: the owner pays one Slopbot invoice from free sponsor funds, exactly once per digest.
    /// The charge accrues for the fee recipient like other fees; reserved awards are never touched.
    function chargeService(uint128 amount, bytes32 invoiceDigest) external onlyOwner nonReentrant {
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
        uint128 amount = accruedFees;
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

    /// @dev decimals() is optional in ERC-20 but every supported asset has it; a token without it is rejected.
    function readDecimals(IERC20 token_) private view returns (uint8) {
        (bool ok, bytes memory result) = address(token_).staticcall(abi.encodeCall(IERC20.decimals, ()));
        if (!ok || result.length != 32) revert InvalidInput();
        uint256 value = abi.decode(result, (uint256));
        if (value > type(uint8).max) revert InvalidInput();
        return uint8(value);
    }

    function callToken(bytes memory data) private {
        (bool ok, bytes memory result) = address(token).call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TransferFailed();
        }
    }
}

/// @notice One vault per (project ID, token) in this deployment. The token is a per-vault parameter, so one
/// factory serves every standard ERC-20 on its chain.
/// The registrar is a disclosed project-registration trust boundary, not a money authority. It also holds
/// the only mutable authority: the identity authority every vault reads, replaced through a public 7-day
/// timelock that the registrar proposes and may cancel, and that the current authority cannot block.
/// The registrar, fee recipient and identity authority are explicit constructor parameters.
contract EscrowFactory {
    uint64 public constant AUTHORITY_ROTATION_DELAY = 7 days;
    address public immutable registrar;
    address public immutable feeRecipient;
    uint64 public immutable bindingDelay;
    address public identityAuthority;
    address public pendingIdentityAuthority;
    uint64 public identityAuthorityEffectiveAt;
    mapping(bytes32 => mapping(address => address)) public vaults;

    error RotationPending();
    error NoRotationPending();
    error RotationNotReady();
    error DuplicateVault();

    event VaultCreated(
        bytes32 indexed projectId,
        address indexed token,
        address indexed vault,
        address owner,
        address refundDestination,
        uint8 decimals
    );
    event IdentityAuthorityRotationProposed(address indexed current, address indexed proposed, uint64 effectiveAt);
    event IdentityAuthorityRotationCancelled(address indexed proposed);
    event IdentityAuthorityRotated(address indexed previous, address indexed current);

    modifier onlyRegistrar() {
        if (msg.sender != registrar) revert ProjectEscrow.Unauthorized();
        _;
    }

    constructor(address registrar_, address feeRecipient_, address identityAuthority_, uint64 bindingDelay_) {
        if (
            registrar_ == address(0) || feeRecipient_ == address(0) || identityAuthority_ == address(0)
                || identityAuthority_ == registrar_ || bindingDelay_ < MIN_BINDING_DELAY
                || bindingDelay_ > MAX_BINDING_DELAY
        ) revert ProjectEscrow.InvalidInput();
        registrar = registrar_;
        feeRecipient = feeRecipient_;
        identityAuthority = identityAuthority_;
        bindingDelay = bindingDelay_;
    }

    /// @notice The CREATE2 salt of the vault for a project and token.
    function vaultSalt(bytes32 projectId, IERC20 token) public pure returns (bytes32) {
        return keccak256(abi.encode(projectId, token));
    }

    function create(bytes32 projectId, IERC20 token, address owner, address refundDestination)
        external
        onlyRegistrar
        returns (address vault)
    {
        if (vaults[projectId][address(token)] != address(0)) revert DuplicateVault();
        ProjectEscrow created = new ProjectEscrow{salt: vaultSalt(projectId, token)}(
            projectId, token, owner, refundDestination, feeRecipient, bindingDelay
        );
        vault = address(created);
        vaults[projectId][address(token)] = vault;
        emit VaultCreated(projectId, address(token), vault, owner, refundDestination, created.decimals());
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
