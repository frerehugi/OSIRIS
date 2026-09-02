// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TriggerVault} from "./TriggerVault.sol";

// minFee ist PRO heldToken gesetzt (minFeeByToken), nicht mehr ein einzelner
// globaler Wert — Plan 4 Befund A. Der vorherige einzelne Skalar ging von
// 6-Dezimal-Stablecoins aus, wurde aber unverändert auch für Sell-Pläne
// verwendet, deren heldToken das Krypto-Zieltoken ist (wBTC=8, wETH/CELO=18,
// XAUoT=6 Dezimalstellen) — 35_000 raw bei wBTC sind 0,00035 wBTC, bei einem
// Verkauf von 0,001 wBTC also 35 % Gebühr trotz nominell 0,99 % feeBps.
// Gleiches Muster wie SendVaultFactory.minFeeByToken (dortige Begründung
// gilt identisch: kein Preis-Orakel verfügbar, daher zwangsläufig
// admin-kalibrierte Werte pro Token statt einer echten USD-Automatik).

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

    // Absolute Obergrenze für minFeeByToken, decimals-skaliert: höchstens 5
    // volle Token-Einheiten (live via IERC20Metadata.decimals() ermittelt),
    // identisches Muster und identische Restrisiko-Begründung wie
    // SendVaultFactory.MAX_MIN_FEE_WHOLE_UNITS (dort siehe Kommentar) — für
    // ein teures Token wie wBTC bildet das keinen exakten, engen
    // Dollar-Betrag ab, ist aber strikt besser als der vorherige komplett
    // unbegrenzte globale Skalar.
    uint256 public constant MAX_MIN_FEE_WHOLE_UNITS = 5;

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
    mapping(address => uint256) public minFeeByToken;
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
    error ArrayLengthMismatch();

    // ── Events ───────────────────────────────────────────────────────────────

    event VaultCreated(address indexed owner, address indexed vault);
    event FeeUpdated(uint16 feeBps);
    event MinFeeUpdated(address indexed token, uint256 minFee);
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
    // feeBps startet identisch zu ConditionalSellOrder/OSIRIS-Floor (99 bps).
    //
    // _initialStablecoins wird ATOMAR im selben Deploy freigeschaltet, statt
    // den Admin auf einen separaten setStablecoin()-Aufruf nach dem Deploy zu
    // verweisen: läuft _admin bereits auf dem Phase-A-Timelock (empfohlen,
    // siehe DeployTriggerVaultFactory.s.sol), bräuchte ein nachträglicher
    // setStablecoin()-Aufruf den vollen 48h-Zyklus — die frisch deployte
    // Factory wäre bis dahin für JEDES setupPlan() unbenutzbar
    // (StablecoinRequired(), siehe TriggerVault.setupPlan()). Kein
    // Address(0)-Check auf die Liste nötig — address(0) würde ohnehin nie als
    // heldToken/outputToken akzeptiert (siehe TriggerVault.setupPlan()).
    //
    // _minFeeTokens/_minFeeValues seeden minFeeByToken für jedes heute
    // mögliche heldToken (Buy: USDC/USDT; Sell: wBTC/wETH/CELO/XAUoT) —
    // gleicher Atomaritäts-Grund wie bei _initialStablecoins: ohne Seeding
    // wäre minFeeByToken für jedes Token bis zum ersten (48h-verzögerten)
    // setMinFee()-Aufruf einfach 0 (kein Fehler, nur unbeabsichtigt niedrig).
    // Parallele Arrays statt eines Structs — gleiches simples Muster wie
    // _initialStablecoins.

    constructor(
        address _vaultImplementation,
        address _squidRouter,
        address _globalKeeper,
        address _admin,
        address[] memory _initialStablecoins,
        address[] memory _minFeeTokens,
        uint256[] memory _minFeeValues
    ) {
        if (
            _vaultImplementation == address(0) ||
            _squidRouter         == address(0) ||
            _globalKeeper        == address(0) ||
            _admin               == address(0)
        ) revert InvalidAddress();
        if (_minFeeTokens.length != _minFeeValues.length) revert ArrayLengthMismatch();
        vaultImplementation = _vaultImplementation;
        squidRouter          = _squidRouter;
        globalKeeper          = _globalKeeper;
        admin                 = _admin;
        feeBps                = 99;
        maxSlippageBps         = 200; // 2 % Default-Toleranz für den Slippage-Floor

        for (uint256 i = 0; i < _initialStablecoins.length; ) {
            isStablecoin[_initialStablecoins[i]] = true;
            emit StablecoinUpdated(_initialStablecoins[i], true);
            unchecked { ++i; }
        }

        for (uint256 i = 0; i < _minFeeTokens.length; ) {
            minFeeByToken[_minFeeTokens[i]] = _minFeeValues[i];
            emit MinFeeUpdated(_minFeeTokens[i], _minFeeValues[i]);
            unchecked { ++i; }
        }
    }

    // ── Admin-Funktionen ─────────────────────────────────────────────────────

    function setFee(uint16 _feeBps) external onlyAdmin {
        if (_feeBps > 500) revert FeeTooHigh(); // 5 % Hard-Cap
        feeBps = _feeBps;
        emit FeeUpdated(_feeBps);
    }

    // _minFee in der Raw-Einheit von `_token` (dessen Decimals) — vom Admin
    // off-chain gegen den aktuellen Kurs kalibriert (kein Preis-Orakel
    // verfügbar, siehe Kommentar oben). Identisches Guard-Muster wie
    // SendVaultFactory.setMinFee(): extcodesize-Check VOR dem Call, nicht nur
    // try/catch — ein Call auf eine Adresse ohne Code liefert leere
    // Returndata zurück (EVM-Verhalten), der anschließende ABI-Decode auf
    // `uint8` schlägt fehl, wird aber NICHT von einem bloßen `catch {}`
    // abgefangen (empirisch mit Foundry verifiziert, siehe SendVaultFactory).
    function setMinFee(address _token, uint256 _minFee) external onlyAdmin {
        uint256 codeSize;
        assembly { codeSize := extcodesize(_token) }
        if (codeSize > 0) {
            try IERC20Metadata(_token).decimals() returns (uint8 decimals) {
                if (_minFee > MAX_MIN_FEE_WHOLE_UNITS * (10 ** decimals)) revert MinFeeTooHigh();
            } catch {
                // decimals() nicht verfügbar — Cap kann nicht skaliert werden,
                // wird für dieses Token übersprungen.
            }
        }
        minFeeByToken[_token] = _minFee;
        emit MinFeeUpdated(_token, _minFee);
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
    //
    // Signatur (No-Arg, 3-Tupel) bewusst UNVERÄNDERT gelassen, obwohl minFee
    // jetzt pro Token gilt (minFeeByToken) — der Keeper liest diese Funktion
    // per fixer, positionsbasierter ABI (`TRIGGER_VAULT_FACTORY_ABI`,
    // `keeper/squidKeeper.ts`) als Fallback für Vaults ohne Fee-Snapshot
    // (Gen-1, vor B3). Eine geänderte Tupel-Form (Anzahl/Reihenfolge) würde
    // dort still falsch decodieren, ohne dass ein Test das hier auffangen
    // könnte. Der mittlere Rückgabewert ist daher bewusst nur noch ein
    // Platzhalter (`0`) — echte Werte kommen für neue Pläne ausschließlich
    // aus minFeeByToken(heldToken), siehe TriggerVault.setupPlan().
    function feeInfo() external view returns (uint16 _feeBps, uint256 _minFee, address _treasury) {
        return (feeBps, 0, globalKeeper);
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
