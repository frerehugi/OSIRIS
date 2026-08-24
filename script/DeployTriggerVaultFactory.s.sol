// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {TriggerVault} from "../contracts/TriggerVault.sol";
import {TriggerVaultFactory} from "../contracts/TriggerVaultFactory.sol";

/// @notice Deployt die TriggerVault-Master-Implementation + TriggerVaultFactory
///         (Apis) auf Celo Mainnet. Ersetzt ConditionalSellOrder (siehe Chat:
///         "eigener Vault pro Plan" statt eines geteilten Contracts) — additiv,
///         rührt DcaVault/DcaVaultFactory/den bestehenden OSIRIS-Keeper nicht an.
///
/// Ausführung:
///   forge script script/DeployTriggerVaultFactory.s.sol \
///     --rpc-url celo_mainnet \
///     --broadcast \
///     --verify \
///     -vvvv
///
/// Benötigte Umgebungsvariablen (.env):
///   DEPLOYER_PRIVATE_KEY  — Private Key des Apis-Admin/Deployer-Wallets
///                           (APIS_ADMIN unten) — NICHT das OSIRIS-Deployer-
///                           Wallet, siehe Gesamtplan §17/§20.
///   CELOSCAN_API_KEY      — für automatische Verifikation (bereits vorhanden)

contract DeployTriggerVaultFactory is Script {

    // Quelle: Squid /v2/sdk-info, chains[].squidContracts.squidRouter
    // (chainId 42220) — identisch zu DeployFactory.s.sol/DeploySellOrder.s.sol.
    address constant SQUID_ROUTER_MAINNET = 0xce16F69375520ab01377ce7B88f5BA8C48F8D666;

    // Apis-Keeper-Wallet — separat von OSIRIS' GLOBAL_KEEPER (siehe Gesamtplan
    // §17). Wird bei jedem neuen Vault automatisch als Keeper freigeschaltet
    // und ist zugleich Treasury (siehe TriggerVaultFactory.feeInfo()).
    address constant APIS_KEEPER = 0x1486f1859f0b2b16b525096205cCaE74a681b78c;

    // Apis-Admin/Deployer-Wallet — hält setFee()/setAdmin()-Rechte auf der
    // Factory (siehe Gesamtplan §20).
    address constant APIS_ADMIN = 0x780bD65804a64A03f8d6F0e9b9b1c6bC0cf4d6B9;

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren (Squid unterstuetzt Celo Sepolia nicht)!"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        console2.log("=== Apis TriggerVaultFactory Deploy ===");
        console2.log("Chain ID:      ", block.chainid);
        console2.log("Squid Router:  ", SQUID_ROUTER_MAINNET);
        console2.log("Apis Keeper:   ", APIS_KEEPER);
        console2.log("Apis Admin:    ", APIS_ADMIN);

        vm.startBroadcast(deployerKey);

        TriggerVault implementation = new TriggerVault();
        TriggerVaultFactory factory = new TriggerVaultFactory(
            address(implementation),
            SQUID_ROUTER_MAINNET,
            APIS_KEEPER,
            APIS_ADMIN
        );

        vm.stopBroadcast();

        console2.log("");
        console2.log("TriggerVault Implementation:", address(implementation));
        console2.log("TriggerVaultFactory:        ", address(factory));
        console2.log("");
        console2.log("Naechster Schritt: Adresse in apis/app/src/config.ts eintragen");
        console2.log("(TRIGGER_VAULT_FACTORY_ADDRESS).");
    }
}
