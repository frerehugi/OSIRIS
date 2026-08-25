// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {TriggerVault} from "../contracts/TriggerVault.sol";
import {TriggerVaultFactory} from "../contracts/TriggerVaultFactory.sol";

/// @notice Deployt die TriggerVault-Master-Implementation + TriggerVaultFactory
///         auf Celo Mainnet — OSIRIS' Price-Trigger-Erweiterung neben dem
///         bestehenden DcaVault/DcaVaultFactory. Additiv, rührt DcaVault/
///         DcaVaultFactory nicht an.
///
/// Ausführung:
///   forge script script/DeployTriggerVaultFactory.s.sol \
///     --rpc-url celo_mainnet \
///     --broadcast \
///     --verify \
///     -vvvv
///
/// Benötigte Umgebungsvariablen (.env):
///   DEPLOYER_PRIVATE_KEY  — Private Key des Deploy-Wallets (ADMIN unten)
///   CELOSCAN_API_KEY      — für automatische Verifikation auf Celoscan

contract DeployTriggerVaultFactory is Script {

    // Quelle: Squid /v2/sdk-info, chains[].squidContracts.squidRouter
    // (chainId 42220) — identisch zu DeployFactory.s.sol.
    address constant SQUID_ROUTER_MAINNET = 0xce16F69375520ab01377ce7B88f5BA8C48F8D666;

    // Derselbe globale Keeper-Bot wie DcaVaultFactory (siehe
    // .github/workflows/keeper.yml / keeper/squidKeeper.ts) — wird bei jedem
    // neuen TriggerVault automatisch freigeschaltet und ist zugleich Treasury
    // (siehe TriggerVaultFactory.feeInfo()).
    address constant GLOBAL_KEEPER = 0x02069c8AfceC69622c0F1C5316735042A86BC6fA;

    // Derselbe Admin wie DcaVaultFactory — hält setFee()/setAdmin()-Rechte.
    address constant ADMIN = 0xDbcB531c0a794c43CbE861ca147bE7e8A83Bb523;

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren (Squid unterstuetzt Celo Sepolia nicht)!"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        console2.log("=== OSIRIS TriggerVaultFactory Deploy ===");
        console2.log("Chain ID:      ", block.chainid);
        console2.log("Squid Router:  ", SQUID_ROUTER_MAINNET);
        console2.log("Global Keeper: ", GLOBAL_KEEPER);
        console2.log("Admin:         ", ADMIN);

        vm.startBroadcast(deployerKey);

        TriggerVault implementation = new TriggerVault();
        TriggerVaultFactory factory = new TriggerVaultFactory(
            address(implementation),
            SQUID_ROUTER_MAINNET,
            GLOBAL_KEEPER,
            ADMIN
        );

        vm.stopBroadcast();

        console2.log("");
        console2.log("TriggerVault Implementation:", address(implementation));
        console2.log("TriggerVaultFactory:        ", address(factory));
        console2.log("");
        console2.log("Naechster Schritt: Adresse in src/config.ts eintragen");
        console2.log("(TRIGGER_VAULT_FACTORY_ADDRESS).");
    }
}
