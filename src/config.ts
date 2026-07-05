// Zentrale Konfiguration — Uniswap V4 UniversalRouter Version
// WICHTIG: Token-Adressen vor Produktivbetrieb gegen offizielle Listen prüfen.

export const CELO_CHAIN_ID         = "42220";     // Mainnet
export const CELO_SEPOLIA_CHAIN_ID = "11142220";  // Testnetz

// Aktiv genutzter Chain für Squid und Contract-Calls:
export const ACTIVE_CHAIN_ID: string = CELO_SEPOLIA_CHAIN_ID; // → "42220" für Prod

// ─── UniversalRouter-Adressen ─────────────────────────────────────────────────
// Quelle: docs.celo.org/tooling/contracts/uniswap-contracts
export const UNIVERSAL_ROUTER: Record<"mainnet" | "sepolia", `0x${string}`> = {
  mainnet: "0xcb695bc5d3aa22cad1e6df07801b061a05a0233a",
  sepolia: "0x8891A0A682cC7f0bda7912E79C80167403d96103",
};

// Permit2 ist auf allen EVM-Chains identisch:
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

// ─── Contract ─────────────────────────────────────────────────────────────────
export const VAULT_ADDRESS       = "0x1fe91Bd8e68914Ae1dB5605491FEdDAAF5d30180" as `0x${string}`;
export const SQUID_INTEGRATOR_ID = "minipay-osiris-xxxxxxxx"; // bei Squid beantragen

// ─── Token-Interface ──────────────────────────────────────────────────────────
export interface TokenInfo {
  symbol:      string;
  address:     `0x${string}`;
  decimals:    number;
  poolFee:     number;  // uint24 — Uniswap V4 Fee-Tier
  tickSpacing: number;  // int24  — Standard: 500→10, 3000→60, 10000→200
}

// ─── Input-Stablecoins ────────────────────────────────────────────────────────
// Quellen: Sepolia — docs.celo.org/tooling/contracts/token-contracts
//          Mainnet — Squid /v2/sdk-info (chainId 42220), on-chain gegen name()/symbol()/decimals() verifiziert
const INPUT_TOKENS_BY_CHAIN: Record<"mainnet" | "sepolia", Record<"USDC" | "USDT" | "cUSD", TokenInfo>> = {
  sepolia: {
    USDC: {
      symbol:      "USDC",
      address:     "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
      decimals:    6,
      poolFee:     500,
      tickSpacing: 10,
    },
    USDT: {
      symbol:      "USDT",
      address:     "0xd077A400968890Eacc75cdc901F0356c943e4fDb",
      decimals:    6,
      poolFee:     500,
      tickSpacing: 10,
    },
    cUSD: {
      symbol:      "cUSD",
      address:     "0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80", // Sepolia (USDm)
      decimals:    18,
      poolFee:     500,
      tickSpacing: 10,
    },
  },
  mainnet: {
    USDC: {
      symbol:      "USDC",
      address:     "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      decimals:    6,
      poolFee:     500,
      tickSpacing: 10,
    },
    USDT: {
      symbol:      "USDT",
      address:     "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
      decimals:    6,
      poolFee:     500,
      tickSpacing: 10,
    },
    cUSD: {
      // Celo-Registry "StableToken" liefert dieselbe Adresse wie früher cUSD —
      // der Contract wurde von Mento zu "Mento Dollar" (Symbol USDm) umbenannt.
      symbol:      "cUSD",
      address:     "0x765DE816845861e75A25fCA122bb6898B8B1282a",
      decimals:    18,
      poolFee:     500,
      tickSpacing: 10,
    },
  },
};

export const INPUT_TOKENS = INPUT_TOKENS_BY_CHAIN[ACTIVE_CHAIN_ID === CELO_CHAIN_ID ? "mainnet" : "sepolia"];

