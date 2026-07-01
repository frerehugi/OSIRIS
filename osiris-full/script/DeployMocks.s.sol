// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/// @notice Deployt Mock-ERC20-Token für wBTC und XAUoT auf Celo Sepolia.
/// @dev    Nur für Testnetz! Nicht auf Mainnet ausführen.
///
/// Ausführung:
///   forge script script/DeployMocks.s.sol \
///     --rpc-url celo_sepolia \
///     --broadcast \
///     -vvvv

contract DeployMocks is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner       = vm.envAddress("OWNER_ADDRESS");

        require(block.chainid == 11142220, "Nur auf Celo Sepolia ausfuehren!");

        vm.startBroadcast(deployerKey);

        MockERC20 mockWBTC  = new MockERC20("Wrapped Bitcoin (Mock)", "wBTC",  8);
        MockERC20 mockXAUoT = new MockERC20("Gold Token (Mock)",      "XAUoT", 6);

        // Initiales Mint für Tests
        mockWBTC.mint(owner,  1e8);    // 1 wBTC
        mockXAUoT.mint(owner, 1000e6); // 1000 XAUoT

        vm.stopBroadcast();

        console2.log("=== Mock Token Deployment ===");
        console2.log("wBTC  (Mock):", address(mockWBTC));
        console2.log("XAUoT (Mock):", address(mockXAUoT));
        console2.log("");
        console2.log("Naechster Schritt: Adressen in src/config.ts eintragen.");
    }
}
