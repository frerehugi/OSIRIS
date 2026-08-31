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
/// Benötigte Umgebungsvariablen (.env oder inline):
///   DEPLOYER_PRIVATE_KEY  — Private Key des Deploy-Wallets
///   CELOSCAN_API_KEY      — für automatische Verifikation auf Celoscan
///   ADMIN_ADDRESS          — Admin für setFee()/setStablecoin()/
///                            setMaxSlippageBps()/setGlobalKeeper()/
///                            setAdmin() auf der neuen Factory. Seit Plan 2
///                            Phase A empfohlen: direkt die TimelockController-
///                            Adresse (siehe SECURITY.md), NICHT das Deployer-
///                            Wallet. Adresse vor dem Deploy verifizieren,
///                            nicht blind aus SECURITY.md kopieren.
///
/// WICHTIG nach dem Deploy, VOR dem ersten setupPlan(): setStablecoin(token,
/// true) für jedes Stablecoin-Bein aufrufen, das Trigger-Pläne nutzen sollen
/// (aktuell USDC/USDT, siehe src/config.ts INPUT_TOKENS) — ohne mindestens
/// einen gelisteten Stablecoin revertiert JEDES setupPlan() mit
/// StablecoinRequired() (siehe TriggerVault.setupPlan()). Läuft ADMIN_ADDRESS
/// bereits auf den Timelock, braucht das den vollen 48h-Zyklus — vor dem
/// finalen Cutover einplanen, nicht erst wenn der erste Nutzer einen Plan
/// anlegen will.

contract DeployTriggerVaultFactory is Script {

    // Quelle: Squid /v2/sdk-info, chains[].squidContracts.squidRouter
    // (chainId 42220) — identisch zu DeployFactory.s.sol.
    address constant SQUID_ROUTER_MAINNET = 0xce16F69375520ab01377ce7B88f5BA8C48F8D666;

    // Derselbe globale Keeper-Bot wie DcaVaultFactory (siehe
    // .github/workflows/keeper.yml / keeper/squidKeeper.ts) — wird bei jedem
    // neuen TriggerVault automatisch freigeschaltet und ist zugleich Treasury
    // (siehe TriggerVaultFactory.feeInfo()).
    address constant GLOBAL_KEEPER = 0x02069c8AfceC69622c0F1C5316735042A86BC6fA;

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren (Squid unterstuetzt Celo Sepolia nicht)!"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");

        console2.log("=== OSIRIS TriggerVaultFactory Deploy (Fee-Snapshot + Slippage-Floor) ===");
        console2.log("Chain ID:      ", block.chainid);
        console2.log("Squid Router:  ", SQUID_ROUTER_MAINNET);
        console2.log("Global Keeper: ", GLOBAL_KEEPER);
        console2.log("Admin:         ", admin);

        vm.startBroadcast(deployerKey);

        TriggerVault implementation = new TriggerVault();
        TriggerVaultFactory factory = new TriggerVaultFactory(
            address(implementation),
            SQUID_ROUTER_MAINNET,
            GLOBAL_KEEPER,
            admin
        );

        vm.stopBroadcast();

        console2.log("");
        console2.log("TriggerVault Implementation:", address(implementation));
        console2.log("TriggerVaultFactory:        ", address(factory));
        console2.log("");
        console2.log("Naechste Schritte:");
        console2.log("1. Alte TRIGGER_VAULT_FACTORY_ADDRESS nach OLD_TRIGGER_VAULT_FACTORY_ADDRESS");
        console2.log("   verschieben, neue Adresse als TRIGGER_VAULT_FACTORY_ADDRESS eintragen.");
        console2.log("2. TRIGGER_VAULT_FACTORY_ADDRESSES (Keeper-Secret, kommagetrennt) um die neue");
        console2.log("   Adresse ERGAENZEN statt ersetzen, sonst verliert der Keeper bestehende Plaene.");
        console2.log("3. setStablecoin(usdc, true) / setStablecoin(usdt, true) aufrufen (siehe");
        console2.log("   Kommentar oben) -- ohne das schlaegt jedes setupPlan() fehl.");
    }
}
