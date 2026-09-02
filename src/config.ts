// Zentrale Konfiguration — Squid-Router-Architektur
// WICHTIG: Token-Adressen vor Produktivbetrieb gegen offizielle Listen prüfen.

export const CELO_CHAIN_ID         = "42220";     // Mainnet
export const CELO_SEPOLIA_CHAIN_ID = "11142220";  // Testnetz

// Aktiv genutzter Chain für Squid und Contract-Calls:
export const ACTIVE_CHAIN_ID: string = CELO_CHAIN_ID; // Mainnet-Deploy in Vorbereitung

// ─── Squid-Router ─────────────────────────────────────────────────────────────
// Quelle: Squid /v2/sdk-info, chains[].squidContracts.squidRouter (chainId 42220).
// On-chain verifiziert (enthält Contract-Code auf Celo Mainnet). Muss vor der
// ersten Nutzung per DcaVault.setRouter() freigegeben werden.
// Squid unterstützt Celo Sepolia (11142220) nicht — nur Mainnet, deshalb keine
// separate Sepolia-Adresse.
export const SQUID_ROUTER_MAINNET = "0xce16F69375520ab01377ce7B88f5BA8C48F8D666" as `0x${string}`;

// ─── Contract ─────────────────────────────────────────────────────────────────
//
// VAULT_ADDRESS: der ERSTE, vor der Factory direkt deployte Vault (läuft
// weiter bis alle 5 Tranchen ausgeführt sind — bewusst NICHT über die Factory
// nachgezogen, siehe keeper/squidKeeper.ts). Neue Pläne entstehen ab jetzt
// ausschließlich über FACTORY_ADDRESS.createVault().
export const VAULT_ADDRESS       = "0x22541bDAf712920330F2d0FC26D1Ac807e914FDc" as `0x${string}`;
export const SQUID_INTEGRATOR_ID = "osiris-4467319c-aa33-4ae8-86ff-cd0cb431033f";

// ─── Factory (EIP-1167-Clones) ────────────────────────────────────────────────
//
// Plan 2 B1 (Fee-Snapshot + minFee-Cap + setGlobalKeeper()): neue Factory +
// Implementation deployt + auf Celoscan verifiziert am 31.08.2026. Alte
// Factory bleibt als OLD_FACTORY_ADDRESS erhalten (bereits laufende Pläne
// dort sind von B1 nicht betroffen, siehe SECURITY.md) — OLD_FACTORY_ADDRESS
// selbst rückt dafür eine Generation weiter (die davor war bereits abgelöst).
export const FACTORY_ADDRESS               = "0xa6B66110b3593B5D32f4229CA5398611959149C5" as `0x${string}`;
export const OLD_FACTORY_ADDRESS            = "0xba148255d757912442A97f87c50DD2F65FBab7E0" as `0x${string}`;
export const VAULT_IMPLEMENTATION_ADDRESS  = "0x02213a74a725C15EBbbC1212777b5b20C73B01E8" as `0x${string}`;

// Diese Migration ist bereits die ZWEITE für DcaVaultFactory (nach dem
// ursprünglichen Gebühren-Mechanismus-Deploy) — mit nur FACTORY_ADDRESS/
// OLD_FACTORY_ADDRESS (2 Slots) würde die allererste Generation
// (0x28f5E38C..., wo laut minipayWallet.ts/plans.ts bereits vor B1 noch
// aktive Pläne lagen) beim nächsten Rotieren komplett aus der App
// verschwinden — kein Fund-Loss, aber ein Nutzer sähe seinen laufenden Plan
// plötzlich nicht mehr. ALL_FACTORY_ADDRESSES trägt deshalb JEDE bekannte
// Generation (älteste zuerst); getUserVaults() (minipayWallet.ts) und
// readDcaVaults() (apis/backend/src/plans.ts) fragen ab jetzt diese Liste ab
// statt nur zwei Adressen. Bei der nächsten Migration hier ergänzen, nie
// ersetzen.
export const ALL_FACTORY_ADDRESSES: readonly `0x${string}`[] = [
  "0x28f5E38C41F2cDB6D436972df5F3F42bD40Ed411", // Generation 1 (ursprünglicher Gebühren-Mechanismus-Deploy)
  "0xba148255d757912442A97f87c50DD2F65FBab7E0", // Generation 2 (= OLD_FACTORY_ADDRESS oben)
  "0xa6B66110b3593B5D32f4229CA5398611959149C5", // Generation 3 (Plan 2 B1, aktuell = FACTORY_ADDRESS oben)
];

