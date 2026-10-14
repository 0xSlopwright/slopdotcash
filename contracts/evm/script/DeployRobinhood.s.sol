// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {EscrowFactory, IERC20} from "../src/ProjectEscrow.sol";

interface DeploymentVm {
    function envAddress(string calldata key) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Robinhood Chain mainnet deployment. Signing comes from Foundry's external signer/account configuration.
/// The fee recipient and identity authority are repository-owner decisions recorded at deployment, so both
/// are read from the environment as public addresses; nothing here fixes them.
contract DeployRobinhood {
    DeploymentVm private constant vm = DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// @dev Paxos Global Dollar (USDG) on Robinhood Chain, six decimals; equals the registry asset for
    /// robinhood-mainnet in src/lib/escrow-policy.mjs (checked by contracts/evm/scripts.test.ts).
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev Production delay before a new or rotated destination binding can pay.
    uint64 public constant BINDING_DELAY = 48 hours;
    event FactoryDeployed(
        address indexed factory, address token, address registrar, address identityAuthority, address feeRecipient
    );

    function run() external returns (EscrowFactory factory) {
        require(block.chainid == 4663, "Robinhood Chain mainnet only");
        address feeRecipient = vm.envAddress("ROBINHOOD_FEE_RECIPIENT");
        address identityAuthority = vm.envAddress("ROBINHOOD_IDENTITY_AUTHORITY");
        vm.startBroadcast();
        factory = new EscrowFactory(IERC20(USDG), feeRecipient, identityAuthority, BINDING_DELAY);
        vm.stopBroadcast();
        emit FactoryDeployed(address(factory), USDG, factory.registrar(), identityAuthority, feeRecipient);
    }
}
