// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DcaVault} from "./DcaVault.sol";

/// @notice Erzeugt für jeden Nutzer einen eigenen DcaVault als günstigen
///         EIP-1167-Minimal-Proxy-Clone statt eines vollen Contract-Deploys.
///         Der Squid-Router und der globale Keeper-Bot werden beim Erstellen
///         automatisch im Vault freigeschaltet (siehe DcaVault.initialize()).
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
    address public immutable globalKeeper;

    // ── State ─────────────────────────────────────────────────────────────────
    //
    // Gebühr pro executeStep(): feeBps auf den Tranchenbetrag, mindestens
    // minFee (Floor greift bei sehr kleinen Tranchen). Treasury ist bewusst
    // KEIN separates Wallet, sondern globalKeeper selbst — deckt dessen
    // Gas-Kosten direkt aus den Gebühreneinnahmen.

    address public admin;
    uint16  public feeBps;
    uint256 public minFee;

    mapping(address => address[]) public vaultsOf;
    address[] public allVaults;

    // ── Errors ───────────────────────────────────────────────────────────────

    error InvalidAddress();
    error NotAdmin();
    error FeeTooHigh();

    // ── Events ───────────────────────────────────────────────────────────────

    event VaultCreated(address indexed owner, address indexed vault);
    event FeeUpdated(uint16 feeBps, uint256 minFee);
    event AdminUpdated(address indexed admin);

    // ── Modifier ─────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _vaultImplementation, address _squidRouter, address _globalKeeper, address _admin) {
        if (
            _vaultImplementation == address(0) ||
            _squidRouter         == address(0) ||
            _globalKeeper        == address(0) ||
            _admin                == address(0)
        ) revert InvalidAddress();
        vaultImplementation = _vaultImplementation;
        squidRouter          = _squidRouter;
        globalKeeper          = _globalKeeper;
        admin                 = _admin;
        feeBps                = 99;     // 0,99 %
        minFee                 = 20_000; // 0,02 USDC/USDT (6 Decimals)
    }

    // ── Admin-Funktionen ─────────────────────────────────────────────────────

    function setFee(uint16 _feeBps, uint256 _minFee) external onlyAdmin {
        if (_feeBps > 500) revert FeeTooHigh(); // 5 % Hard-Cap
        feeBps = _feeBps;
        minFee = _minFee;
        emit FeeUpdated(_feeBps, _minFee);
    }

    function setAdmin(address _admin) external onlyAdmin {
        if (_admin == address(0)) revert InvalidAddress();
        admin = _admin;
        emit AdminUpdated(_admin);
    }

    // ── feeInfo ──────────────────────────────────────────────────────────────
    //
    // Ein kombinierter Getter statt drei separater External Calls aus
    // DcaVault.executeStep() — spart Gas bei jeder Ausführung.

    function feeInfo() external view returns (uint16 _feeBps, uint256 _minFee, address _treasury) {
        return (feeBps, minFee, globalKeeper);
    }

    // ── createVault ──────────────────────────────────────────────────────────
    //
    // Clone + initialize() laufen in derselben Transaktion — kein Zeitfenster
    // für Front-Running zwischen Clone-Erzeugung und Initialisierung.

    function createVault() external returns (address vault) {
        vault = Clones.clone(vaultImplementation);
        DcaVault(vault).initialize(msg.sender, squidRouter, globalKeeper);

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