// TriggerVaultFactory — Price-Trigger-Erweiterung neben DcaVaultFactory
// (siehe script/DeployTriggerVaultFactory.s.sol).
//
// Plan 4 Befund A (per-Token, dezimalstellen-bewusstes minFeeByToken statt
// eines globalen Skalars): neue Factory + Implementation deployt +
// verifiziert am 02.09.2026 (TriggerVault-Implementation:
// 0x741Fad235EC4808c8C06279b1D1c8E578fc6A635). Alte Factories bleiben in
// ALL_TRIGGER_VAULT_FACTORY_ADDRESSES erhalten — dort bereits laufende
// Pläne behalten ihre alte, nicht dezimalstellen-skalierte minFee-Regel
// (siehe SECURITY.md).
export const TRIGGER_VAULT_FACTORY_ADDRESS = "0xE19f7267A7F4CC7a4e4c6fc6967d2B5F25Ab09ed" as `0x${string}`;
export const OLD_TRIGGER_VAULT_FACTORY_ADDRESS = "0xeD39de472baEE17e6Ce05a0A4A0515eb4DF98a97" as `0x${string}`;

// ALL_TRIGGER_VAULT_FACTORY_ADDRESSES trägt JEDE bekannte Generation (älteste
// zuerst) — genau der Fall, für den diese Liste in Plan 4 von Anfang an als
// wachsende Liste angelegt wurde, statt wieder nur zwei benannte Slots (die
// beim zweiten DCA-Wechsel schon einmal gebrochen sind). getUserTriggerVaults()
// (minipayWallet.ts), readTriggerVaults() (apis/backend/src/plans.ts) und
// usePlans.ts fragen diese Liste ab, nicht die beiden Konstanten einzeln. Bei
// der nächsten Migration hier ergänzen, nie ersetzen.
export const ALL_TRIGGER_VAULT_FACTORY_ADDRESSES: readonly `0x${string}`[] = [
  OLD_TRIGGER_VAULT_FACTORY_ADDRESS,             // Generation 1 (vor Plan 2 B3, kein Fee-Snapshot/Slippage-Floor)
  "0x4398Cdd2AF617Bc36adBdF8a2BC60095535Bc625",  // Generation 2 (Plan 2 B3 — Fee-Snapshot/Slippage-Floor, globaler minFee-Skalar)
  TRIGGER_VAULT_FACTORY_ADDRESS,                 // Generation 3 (Plan 4 Befund A, aktuell — per-Token minFeeByToken)
];

// SendVaultFactory — Auszahlungs-Erweiterung neben DcaVaultFactory/
// TriggerVaultFactory.
//
// Plan 2 B2 (Fee-Snapshot + minFee-Cap + setGlobalKeeper()): neue Factory +
// Implementation deployt + verifiziert am 31.08.2026 (SendVault-
// Implementation: 0x2de1279b086cC0c642B8CFdbb702e014a81605d). Alte Factory
// bleibt als OLD_SEND_VAULT_FACTORY_ADDRESS erhalten.
export const SEND_VAULT_FACTORY_ADDRESS = "0x4d63381b9b742683b92971d672018Ec5d82DA002" as `0x${string}`;
export const OLD_SEND_VAULT_FACTORY_ADDRESS = "0x1d7a157Bb1823482039B4B3037fb1737B1F2750A" as `0x${string}`;

// ─── Token-Interface ──────────────────────────────────────────────────────────
export interface TokenInfo {
  symbol:   string;
  address:  `0x${string}`;
  decimals: number;
}

