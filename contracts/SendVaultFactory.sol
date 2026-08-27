// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SendVault} from "./SendVault.sol";

/// @notice Erzeugt für jeden Send-Plan einen eigenen SendVault als günstigen
///         EIP-1167-Minimal-Proxy-Clone — identisches Muster wie
///         DcaVaultFactory/TriggerVaultFactory, aber ohne Squid-Router (kein
///         Swap, siehe SendVault.sol). Der globale Keeper-Bot wird beim
///         Erstellen automatisch im Vault freigeschaltet.
///
/// @dev    Bewusst KEIN createVaultAndSetupPlan(): setupPlan() zieht das
///         Token per safeTransferFrom vom Owner, der kann den frisch
///         erzeugten Vault aber erst approven, NACHDEM dessen Adresse
///         bekannt ist. Der Ablauf ist daher bewusst 3 Transaktionen:
///         createVault() → token.approve(vault, amount) → vault.setupPlan(...).
contract SendVaultFactory {

    // ── Immutables ────────────────────────────────────────────────────────────

    address public immutable vaultImplementation;
    address public immutable globalKeeper;

    // ── State ─────────────────────────────────────────────────────────────────
    //
    // feeBps gilt token-unabhängig (49 bps = 0,49 %, siehe Chat). minFee ist
    // dagegen PRO TOKEN gesetzt (minFeeByToken), weil SendVault beliebige
    // MiniPay-Token mit unterschiedlichen Decimals unterstützt (6/8/18) — ein
    // einzelner roher Wert wie bei DcaVaultFactory/TriggerVaultFactory (die
    // nur 6-Dezimal-Stablecoins kennen) ließe sich nicht auf denselben
    // Dollar-Betrag (~$0,009 Floor) übertragen. Kein Live-Oracle nötig, da
    // SendVault ohnehin keine Squid-Abhängigkeit hat — der Admin setzt die
    // Floors einmalig pro Token via setMinFee(). Bis dahin ist minFee für ein
    // Token 0 und nur der prozentuale feeBps-Anteil greift.
    //
    // Treasury ist wie bei DcaVaultFactory/TriggerVaultFactory bewusst KEIN
    // separates Wallet, sondern globalKeeper selbst.

    address public admin;
    uint16  public feeBps;
    mapping(address => uint256) public minFeeByToken;

    mapping(address => address[]) public vaultsOf;
    address[] public allVaults;

    // ── Errors ───────────────────────────────────────────────────────────────

    error InvalidAddress();
    error NotAdmin();
    error FeeTooHigh();

    // ── Events ───────────────────────────────────────────────────────────────

    event VaultCreated(address indexed owner, address indexed vault);
    event FeeUpdated(uint16 feeBps);
    event MinFeeUpdated(address indexed token, uint256 minFee);
    event AdminUpdated(address indexed admin);

    // ── Modifier ─────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _vaultImplementation, address _globalKeeper, address _admin) {
        if (
            _vaultImplementation == address(0) ||
            _globalKeeper        == address(0) ||
            _admin                == address(0)
        ) revert InvalidAddress();
        vaultImplementation = _vaultImplementation;
        globalKeeper          = _globalKeeper;
        admin                 = _admin;
        feeBps                = 49; // 0,49 %
    }

    // ── Admin-Funktionen ─────────────────────────────────────────────────────

    function setFee(uint16 _feeBps) external onlyAdmin {
        if (_feeBps > 500) revert FeeTooHigh(); // 5 % Hard-Cap, wie DcaVaultFactory/TriggerVaultFactory
        feeBps = _feeBps;
        emit FeeUpdated(_feeBps);
    }

    // _minFee in der Raw-Einheit von `token` (dessen Decimals) — vom Admin
    // off-chain gegen den aktuellen Kurs auf ~$0,009 berechnet, siehe Hinweis
    // oben. Kein Address(0)-Check auf `token nötig: ein falsch gesetzter
    // minFee für ein nie genutztes Token ist folgenlos.
    function setMinFee(address _token, uint256 _minFee) external onlyAdmin {
        minFeeByToken[_token] = _minFee;
        emit MinFeeUpdated(_token, _minFee);
    }

    function setAdmin(address _admin) external onlyAdmin {
        if (_admin == address(0)) revert InvalidAddress();
        admin = _admin;
        emit AdminUpdated(_admin);
    }

    // ── feeInfo ──────────────────────────────────────────────────────────────

    function feeInfo(address _token) external view returns (uint16 _feeBps, uint256 _minFee, address _treasury) {
        return (feeBps, minFeeByToken[_token], globalKeeper);
    }

    // ── createVault ──────────────────────────────────────────────────────────
    //
    // Clone + initialize() laufen in derselben Transaktion — kein
    // Front-Running-Fenster zwischen Clone-Erzeugung und Initialisierung.

    function createVault() external returns (address vault) {
        vault = Clones.clone(vaultImplementation);
        SendVault(vault).initialize(msg.sender, globalKeeper);

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
