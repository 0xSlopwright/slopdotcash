// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {EscrowFactory, IERC20} from "../src/ProjectEscrow.sol";

interface DeploymentVm {
    function envAddress(string calldata key) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Test-only deployment on Robinhood Chain Testnet (46630). Signing comes from Foundry's external
/// signer/account configuration.
contract DeployRobinhoodTestnet {
    DeploymentVm private constant vm = DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// @dev Paxos testnet USDG on Robinhood Chain Testnet, six decimals; equals the registry asset for
    /// robinhood-testnet in src/lib/escrow-policy.mjs (checked by contracts/evm/scripts.test.ts).
    address public constant TEST_USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;
    /// @dev Policy delay before a new or rotated destination binding can pay.
    uint64 public constant BINDING_DELAY = 48 hours;
    event TestFactoryDeployed(
        address indexed factory, address token, address registrar, address identityAuthority, address feeRecipient
    );

    function run() external returns (EscrowFactory factory) {
        require(block.chainid == 46630, "Robinhood Chain Testnet only");
        address feeRecipient = vm.envAddress("TEST_FEE_RECIPIENT");
        address identityAuthority = vm.envAddress("TEST_IDENTITY_AUTHORITY");
        vm.startBroadcast();
        factory = new EscrowFactory(IERC20(TEST_USDG), feeRecipient, identityAuthority, BINDING_DELAY);
        vm.stopBroadcast();
        emit TestFactoryDeployed(address(factory), TEST_USDG, factory.registrar(), identityAuthority, feeRecipient);
    }
}