// ─── Input-Stablecoins ────────────────────────────────────────────────────────
// Quellen: Sepolia — docs.celo.org/tooling/contracts/token-contracts
//          Mainnet — Squid /v2/sdk-info (chainId 42220), on-chain gegen name()/symbol()/decimals() verifiziert
const INPUT_TOKENS_BY_CHAIN: Record<"mainnet" | "sepolia", Record<"USDC" | "USDT" | "cUSD", TokenInfo>> = {
  sepolia: {
    USDC: {
      symbol:  "USDC",
      address: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
      decimals: 6,
    },
    USDT: {
      symbol:  "USDT",
      address: "0xd077A400968890Eacc75cdc901F0356c943e4fDb",
      decimals: 6,
    },
    cUSD: {
      symbol:  "cUSD",
      address: "0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80", // Sepolia (USDm)
      decimals: 18,
    },
  },
  mainnet: {
    USDC: {
      symbol:  "USDC",
      address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      decimals: 6,
    },
    USDT: {
      symbol:  "USDT",
      address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
      decimals: 6,
    },
    cUSD: {
      // Celo-Registry "StableToken" liefert dieselbe Adresse wie früher cUSD —
      // der Contract wurde von Mento zu "Mento Dollar" (Symbol USDm) umbenannt.
      // ACHTUNG: Von Squid aktuell nicht für Routing unterstützt (weder als
      // "cUSD" noch als "USDm" in /v2/sdk-info für Celo Mainnet auffindbar) —
      // als Input-Token auf Mainnet vorerst nicht nutzbar, bis Squid es listet.
      symbol:  "cUSD",
      address: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
      decimals: 18,
    },
  },
};

export const INPUT_TOKENS = INPUT_TOKENS_BY_CHAIN[ACTIVE_CHAIN_ID === CELO_CHAIN_ID ? "mainnet" : "sepolia"];

// ─── Zieltoken ────────────────────────────────────────────────────────────────
// wBTC, wETH, XAUoT: auf Celo Sepolia nicht nativ vorhanden → Mock-Contracts.
// CELO: gleiche Adresse auf Mainnet und Sepolia (native ERC-20 auf Celo L2).
// Fee-Tier/Pool-Auswahl ist seit dem Umstieg auf Squid-Routing (statt direktem
// Uniswap-V4-Call) nicht mehr Sache des Contracts/Frontends — Squid wählt die
// Route selbst über beliebige DEXs.
const TARGET_TOKENS_BY_CHAIN: Record<"mainnet" | "sepolia", Record<"wBTC" | "wETH" | "CELO" | "XAUoT", TokenInfo>> = {
  sepolia: {
    wBTC: {
      symbol:  "wBTC",
      address: "0xf6E1161543eFD833595d62fCEb9487E35291B694" as `0x${string}`, // Mock (Celo Sepolia)
      decimals: 8,
    },
    wETH: {
      symbol:  "wETH",
      address: "0x2cE73DC897A3E10b3FF3F86470847c36ddB735cf", // Celo Sepolia offiziell
      decimals: 18,
    },
    CELO: {
      symbol:  "CELO",
      address: "0x471EcE3750Da237f93B8E339c536989b8978a438", // Mainnet + Sepolia identisch
      decimals: 18,
    },
    XAUoT: {
      symbol:  "XAUoT",
      address: "0x849Dec442B1026CA8b8BBf3bA0b94A6baD6Bd3Eb" as `0x${string}`, // Mock (Celo Sepolia)
      decimals: 6,
    },
  },
  mainnet: {
    wBTC: {
      symbol:  "wBTC",
      address: "0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D", // Wrapped BTC (Celo native bridge)
      decimals: 8,
    },
    wETH: {
      symbol:  "wETH",
      address: "0xD221812de1BD094f35587EE8E174B07B6167D9Af", // Wrapped Ether (Celo native bridge)
      decimals: 18,
    },
    CELO: {
      symbol:  "CELO",
      address: "0x471EcE3750Da237f93B8E339c536989b8978a438", // Mainnet + Sepolia identisch
      decimals: 18,
    },
    XAUoT: {
      symbol:  "XAUoT",
      address: "0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff", // "XAUt0" (Tether Gold) — einziges Gold-Token auf Celo Mainnet
      decimals: 6,
    },
  },
};

export const TARGET_TOKENS = TARGET_TOKENS_BY_CHAIN[ACTIVE_CHAIN_ID === CELO_CHAIN_ID ? "mainnet" : "sepolia"];

export const INTERVAL_SECONDS: Record<"hourly" | "daily" | "weekly", number> = {
  hourly: 3_600,
  daily:  86_400,
  weekly: 604_800,
};
