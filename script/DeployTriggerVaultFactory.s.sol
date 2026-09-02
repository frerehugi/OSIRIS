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
/// USDC/USDT werden ATOMAR im selben Deploy als Stablecoin-Bein freigeschaltet
/// (siehe TriggerVaultFactory-Konstruktor) — kein separater Aufruf nötig. Das
/// ist bewusst so: läuft ADMIN_ADDRESS bereits auf dem Timelock, würde ein
/// nachträglicher setStablecoin()-Aufruf den vollen 48h-Zyklus brauchen, und
/// die Factory wäre bis dahin für JEDES setupPlan() unbenutzbar
/// (StablecoinRequired()). Ein zusätzliches Stablecoin (z.B. cUSD, sobald
/// Squid es unterstützt) kann später jederzeit per setStablecoin() über den
/// Admin nachgezogen werden.

contract DeployTriggerVaultFactory is Script {

    // Quelle: Squid /v2/sdk-info, chains[].squidContracts.squidRouter
    // (chainId 42220) — identisch zu DeployFactory.s.sol.
    address constant SQUID_ROUTER_MAINNET = 0xce16F69375520ab01377ce7B88f5BA8C48F8D666;

    // Derselbe globale Keeper-Bot wie DcaVaultFactory (siehe
    // .github/workflows/keeper.yml / keeper/squidKeeper.ts) — wird bei jedem
    // neuen TriggerVault automatisch freigeschaltet und ist zugleich Treasury
    // (siehe TriggerVaultFactory.feeInfo()).
    address constant GLOBAL_KEEPER = 0x02069c8AfceC69622c0F1C5316735042A86BC6fA;

    // Quelle: src/config.ts INPUT_TOKENS (mainnet) — die beiden aktuell auf
    // Mainnet nutzbaren Stablecoins (cUSD ist dort aktuell von Squid nicht
    // geroutet, siehe Kommentar in config.ts, deshalb hier bewusst nicht dabei).
    address constant USDC_MAINNET = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    address constant USDT_MAINNET = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;

    // Quelle: src/config.ts TARGET_TOKENS (mainnet) — die vier heute über
    // OSIRIS handelbaren Zieltoken, jeweils als heldToken eines Sell-Triggers
    // möglich (siehe TriggerVault.setupPlan()).
    address constant WBTC_MAINNET  = 0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D; // 8 Decimals
    address constant WETH_MAINNET  = 0xD221812de1BD094f35587EE8E174B07B6167D9Af; // 18 Decimals
    address constant CELO_MAINNET  = 0x471EcE3750Da237f93B8E339c536989b8978a438; // 18 Decimals
    address constant XAUOT_MAINNET = 0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff; // 6 Decimals

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren (Squid unterstuetzt Celo Sepolia nicht)!"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");

        address[] memory initialStablecoins = new address[](2);
        initialStablecoins[0] = USDC_MAINNET;
        initialStablecoins[1] = USDT_MAINNET;

        // Plan 4 Befund A: minFeeByToken statt eines globalen Skalars — grobe
        // ~$0.03-Zielwerte je Token (kein Preis-Orakel verfügbar, admin-
        // kalibriert wie bei SendVaultFactory, jederzeit per setMinFee()
        // nachjustierbar). Reproduzierter Bug vor diesem Fix: der alte globale
        // Wert (35_000) war bei wBTC (8 statt 6 Decimals) 0,00035 wBTC — bei
        // einem Verkauf von 0,001 wBTC also 35 % Gebühr trotz nominell 0,99 %.
        address[] memory minFeeTokens = new address[](6);
        minFeeTokens[0] = USDC_MAINNET;
        minFeeTokens[1] = USDT_MAINNET;
        minFeeTokens[2] = WBTC_MAINNET;
        minFeeTokens[3] = WETH_MAINNET;
        minFeeTokens[4] = CELO_MAINNET;
        minFeeTokens[5] = XAUOT_MAINNET;

        uint256[] memory minFeeValues = new uint256[](6);
        minFeeValues[0] = 35_000;                     // USDC, 6 Dez. — ≈$0.035 (unverändert)
        minFeeValues[1] = 35_000;                     // USDT, 6 Dez. — ≈$0.035 (unverändert)
        minFeeValues[2] = 50;                          // wBTC, 8 Dez. — ≈$0.0385 bei ~$77k/BTC
        minFeeValues[3] = 10_000_000_000_000;          // wETH, 18 Dez. — ≈$0.024 bei ~$2420/ETH
        minFeeValues[4] = 400_000_000_000_000_000;     // CELO, 18 Dez. — ≈$0.029 bei ~$0.073/CELO
        minFeeValues[5] = 7_000;                        // XAUoT, 6 Dez. — ≈$0.030 bei ~$4346/oz

        console2.log("=== OSIRIS TriggerVaultFactory Deploy (Fee-Snapshot + Slippage-Floor + Per-Token MinFee) ===");
        console2.log("Chain ID:      ", block.chainid);
        console2.log("Squid Router:  ", SQUID_ROUTER_MAINNET);
        console2.log("Global Keeper: ", GLOBAL_KEEPER);
        console2.log("Admin:         ", admin);
        console2.log("Stablecoins:   ", USDC_MAINNET);
        console2.log("               ", USDT_MAINNET);
        console2.log("MinFee tokens: 6 (USDC/USDT/wBTC/wETH/CELO/XAUoT) -- siehe Skript fuer Rohwerte");

        vm.startBroadcast(deployerKey);

        TriggerVault implementation = new TriggerVault();
        TriggerVaultFactory factory = new TriggerVaultFactory(
            address(implementation),
            SQUID_ROUTER_MAINNET,
            GLOBAL_KEEPER,
            admin,
            initialStablecoins,
            minFeeTokens,
            minFeeValues
        );

        vm.stopBroadcast();

        console2.log("");
        console2.log("TriggerVault Implementation:", address(implementation));
        console2.log("TriggerVaultFactory:        ", address(factory));
        console2.log("");
        console2.log("Naechste Schritte:");
        console2.log("1. Neue Adresse in ALL_TRIGGER_VAULT_FACTORY_ADDRESSES (src/config.ts)");
        console2.log("   ERGAENZEN, nicht ersetzen -- diesmal eine wachsende Liste statt nur zwei");
        console2.log("   benannten Slots (Lektion aus der ersten DCA-Migration in Plan 2).");
        console2.log("2. TRIGGER_VAULT_FACTORY_ADDRESSES (Keeper-Secret, kommagetrennt) um die neue");
        console2.log("   Adresse ERGAENZEN statt ersetzen, sonst verliert der Keeper bestehende Plaene.");
        console2.log("3. minFeeByToken() fuer alle 6 Token per Celoscan Read-Contract gegenlesen,");
        console2.log("   bevor die Adresse produktiv geschaltet wird.");
    }
}
