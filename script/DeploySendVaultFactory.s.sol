// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {SendVault} from "../contracts/SendVault.sol";
import {SendVaultFactory} from "../contracts/SendVaultFactory.sol";

/// @notice Deployt die SendVault-Master-Implementation + SendVaultFactory auf
///         Celo Mainnet — OSIRIS' Auszahlungs-Erweiterung neben dem
///         bestehenden DcaVault/TriggerVault. Additiv, rührt die anderen
///         Vault-Typen nicht an. Anders als DeployFactory.s.sol/
///         DeployTriggerVaultFactory.s.sol braucht der Constructor hier
///         keinen Squid-Router (SendVault swapped nie, siehe SendVault.sol).
///
/// Ausführung:
///   forge script script/DeploySendVaultFactory.s.sol \
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
///                            vor dem Deploy verifizieren, nicht blind aus
///                            SECURITY.md kopieren.
///
/// WICHTIG nach dem Deploy: setMinFee() für jedes tatsächlich genutzte Token
/// aufrufen (USDC/USDT/cUSD/wBTC/wETH/CELO/XAUoT), sonst greift bis dahin nur
/// der prozentuale feeBps-Anteil und nicht der ~$0,009-Floor — siehe
/// SendVaultFactory.sol, minFeeByToken-Kommentar. Kein Live-Oracle an Bord,
/// die Raw-Beträge müssen daher off-chain berechnet werden (Kurs * Decimals).
/// Läuft ADMIN_ADDRESS bereits auf den Timelock, braucht das (wie jede
/// spätere Fee-Änderung) den vollen 48h-Zyklus.

contract DeploySendVaultFactory is Script {

    // Derselbe globale Keeper-Bot wie DcaVaultFactory/TriggerVaultFactory
    // (siehe .github/workflows/keeper.yml / keeper/squidKeeper.ts) — wird bei
    // jedem neuen SendVault automatisch freigeschaltet und ist zugleich
    // Treasury (siehe SendVaultFactory.feeInfo()).
    address constant GLOBAL_KEEPER = 0x02069c8AfceC69622c0F1C5316735042A86BC6fA;

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren!"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");

        console2.log("=== OSIRIS SendVaultFactory Deploy (Fee-Snapshot + minFee-Cap + setGlobalKeeper) ===");
        console2.log("Chain ID:      ", block.chainid);
        console2.log("Global Keeper: ", GLOBAL_KEEPER);
        console2.log("Admin:         ", admin);

        vm.startBroadcast(deployerKey);

        SendVault implementation = new SendVault();
        SendVaultFactory factory = new SendVaultFactory(
            address(implementation),
            GLOBAL_KEEPER,
            admin
        );

        vm.stopBroadcast();

        console2.log("");
        console2.log("SendVault Implementation:", address(implementation));
        console2.log("SendVaultFactory:        ", address(factory));
        console2.log("");
        console2.log("Naechste Schritte:");
        console2.log("1. Alte SEND_VAULT_FACTORY_ADDRESS nach OLD_SEND_VAULT_FACTORY_ADDRESS");
        console2.log("   verschieben, neue Adresse als SEND_VAULT_FACTORY_ADDRESS eintragen.");
        console2.log("2. SEND_VAULT_FACTORY_ADDRESSES (Keeper-Secret, kommagetrennt) um die neue");
        console2.log("   Adresse ERGAENZEN statt ersetzen, sonst verliert der Keeper bestehende Plaene.");
        console2.log("3. setMinFee() pro Token aufrufen (siehe Kommentar oben) -- ueber den Timelock,");
        console2.log("   falls ADMIN_ADDRESS bereits der Timelock ist.");
    }
}
