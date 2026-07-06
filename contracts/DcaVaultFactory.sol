// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DcaVault} from "./DcaVault.sol";

/// @notice Erzeugt für jeden Nutzer einen eigenen DcaVault als günstigen
///         EIP-1167-Minimal-Proxy-Clone statt eines vollen Contract-Deploys.
///         Der Squid-Router wird beim Erstellen automatisch im Vault
///         freigeschaltet (siehe DcaVault.initialize()).
///
/// @dev    Bewusst KEIN createVaultAndSetupPlan(): setupPlan() zieht das
///         Input-Token per safeTransferFrom vom Owner — der Nutzer kann den
///         frisch erzeugten Vault aber erst approven, NACHDEM dessen Adresse
///         bekannt ist. Der saubere Ablauf ist daher bewusst 3 Transaktionen:
///         createVault() → usdc.approve(vault, amount) → vault.setupPlan(...).
contract DcaVaultFactory {

    // ── Immutables ────────────────────────────────────────────────────────────

    address public immutable vaultImplementation;
    address public immutable squidRouter;

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(address => address[]) public vaultsOf;
    address[] public allVaults;

    // ── Errors ───────────────────────────────────────────────────────────────

    error InvalidAddress();

    // ── Events ───────────────────────────────────────────────────────────────

    event VaultCreated(address indexed owner, address indexed vault);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _vaultImplementation, address _squidRouter) {
        if (_vaultImplementation == address(0) || _squidRouter == address(0))
            revert InvalidAddress();
        vaultImplementation = _vaultImplementation;
        squidRouter          = _squidRouter;
    }

    // ── createVault ──────────────────────────────────────────────────────────
    //
    // Clone + initialize() laufen in derselben Transaktion — kein Zeitfenster
    // für Front-Running zwischen Clone-Erzeugung und Initialisierung.

    function createVault() external returns (address vault) {
        vault = Clones.clone(vaultImplementation);
        DcaVault(vault).initialize(msg.sender, squidRouter);

        vaultsOf[msg.sender].push(vault);
        allVaults.push(vault);

        emit VaultCreated(msg.sender, vault);
    }

    // ── View-Funktionen ──────────────────────────────────────────────────────

    function getVaults(address _owner) external view returns (address[] memory) {
        return vaultsOf[_owner];
    }

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
