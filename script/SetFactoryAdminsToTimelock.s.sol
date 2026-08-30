// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {DcaVaultFactory} from "../contracts/DcaVaultFactory.sol";
import {TriggerVaultFactory} from "../contracts/TriggerVaultFactory.sol";
import {SendVaultFactory} from "../contracts/SendVaultFactory.sol";

/// @notice Plan 2, Phase A, Schritt 2 — ruft die bereits existierende
///         setAdmin(address) auf den drei aktuell live laufenden Factories
///         auf und verschiebt sie damit hinter den in
///         DeployTimelock.s.sol deployten Timelock. Kein Redeploy von
///         Vault-Contracts, keine Migration bestehender Pläne — reiner
///         Governance-Wechsel auf den existierenden Factory-Instanzen.
///
///         Bewusst NICHT die alte, deprecated DcaVaultFactory
///         (OLD_FACTORY_ADDRESS in src/config.ts) — Plan 2 Phase A ist
///         explizit auf die drei aktuellen Factories begrenzt, siehe Plan.
///
/// WICHTIG — das ist ein Einweg-Schritt: nach dieser Transaktion braucht
/// jede setFee()/setMinFee()/setAdmin()-Aktion auf diesen drei Factories den
/// vollen 48h-Timelock-Zyklus (schedule → warten → execute), auch für den
/// bisherigen Admin selbst. Vor dem Ausführen: TIMELOCK Adresse unten
/// verifizieren (z.B. auf Celoscan gegenlesen), nicht blind aus der
/// vorherigen Konsolen-Ausgabe kopieren.
///
/// Ausführung:
///   TIMELOCK_ADDRESS=0x... forge script script/SetFactoryAdminsToTimelock.s.sol \
///     --rpc-url celo_mainnet \
///     --broadcast \
///     -vvvv
///
/// Benötigte Umgebungsvariablen (.env oder inline):
///   DEPLOYER_PRIVATE_KEY  — Private Key des AKTUELLEN Admin-Wallets
///                            (0xDbcB531c0a794c43CbE861ca147bE7e8A83Bb523) —
///                            nur der aktuelle Admin darf setAdmin() aufrufen
///   TIMELOCK_ADDRESS       — Adresse aus DeployTimelock.s.sol

contract SetFactoryAdminsToTimelock is Script {

    address constant DCA_VAULT_FACTORY     = 0xba148255d757912442A97f87c50DD2F65FBab7E0;
    address constant TRIGGER_VAULT_FACTORY = 0xeD39de472baEE17e6Ce05a0A4A0515eb4DF98a97;
    address constant SEND_VAULT_FACTORY    = 0x1d7a157Bb1823482039B4B3037fb1737B1F2750A;

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren!"
        );

        uint256 adminKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address timelock = vm.envAddress("TIMELOCK_ADDRESS");

        console2.log("=== OSIRIS Factory-Admin -> Timelock (Plan 2, Phase A) ===");
        console2.log("Chain ID:  ", block.chainid);
        console2.log("Timelock:  ", timelock);
        console2.log("");
        console2.log("Betroffene Factories:");
        console2.log("  DcaVaultFactory:     ", DCA_VAULT_FACTORY);
        console2.log("  TriggerVaultFactory: ", TRIGGER_VAULT_FACTORY);
        console2.log("  SendVaultFactory:    ", SEND_VAULT_FACTORY);

        vm.startBroadcast(adminKey);

        DcaVaultFactory(DCA_VAULT_FACTORY).setAdmin(timelock);
        TriggerVaultFactory(TRIGGER_VAULT_FACTORY).setAdmin(timelock);
        SendVaultFactory(SEND_VAULT_FACTORY).setAdmin(timelock);

        vm.stopBroadcast();

        console2.log("");
        console2.log("Erledigt. admin() auf allen drei Factories jetzt der Timelock.");
        console2.log("Ab jetzt: setFee()/setMinFee()/setAdmin() nur noch ueber");
        console2.log("timelock.schedule(...) + 48h warten + timelock.execute(...).");
    }
}
