// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {DcaVault} from "../contracts/DcaVault.sol";
import {DcaVaultFactory} from "../contracts/DcaVaultFactory.sol";

/// @notice Deployt die DcaVault-Master-Implementation + DcaVaultFactory auf
///         Celo Mainnet. Ab diesem Deploy entstehen neue Vaults ausschließlich
///         über factory.createVault() (EIP-1167-Clones) statt über einen
///         direkten DcaVault-Deploy.
///
/// Ausführung:
///   forge script script/DeployFactory.s.sol \
///     --rpc-url celo_mainnet \
///     --broadcast \
///     --verify \
///     -vvvv
///
/// Benötigte Umgebungsvariablen (.env oder inline):
///   DEPLOYER_PRIVATE_KEY  — Private Key des Deploy-Wallets
///   CELOSCAN_API_KEY      — für automatische Verifikation auf Celoscan
///   ADMIN_ADDRESS          — Admin für setFee()/setMinFee()/setGlobalKeeper()/
///                            setAdmin() auf der neuen Factory. Seit Plan 2
///                            Phase A empfohlen: direkt die TimelockController-
///                            Adresse (siehe SECURITY.md), NICHT das Deployer-
///                            Wallet — sonst hat die neue Factory einen
///                            EOA-Admin ohne 48h-Verzögerung, bis jemand
///                            manuell setAdmin(timelock) nachzieht. Adresse
///                            vor dem Deploy verifizieren (z.B. Celoscan),
///                            nicht blind aus SECURITY.md kopieren.
///
/// Hinweis: Squid unterstützt Celo Sepolia nicht (nur Mainnet) — dieses
/// Deployment hat deshalb bewusst keinen Testnet-Pfad.

contract DeployFactory is Script {

    // Quelle: Squid /v2/sdk-info, chains[].squidContracts.squidRouter (chainId 42220)
    address constant SQUID_ROUTER_MAINNET = 0xce16F69375520ab01377ce7B88f5BA8C48F8D666;

    // Adresse des globalen Keeper-Bots (GitHub-Actions-Workflow, siehe
    // .github/workflows/keeper.yml / keeper/squidKeeper.ts). Wird bei jedem
    // neu erstellten Vault automatisch als Keeper freigeschaltet, damit der
    // Bot ohne zusätzliche setKeeper()-Transaktion des Nutzers Steps ausführen
    // kann.
    address constant GLOBAL_KEEPER = 0x02069c8AfceC69622c0F1C5316735042A86BC6fA;

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren (Squid unterstuetzt Celo Sepolia nicht)!"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");

        console2.log("=== OSIRIS DcaVaultFactory Deploy (Fee-Snapshot + minFee-Cap + setGlobalKeeper) ===");
        console2.log("Chain ID:      ", block.chainid);
        console2.log("Squid Router:  ", SQUID_ROUTER_MAINNET);
        console2.log("Global Keeper: ", GLOBAL_KEEPER);
        console2.log("Admin:         ", admin);

        vm.startBroadcast(deployerKey);

        DcaVault implementation = new DcaVault();
        DcaVaultFactory factory = new DcaVaultFactory(
            address(implementation),
            SQUID_ROUTER_MAINNET,
            GLOBAL_KEEPER,
            admin
        );

        vm.stopBroadcast();

        console2.log("");
        console2.log("DcaVault Implementation:", address(implementation));
        console2.log("DcaVaultFactory:        ", address(factory));
        console2.log("");
        console2.log("Naechste Schritte:");
        console2.log("1. Alte FACTORY_ADDRESS in src/config.ts + apis/app/src/config.ts nach");
        console2.log("   OLD_FACTORY_ADDRESS verschieben, neue Adresse als FACTORY_ADDRESS eintragen");
        console2.log("   (VAULT_IMPLEMENTATION_ADDRESS ebenfalls aktualisieren).");
        console2.log("2. FACTORY_ADDRESSES (Keeper-Secret, kommagetrennt) um die neue Adresse");
        console2.log("   ERGAENZEN statt ersetzen, sonst verliert der Keeper bestehende Plaene.");
    }
}
