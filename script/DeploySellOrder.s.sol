// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {ConditionalSellOrder} from "../contracts/ConditionalSellOrder.sol";

/// @notice Deployt ConditionalSellOrder (Apis) auf Celo Mainnet. Additiv —
///         rührt DcaVault/DcaVaultFactory/den bestehenden OSIRIS-Keeper nicht an.
///
/// Ausführung:
///   forge script script/DeploySellOrder.s.sol \
///     --rpc-url celo_mainnet \
///     --broadcast \
///     --verify \
///     -vvvv
///
/// Benötigte Umgebungsvariablen (.env):
///   DEPLOYER_PRIVATE_KEY   — Private Key des Apis-Admin/Deployer-Wallets
///                            (siehe Gesamtplan §20 — NICHT das OSIRIS-Deployer-Wallet)
///   CELOSCAN_API_KEY       — für automatische Verifikation (bereits vorhanden, wiederverwendet)
///   APIS_ADMIN_ADDRESS     — Adresse des Apis-Admin-Wallets (setFee/setAdmin/setTreasury)
///   APIS_TREASURY_ADDRESS  — Adresse der Apis-Keeper-Wallet (empfängt Gebühren, siehe §21)
///
/// Bewusst KEINE hartkodierten Adressen für Admin/Treasury (anders als
/// DeployFactory.s.sol) — die echten Apis-Wallet-Adressen existieren zum
/// Zeitpunkt dieses Commits noch nicht (siehe Gesamtplan §20, vom Nutzer
/// selbst zu erzeugen). Umgebungsvariablen verhindern, dass hier versehentlich
/// eine Platzhalter-Adresse fest einprogrammiert und übersehen wird.

contract DeploySellOrder is Script {

    // Quelle: Squid /v2/sdk-info, chains[].squidContracts.squidRouter (chainId 42220) —
    // identisch zu DeployFactory.s.sol, bewusst dieselbe, bereits verifizierte Adresse.
    address constant SQUID_ROUTER_MAINNET = 0xce16F69375520ab01377ce7B88f5BA8C48F8D666;

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren (Squid unterstuetzt Celo Sepolia nicht)!"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin       = vm.envAddress("APIS_ADMIN_ADDRESS");
        address treasury    = vm.envAddress("APIS_TREASURY_ADDRESS");

        console2.log("=== Apis ConditionalSellOrder Deploy ===");
        console2.log("Chain ID:      ", block.chainid);
        console2.log("Squid Router:  ", SQUID_ROUTER_MAINNET);
        console2.log("Apis Admin:    ", admin);
        console2.log("Apis Treasury: ", treasury);

        vm.startBroadcast(deployerKey);

        ConditionalSellOrder sellOrder = new ConditionalSellOrder(
            SQUID_ROUTER_MAINNET,
            admin,
            treasury
        );

        vm.stopBroadcast();

        console2.log("");
        console2.log("ConditionalSellOrder:", address(sellOrder));
        console2.log("");
        console2.log("Naechster Schritt: Adresse in apis/app/src/config.ts eintragen.");
    }
}
