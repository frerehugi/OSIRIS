// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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

    // Absolute Obergrenze für minFeeByToken, decimals-skaliert: höchstens 5
    // volle Token-Einheiten (ermittelt live über IERC20Metadata.decimals()),
    // analog zu DcaVaultFactory.MAX_MIN_FEE (dort 5 USDC/USDT, 6 Decimals).
    // Da SendVault beliebige MiniPay-Token ohne Preis-Orakel unterstützt,
    // bildet das keinen exakten Dollar-Betrag über alle Token hinweg ab —
    // schützt aber wie dort davor, dass ein Admin minFeeByToken beliebig
    // hoch setzt und eine bereits finanzierte Auszahlungstranche faktisch
    // konfisziert.
    uint256 public constant MAX_MIN_FEE_WHOLE_UNITS = 5;

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
    //
    // globalKeeper ist NICHT mehr immutable (siehe setGlobalKeeper()) —
    // gleiche Begründung wie DcaVaultFactory: neue Vaults übernehmen ihn bei
    // initialize(), bestehende Vaults bleiben unberührt auf ihrem
    // eingefrorenen Keeper (owner-eigenes setKeeper() bleibt Recovery-Pfad).

    address public admin;
    address public globalKeeper;
    uint16  public feeBps;
    mapping(address => uint256) public minFeeByToken;

    mapping(address => address[]) public vaultsOf;
    address[] public allVaults;

    // ── Errors ───────────────────────────────────────────────────────────────

    error InvalidAddress();
    error NotAdmin();
    error FeeTooHigh();
    error MinFeeTooHigh();

    // ── Events ───────────────────────────────────────────────────────────────

    event VaultCreated(address indexed owner, address indexed vault);
    event FeeUpdated(uint16 feeBps);
    event MinFeeUpdated(address indexed token, uint256 minFee);
    event AdminUpdated(address indexed admin);
    event GlobalKeeperUpdated(address indexed globalKeeper);

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
    // minFee für ein nie genutztes Token ist folgenlos. Decimals werden live
    // abgefragt, um den Cap zu skalieren (siehe MAX_MIN_FEE_WHOLE_UNITS) —
    // bewusst NICHT als Pflicht-Call: ein Token ohne Code (z.B. eine
    // Platzhalter-Adresse für einen noch nicht gelisteten Token) darf
    // weiterhin konfiguriert werden, nur eben ohne den zusätzlichen Cap.
    //
    // extcodesize-Check VOR dem Call, nicht nur try/catch: ein Call auf eine
    // Adresse ohne Code liefert leere Returndata zurück (EVM-Verhalten, kein
    // Solidity-Fehler) — der anschließende ABI-Decode-Versuch auf `uint8`
    // schlägt zwar fehl, das wird aber NICHT von einem bloßen `catch {}`
    // abgefangen (in dieser Konfiguration empirisch mit Foundry verifiziert),
    // sondern reißt den gesamten Aufruf unkontrolliert ab. Der Guard hier
    // verhindert den Call für code-lose Adressen von vornherein; try/catch
    // bleibt als Absicherung für Tokens mit Code, deren decimals() aus
    // anderen Gründen revertiert oder fehlt.
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
