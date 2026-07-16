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
export const SQUID_INTEGRATOR_ID = "minipay-osiris-xxxxxxxx"; // bei Squid beantragen

// ─── Factory (EIP-1167-Clones) ────────────────────────────────────────────────
export const FACTORY_ADDRESS               = "0x28f5E38C41F2cDB6D436972df5F3F42bD40Ed411" as `0x${string}`;
export const VAULT_IMPLEMENTATION_ADDRESS  = "0x83cf517d752D8eB449BEBE12201885AC088318Fc" as `0x${string}`;

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
