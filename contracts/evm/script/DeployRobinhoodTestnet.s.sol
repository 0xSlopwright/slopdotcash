// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {EscrowFactory, IERC20} from "../src/ProjectEscrow.sol";
import {TestDollar} from "../integration/TestDollar.sol";

interface DeploymentVm {
    function envAddress(string calldata key) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Test-only deployment on Robinhood Chain Testnet (46630). No USDG exists there, so the script
/// deploys the six-decimal TestDollar and binds the factory to it; the test token is not USDG.
contract DeployRobinhoodTestnet {
    DeploymentVm private constant vm = DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// @dev Policy delay before a new or rotated destination binding can pay.
    uint64 public constant BINDING_DELAY = 48 hours;
    event TestFactoryDeployed(
        address indexed factory, address token, address registrar, address identityAuthority, address feeRecipient
    );

    function run() external returns (EscrowFactory factory, TestDollar token) {
        require(block.chainid == 46630, "Robinhood Chain Testnet only");
        address feeRecipient = vm.envAddress("TEST_FEE_RECIPIENT");
        address identityAuthority = vm.envAddress("TEST_IDENTITY_AUTHORITY");
        vm.startBroadcast();
        token = new TestDollar();
        factory = new EscrowFactory(IERC20(address(token)), feeRecipient, identityAuthority, BINDING_DELAY);
        vm.stopBroadcast();
        emit TestFactoryDeployed(address(factory), address(token), factory.registrar(), identityAuthority, feeRecipient);
    }
}
