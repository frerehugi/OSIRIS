// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {TriggerVault} from "./TriggerVault.sol";

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
    address public immutable globalKeeper;

    // ── State ─────────────────────────────────────────────────────────────────
    //
    // Gebühr pro execute(): feeBps auf den verwahrten Betrag, mindestens
    // minFee. Treasury ist wie bei DcaVaultFactory bewusst KEIN separates
    // Wallet, sondern globalKeeper selbst — deckt dessen Gas-Kosten direkt.

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
