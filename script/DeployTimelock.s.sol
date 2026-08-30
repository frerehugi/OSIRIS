// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Plan 2, Phase A — deployt einen TimelockController, der die
///         onlyAdmin-Aktionen (setFee/setMinFee/setAdmin/setGlobalMFeeXXX)
///         auf DcaVaultFactory/TriggerVaultFactory/SendVaultFactory hinter
///         eine 48h-Verzögerung stellt. Kein Redeploy der Vault-Contracts,
///         kein Migrationsrisiko — reine Governance-Änderung auf den
///         bereits live laufenden Factories (siehe SetFactoryAdminsToTimelock.s.sol
///         für den zweiten, separaten Schritt).
///
/// Rollen-Konfiguration (bewusst so gewählt, nicht Default-Copy-Paste):
///   - proposer: der aktuelle Admin-EOA (0xDbcB...Bb523) — bleibt also der
///     einzige Vorschlagsberechtigte, GENAU WIE HEUTE. Der Unterschied ist
///     nicht "wer darf vorschlagen", sondern "wie lange dauert es, bis ein
///     Vorschlag wirkt" — von sofort auf 48h öffentlich sichtbar.
///   - executor: address(0) = offen — nach Ablauf der 48h kann JEDER die
///     bereits öffentlich sichtbare, angekündigte Aktion ausführen. Kein
///     zusätzlicher Vertrauens-Einzelpunkt für die Ausführung selbst.
///   - admin (DEFAULT_ADMIN_ROLE): address(0) — WICHTIG, nicht auf einen EOA
///     setzen. Ein gesetzter admin könnte Rollen (inkl. sich selbst als
///     Executor/Proposer) ändern und damit den Timelock umgehen. Mit
///     address(0) verwaltet sich der Timelock nur noch selbst (über seine
///     eigene, delay-pflichtige execute()-Funktion) — Standard-OZ-Empfehlung
///     für Produktivsysteme.
///
/// Bekannte, im Plan dokumentierte Grenze: der Proposer ist weiterhin ein
/// einzelner EOA-Key, keine Multisig. Der Timelock verzögert und macht
/// Angriffe sichtbar, er eliminiert das Single-Key-Risiko beim Vorschlagen
/// nicht vollständig — eine echte Multisig-Proposer-Rolle ist ein separates,
/// späteres Vorhaben.
///
/// Ausführung:
///   forge script script/DeployTimelock.s.sol \
///     --rpc-url celo_mainnet \
///     --broadcast \
///     --verify \
///     -vvvv
///
/// Benötigte Umgebungsvariablen (.env):
///   DEPLOYER_PRIVATE_KEY  — Private Key des Deploy-Wallets
///   CELOSCAN_API_KEY      — für automatische Verifikation auf Celoscan

contract DeployTimelock is Script {

    uint256 constant DELAY = 48 hours;

    // Aktueller Admin aller drei Factories (siehe DeployTriggerVaultFactory.s.sol,
    // DeployFactory.s.sol, DeploySendVaultFactory.s.sol) — wird Proposer.
    address constant CURRENT_ADMIN = 0xDbcB531c0a794c43CbE861ca147bE7e8A83Bb523;

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren!"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address[] memory proposers = new address[](1);
        proposers[0] = CURRENT_ADMIN;

        address[] memory executors = new address[](1);
        executors[0] = address(0); // offen — jeder kann nach Ablauf der Verzögerung ausführen

        console2.log("=== OSIRIS Timelock Deploy (Plan 2, Phase A) ===");
        console2.log("Chain ID:  ", block.chainid);
        console2.log("Delay:     ", DELAY, "seconds (48h)");
        console2.log("Proposer:  ", CURRENT_ADMIN);
        console2.log("Executor:  offen (address(0))");
        console2.log("Admin-Rolle: address(0) (selbstverwaltet, siehe Kommentar oben)");

        vm.startBroadcast(deployerKey);

        TimelockController timelock = new TimelockController(
            DELAY,
            proposers,
            executors,
            address(0)
        );

        vm.stopBroadcast();

        console2.log("");
        console2.log("TimelockController deployed:", address(timelock));
        console2.log("");
        console2.log("NAECHSTER SCHRITT (separat, mit Bedacht):");
        console2.log("script/SetFactoryAdminsToTimelock.s.sol mit dieser Adresse ausfuehren,");
        console2.log("um die drei Factories tatsaechlich umzustellen. Vorher pruefen,");
        console2.log("dass die Adresse hier oben wirklich stimmt.");
    }
}
