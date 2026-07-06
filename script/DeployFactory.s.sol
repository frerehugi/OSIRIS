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
/// Benötigte Umgebungsvariablen (.env):
///   DEPLOYER_PRIVATE_KEY  — Private Key des Deploy-Wallets
///   CELOSCAN_API_KEY      — für automatische Verifikation auf Celoscan
///
/// Hinweis: Squid unterstützt Celo Sepolia nicht (nur Mainnet) — dieses
/// Deployment hat deshalb bewusst keinen Testnet-Pfad.

contract DeployFactory is Script {

    // Quelle: Squid /v2/sdk-info, chains[].squidContracts.squidRouter (chainId 42220)
    address constant SQUID_ROUTER_MAINNET = 0xce16F69375520ab01377ce7B88f5BA8C48F8D666;

    function run() external {
        require(
            block.chainid == 42220,
            "Nur auf Celo Mainnet ausfuehren (Squid unterstuetzt Celo Sepolia nicht)!"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        console2.log("=== OSIRIS DcaVaultFactory Deploy ===");
        console2.log("Chain ID:      ", block.chainid);
        console2.log("Squid Router:  ", SQUID_ROUTER_MAINNET);

        vm.startBroadcast(deployerKey);

        DcaVault implementation = new DcaVault();
        DcaVaultFactory factory = new DcaVaultFactory(address(implementation), SQUID_ROUTER_MAINNET);

        vm.stopBroadcast();

        console2.log("");
        console2.log("DcaVault Implementation:", address(implementation));
        console2.log("DcaVaultFactory:        ", address(factory));
        console2.log("");
        console2.log("Naechster Schritt: Adressen in src/config.ts eintragen");
        console2.log("(VAULT_IMPLEMENTATION_ADDRESS / FACTORY_ADDRESS).");
    }
}
