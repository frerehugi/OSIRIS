// Zentrale Konfiguration — Uniswap V4 UniversalRouter Version
// WICHTIG: Token-Adressen vor Produktivbetrieb gegen offizielle Listen prüfen.

export const CELO_CHAIN_ID         = "42220";     // Mainnet
export const CELO_SEPOLIA_CHAIN_ID = "11142220";  // Testnetz

// Aktiv genutzter Chain für Squid und Contract-Calls:
export const ACTIVE_CHAIN_ID = CELO_SEPOLIA_CHAIN_ID; // → "42220" für Prod

// ─── UniversalRouter-Adressen ─────────────────────────────────────────────────
// Quelle: docs.celo.org/tooling/contracts/uniswap-contracts
export const UNIVERSAL_ROUTER: Record<"mainnet" | "sepolia", `0x${string}`> = {
  mainnet: "0xcb695bc5d3aa22cad1e6df07801b061a05a0233a",
  sepolia: "0x8891A0A682cC7f0bda7912E79C80167403d96103",
};

// Permit2 ist auf allen EVM-Chains identisch:
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

// ─── Contract ─────────────────────────────────────────────────────────────────
export const VAULT_ADDRESS       = "0x..." as `0x${string}`; // nach Deploy eintragen
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
// Celo Sepolia Adressen — Quelle: docs.celo.org/tooling/contracts/token-contracts
export const INPUT_TOKENS: Record<"USDC" | "USDT" | "cUSD", TokenInfo> = {
  USDC: {
    symbol:      "USDC",
    address:     "0x01C5C0122039549AD1493B8220cABEdD739BC44E", // Sepolia
    decimals:    6,
    poolFee:     500,
    tickSpacing: 10,
  },
  USDT: {
    symbol:      "USDT",
    address:     "0xd077A400968890Eacc75cdc901F0356c943e4fDb", // Sepolia
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
};

// ─── Zieltoken ────────────────────────────────────────────────────────────────
// wBTC, wETH, XAUoT: auf Celo Sepolia nicht nativ vorhanden → Mock-Contracts.
// CELO: gleiche Adresse auf Mainnet und Sepolia (native ERC-20 auf Celo L2).
export const TARGET_TOKENS: Record<"wBTC" | "wETH" | "CELO" | "XAUoT", TokenInfo> = {
  wBTC: {
    symbol:      "wBTC",
    address:     "0x0000000000000000000000000000000000bEEF" as `0x${string}`, // TODO: Mock deployen
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
    address:     "0x0000000000000000000000000000000000bEEF" as `0x${string}`, // TODO: Mock deployen
    decimals:    6,
    poolFee:     10000,
    tickSpacing: 200,
  },
};

export const INTERVAL_SECONDS: Record<"daily" | "weekly", number> = {
  daily:  86_400,
  weekly: 604_800,
};
