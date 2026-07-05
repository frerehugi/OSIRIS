// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {DcaVault} from "../contracts/DcaVault.sol";

/// @notice Deployt den DcaVault auf Celo Sepolia oder Mainnet.
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

    // ─── Uniswap V4 UniversalRouter Adressen ─────────────────────────────────
    // Quelle: docs.celo.org/tooling/contracts/uniswap-contracts

    address constant UNIVERSAL_ROUTER_SEPOLIA =
        0x8891A0A682cC7f0bda7912E79C80167403d96103;

    address constant UNIVERSAL_ROUTER_MAINNET =
        0xcb695bc5D3Aa22cAD1E6DF07801b061a05A0233A;

    function run() external {
        require(
            block.chainid == 42220 || block.chainid == 11142220,
            "Nur auf Celo Mainnet (42220) oder Celo Sepolia (11142220) ausfuehren!"
        );

        // Private Key und Owner aus .env laden
        uint256 deployerKey  = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address ownerAddress = vm.envAddress("OWNER_ADDRESS");

        // Router je nach Chain-ID wählen
        address router = block.chainid == 42220
            ? UNIVERSAL_ROUTER_MAINNET
            : UNIVERSAL_ROUTER_SEPOLIA;

        console2.log("=== OSIRIS DcaVault Deploy ===");
        console2.log("Chain ID:         ", block.chainid);
        console2.log("UniversalRouter:  ", router);
        console2.log("Owner:            ", ownerAddress);

        vm.startBroadcast(deployerKey);

        DcaVault vault = new DcaVault(router, ownerAddress);

        vm.stopBroadcast();

        console2.log("DcaVault deployed:", address(vault));
        console2.log("");
        console2.log("Naechster Schritt: VAULT_ADDRESS in src/config.ts eintragen:");
        console2.log(address(vault));
    }
}
