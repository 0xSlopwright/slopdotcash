// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {EscrowFactory} from "../src/ProjectEscrow.sol";

interface DeploymentVm {
    function envAddress(string calldata key) external returns (address);
    function envOr(string calldata key, address defaultValue) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Shared factory deployment. Signing comes from Foundry's external signer/account configuration; the
/// signer only pays gas and holds no role. The factory serves every standard ERC-20 on its chain, so no token is
/// fixed here. The registrar, fee recipient and identity authority are repository-owner decisions recorded at
/// deployment and read from the environment as public addresses:
///   ESCROW_REGISTRAR, ESCROW_FEE_RECIPIENT, ESCROW_IDENTITY_AUTHORITY.
/// Each is required, except that Base mainnet uses Slop's published Base fee recipient when
/// ESCROW_FEE_RECIPIENT is not set.
abstract contract DeployEscrowFactory {
    DeploymentVm internal constant vm = DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// @dev Production delay before a new or rotated destination binding can pay; also used on testnets so a
    /// rehearsal measures the real delay.
    uint64 public constant BINDING_DELAY = 48 hours;
    /// @dev Slop's published Base platform-fee recipient (src/lib/fresh-cycle-policy.mjs). Default on Base only.
    address public constant BASE_PUBLISHED_FEE_RECIPIENT = 0x8f77C37D8650776bFe73c9b12B15209eE15D9b86;

    event FactoryDeployed(
        uint256 indexed chainId,
        address indexed factory,
        address registrar,
        address identityAuthority,
        address feeRecipient,
        uint64 bindingDelay
    );

    function deploy(uint256 chainId, bool baseFeeDefault) internal returns (EscrowFactory factory) {
        require(block.chainid == chainId, "wrong chain");
        address registrar = vm.envAddress("ESCROW_REGISTRAR");
        address identityAuthority = vm.envAddress("ESCROW_IDENTITY_AUTHORITY");
        address feeRecipient = baseFeeDefault
            ? vm.envOr("ESCROW_FEE_RECIPIENT", BASE_PUBLISHED_FEE_RECIPIENT)
            : vm.envAddress("ESCROW_FEE_RECIPIENT");
        vm.startBroadcast();
        factory = new EscrowFactory(registrar, feeRecipient, identityAuthority, BINDING_DELAY);
        vm.stopBroadcast();
        emit FactoryDeployed(chainId, address(factory), registrar, identityAuthority, feeRecipient, BINDING_DELAY);
    }
}
