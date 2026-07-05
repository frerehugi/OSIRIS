// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {DcaVault} from "../contracts/DcaVault.sol";

/// @notice Deployt den DcaVault auf Celo Sepolia oder Mainnet.
///
/// Der Vault ruft keinen DEX-Router mehr direkt auf (Squid-Architektur) —
/// Router werden nach dem Deploy einzeln per setRouter() freigegeben.
///
/// Ausführung auf Celo Sepolia:
///   forge script script/Deploy.s.sol \
///     --rpc-url celo_sepolia \
///     --broadcast \
///     --verify \
///     -vvvv
///
/// Ausführung auf Celo Mainnet:
///   forge script script/Deploy.s.sol \
///     --rpc-url celo_mainnet \
///     --broadcast \
///     --verify \
///     -vvvv
///
/// Benötigte Umgebungsvariablen (.env):
///   DEPLOYER_PRIVATE_KEY  — Private Key des Deploy-Wallets
///   OWNER_ADDRESS         — Adresse die den Vault kontrolliert (kann = Deployer sein)
///   CELOSCAN_API_KEY      — für automatische Verifikation auf Celoscan

contract DeployDcaVault is Script {

    function run() external {
        require(
            block.chainid == 42220 || block.chainid == 11142220,
            "Nur auf Celo Mainnet (42220) oder Celo Sepolia (11142220) ausfuehren!"
        );

        // Private Key und Owner aus .env laden
        uint256 deployerKey  = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address ownerAddress = vm.envAddress("OWNER_ADDRESS");

        console2.log("=== OSIRIS DcaVault Deploy ===");
        console2.log("Chain ID:         ", block.chainid);
        console2.log("Owner:            ", ownerAddress);

        vm.startBroadcast(deployerKey);

        DcaVault vault = new DcaVault(ownerAddress);

        vm.stopBroadcast();

        console2.log("DcaVault deployed:", address(vault));
        console2.log("");
        console2.log("Naechster Schritt: setRouter() fuer den Squid-Router aufrufen,");
        console2.log("dann VAULT_ADDRESS in src/config.ts eintragen:");
        console2.log(address(vault));
    }
}
