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
///   DEPLOYER_PRIVATE_KEY   — Private Key des Apis-Admin/Deployer-Wallets (APIS_ADMIN unten)
///                            — NICHT das OSIRIS-Deployer-Wallet, siehe Gesamtplan §17/§20
///   CELOSCAN_API_KEY       — für automatische Verifikation (bereits vorhanden, wiederverwendet)
///
/// APIS_TREASURY (Apis-Keeper-Wallet) und APIS_ADMIN (Apis-Admin/Deployer-Wallet)
/// sind beide bekannt und unten als Konstanten hinterlegt, analog zu
/// GLOBAL_KEEPER/ADMIN in DeployFactory.s.sol. Achtung: als gemischtgroße
/// Adress-Literale prüft solc beim Kompilieren automatisch den EIP-55-Checksum —
/// falls der Build deswegen fehlschlägt, Groß-/Kleinschreibung gegen die Quelle
/// (Wallet-Export) verifizieren. Konnte in dieser Sandbox nicht kompiliert werden
/// (siehe Chat), bitte vor dem Deploy lokal `forge build` prüfen.

contract DeploySellOrder is Script {

    // Quelle: Squid /v2/sdk-info, chains[].squidContracts.squidRouter (chainId 42220) —
    // identisch zu DeployFactory.s.sol, bewusst dieselbe, bereits verifizierte Adresse.
    address constant SQUID_ROUTER_MAINNET = 0xce16F69375520ab01377ce7B88f5BA8C48F8D666;

    // Apis-Keeper-Wallet — separat von OSIRIS' GLOBAL_KEEPER (siehe Gesamtplan §17:
    // eigene Wallet zwingend wegen Nonce-Konflikt/Treasury-Kopplung/Blast-Radius).
    // Empfängt die ConditionalSellOrder-Gebühren (siehe §21) und signiert die
    // execute()-Aufrufe des Apis-Keepers.
    address constant APIS_TREASURY = 0x1486f1859f0b2b16b525096205cCaE74a681b78c;

    // Apis-Admin/Deployer-Wallet — separat von OSIRIS' ADMIN, hält setFee()/
    // setAdmin()/setTreasury()-Rechte auf diesem Contract (siehe Gesamtplan §20).
    address constant APIS_ADMIN = 0x780bD65804a64A03f8d6F0e9b9b1c6bC0cf4d6B9;

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren (Squid unterstuetzt Celo Sepolia nicht)!"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin       = APIS_ADMIN;
        address treasury    = APIS_TREASURY;

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
