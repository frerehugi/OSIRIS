// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {TriggerVault} from "./TriggerVault.sol";

// Absolute Obergrenze für minFee, gleiches Prinzip wie DcaVaultFactory.
// MAX_MIN_FEE (siehe dort) — geht ebenfalls von 6-Dezimal-Stablecoins aus.
// Vorbestehende Einschränkung, hier nicht neu eingeführt: minFee ist bei
// TriggerVaultFactory (anders als SendVaultFactory) ein einzelner globaler
// Wert, wird aber je nach Plan-Richtung auf heldToken erhoben — das kann
// auch ein 8/18-Dezimal-Zieltoken sein (Sell-Plan). Der Cap ist trotzdem
// wirksam als Obergrenze in Roheinheiten, auch wenn er für 18-Dezimal-Token
// nicht exakt denselben Dollar-Betrag abbildet wie für 6-Dezimal-Stablecoins.

/// @notice Erzeugt für jeden Buy-/Sell-Trigger-Plan einen eigenen TriggerVault
///         als günstigen EIP-1167-Minimal-Proxy-Clone — identisches Muster wie
///         DcaVaultFactory, nur für einmalige preisgetriggerte Swaps statt
///         wiederkehrender DCA-Tranchen (siehe TriggerVault.sol).
///
/// @dev    Bewusst KEIN createVaultAndSetupPlan(), aus demselben Grund wie bei
///         DcaVaultFactory: setupPlan() zieht den Betrag per safeTransferFrom
///         vom Owner, der kann den frisch erzeugten Vault aber erst approven,
///         NACHDEM dessen Adresse bekannt ist. Der Ablauf ist daher bewusst
///         3 Transaktionen: createVault() → token.approve(vault, amount) →
///         vault.setupPlan(...).
contract TriggerVaultFactory {

    // ── Immutables ────────────────────────────────────────────────────────────

    address public immutable vaultImplementation;
    address public immutable squidRouter;

    uint256 public constant MAX_MIN_FEE = 5_000_000; // 5 USDC/USDT-Äquivalent (6 Decimals), siehe Kommentar oben

    // Obergrenze für setMaxSlippageBps() — 20 % ist bereits eine sehr
    // großzügige Toleranz für den On-Chain-Slippage-Floor (siehe
    // TriggerVault._slippageFloor()); verhindert, dass der Floor durch einen
    // extremen Wert faktisch wirkungslos gemacht wird.
    uint16 public constant MAX_SLIPPAGE_BPS_CAP = 2_000; // 20 %

    // ── State ─────────────────────────────────────────────────────────────────
    //
    // Gebühr pro execute(): feeBps auf den verwahrten Betrag, mindestens
    // minFee. Treasury ist wie bei DcaVaultFactory bewusst KEIN separates
    // Wallet, sondern globalKeeper selbst — deckt dessen Gas-Kosten direkt.
    //
    // globalKeeper ist NICHT mehr immutable (siehe setGlobalKeeper(), gleiche
    // Begründung wie DcaVaultFactory). isStablecoin/maxSlippageBps sind neu
    // für den On-Chain-Slippage-Floor (siehe TriggerVault.setupPlan()/
    // execute()) — beide hinter onlyAdmin, damit hinter dem Phase-A-Timelock.

    address public admin;
    address public globalKeeper;
    uint16  public feeBps;
    uint256 public minFee;
    uint16  public maxSlippageBps;
    mapping(address => bool) public isStablecoin;

    mapping(address => address[]) public vaultsOf;
    address[] public allVaults;

    // ── Errors ───────────────────────────────────────────────────────────────

    error InvalidAddress();
    error NotAdmin();
    error FeeTooHigh();
    error MinFeeTooHigh();
    error SlippageBpsTooHigh();

    // ── Events ───────────────────────────────────────────────────────────────

    event VaultCreated(address indexed owner, address indexed vault);
    event FeeUpdated(uint16 feeBps, uint256 minFee);
    event AdminUpdated(address indexed admin);
    event GlobalKeeperUpdated(address indexed globalKeeper);
    event StablecoinUpdated(address indexed token, bool allowed);
    event MaxSlippageBpsUpdated(uint16 maxSlippageBps);

    // ── Modifier ─────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────
    //
    // feeBps/minFee starten identisch zu ConditionalSellOrder/OSIRIS-Floor
    // (99 bps, 0,035 USDC/USDT bei 6 Decimals = 35_000).

    constructor(address _vaultImplementation, address _squidRouter, address _globalKeeper, address _admin) {
        if (
            _vaultImplementation == address(0) ||
            _squidRouter         == address(0) ||
            _globalKeeper        == address(0) ||
            _admin               == address(0)
        ) revert InvalidAddress();
        vaultImplementation = _vaultImplementation;
        squidRouter          = _squidRouter;
        globalKeeper          = _globalKeeper;
        admin                 = _admin;
        feeBps                = 99;
        minFee                 = 35_000;
        maxSlippageBps         = 200; // 2 % Default-Toleranz für den Slippage-Floor
    }

    // ── Admin-Funktionen ─────────────────────────────────────────────────────

    function setFee(uint16 _feeBps, uint256 _minFee) external onlyAdmin {
        if (_feeBps > 500) revert FeeTooHigh(); // 5 % Hard-Cap
        if (_minFee > MAX_MIN_FEE) revert MinFeeTooHigh();
        feeBps = _feeBps;
        minFee = _minFee;
        emit FeeUpdated(_feeBps, _minFee);
    }

    function setAdmin(address _admin) external onlyAdmin {
        if (_admin == address(0)) revert InvalidAddress();
        admin = _admin;
        emit AdminUpdated(_admin);
    }

    function setGlobalKeeper(address _globalKeeper) external onlyAdmin {
        if (_globalKeeper == address(0)) revert InvalidAddress();
        globalKeeper = _globalKeeper;
        emit GlobalKeeperUpdated(_globalKeeper);
    }

    // Allowlist für das jeweils nicht beobachtete Bein eines Trigger-Plans
    // (siehe TriggerVault.setupPlan()) — ohne echten zweiten Preis-Anker wäre
    // der Slippage-Floor nicht auf einer verlässlichen USD-Basis berechenbar.
    // Kein Address(0)-Check nötig: address(0) würde ohnehin nie als
    // heldToken/outputToken akzeptiert (siehe TriggerVault.setupPlan()).
    function setStablecoin(address token, bool allowed) external onlyAdmin {
        isStablecoin[token] = allowed;
        emit StablecoinUpdated(token, allowed);
    }

    function setMaxSlippageBps(uint16 _maxSlippageBps) external onlyAdmin {
        if (_maxSlippageBps > MAX_SLIPPAGE_BPS_CAP) revert SlippageBpsTooHigh();
        maxSlippageBps = _maxSlippageBps;
        emit MaxSlippageBpsUpdated(_maxSlippageBps);
    }

    // ── feeInfo ──────────────────────────────────────────────────────────────

    function feeInfo() external view returns (uint16 _feeBps, uint256 _minFee, address _treasury) {
        return (feeBps, minFee, globalKeeper);
    }

    // ── createVault ──────────────────────────────────────────────────────────

    function createVault() external returns (address vault) {
        vault = Clones.clone(vaultImplementation);
        TriggerVault(vault).initialize(msg.sender, squidRouter, globalKeeper);

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