// ─── Zieltoken ────────────────────────────────────────────────────────────────
// wBTC, wETH, XAUoT: auf Celo Sepolia nicht nativ vorhanden → Mock-Contracts.
// CELO: gleiche Adresse auf Mainnet und Sepolia (native ERC-20 auf Celo L2).
//
// Mainnet poolFee/tickSpacing gegen USDC via PoolManager/StateView on-chain geprüft
// (0x288dc841A52FCA2707c6947B3A777c5E56cd87BC / 0xbc21f8720BABf4b20D195Ee5c6E99C52B76f2Bfb):
//   CELO/USDC: Pools bei 100/500/3000/10000 initialisiert — 10000 hat mit Abstand die
//              höchste Liquidität (~3.17e14 vs. ~4.02e12/5.09e10/2.2e6) → gewählt.
//   wBTC/USDC: nur bei 3000 initialisiert.
//   wETH/USDC, XAUoT/USDC: KEIN Pool auf einem der vier Standard-Tiers initialisiert
//              (Stand heute) — Werte unten sind Platzhalter, DCA in diese Ziele
//              funktioniert auf Mainnet erst, sobald ein Pool existiert.
const TARGET_TOKENS_BY_CHAIN: Record<"mainnet" | "sepolia", Record<"wBTC" | "wETH" | "CELO" | "XAUoT", TokenInfo>> = {
  sepolia: {
    wBTC: {
      symbol:      "wBTC",
      address:     "0xf6E1161543eFD833595d62fCEb9487E35291B694" as `0x${string}`, // Mock (Celo Sepolia)
      decimals:    8,
      poolFee:     3000,
      tickSpacing: 60,
    },
    wETH: {
      symbol:      "wETH",
      address:     "0x2cE73DC897A3E10b3FF3F86470847c36ddB735cf", // Celo Sepolia offiziell
      decimals:    18,
      poolFee:     3000,
      tickSpacing: 60,
    },
    CELO: {
      symbol:      "CELO",
      address:     "0x471EcE3750Da237f93B8E339c536989b8978a438", // Mainnet + Sepolia identisch
      decimals:    18,
      poolFee:     3000,
      tickSpacing: 60,
    },
    XAUoT: {
      symbol:      "XAUoT",
      address:     "0x849Dec442B1026CA8b8BBf3bA0b94A6baD6Bd3Eb" as `0x${string}`, // Mock (Celo Sepolia)
      decimals:    6,
      poolFee:     10000,
      tickSpacing: 200,
    },
  },
  mainnet: {
    wBTC: {
      symbol:      "wBTC",
      address:     "0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D", // Wrapped BTC (Celo native bridge)
      decimals:    8,
      poolFee:     3000, // einziger initialisierte Fee-Tier gegen USDC
      tickSpacing: 60,
    },
    wETH: {
      symbol:      "wETH",
      address:     "0xD221812de1BD094f35587EE8E174B07B6167D9Af", // Wrapped Ether (Celo native bridge)
      decimals:    18,
      poolFee:     3000, // Platzhalter — kein V4-Pool gegen USDC initialisiert
      tickSpacing: 60,
    },
    CELO: {
      symbol:      "CELO",
      address:     "0x471EcE3750Da237f93B8E339c536989b8978a438", // Mainnet + Sepolia identisch
      decimals:    18,
      poolFee:     10000, // höchste Liquidität aller initialisierten Tiers
      tickSpacing: 200,
    },
    XAUoT: {
      symbol:      "XAUoT",
      address:     "0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff", // "XAUt0" (Tether Gold) — einziges Gold-Token auf Celo Mainnet
      decimals:    6,
      poolFee:     10000, // Platzhalter — kein V4-Pool gegen USDC initialisiert
      tickSpacing: 200,
    },
  },
};

export const TARGET_TOKENS = TARGET_TOKENS_BY_CHAIN[ACTIVE_CHAIN_ID === CELO_CHAIN_ID ? "mainnet" : "sepolia"];

export const INTERVAL_SECONDS: Record<"daily" | "weekly", number> = {
  daily:  86_400,
  weekly: 604_800,
};
