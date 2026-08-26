// Token-Icon-Farben/-Symbole — 1:1 aus OSIRIS' echtem src/App.tsx übernommen
// (TOKEN_COLOR/TOKEN_ICONS/TOKEN_ICON_TEXT dort), damit APIS' Token-Badges
// exakt so aussehen wie OSIRIS' eigene — "APIS als Bruder von OSIRIS
// erkennbar" (siehe Chat). USDC/USDT kommen in OSIRIS' eigener Badge-Map
// nicht vor (dort nie als Icon dargestellt) — hier ergänzt um die jeweils
// offizielle Markenfarbe (Circle-Blau/Tether-Grün), gleiches Muster wie die
// vier bestehenden Einträge.

import type { INPUT_TOKENS, TARGET_TOKENS } from './config';

export type AnyTokenSymbol = keyof typeof TARGET_TOKENS | keyof typeof INPUT_TOKENS;

// cUSD ist Teil des Record-Typs (INPUT_TOKENS deckt beide Chains ab, siehe
// src/config.ts), taucht aber in APIS' UI nirgends auf — Mainnet-INPUT_TOKENS
// hat kein cUSD. Eintrag nur für Typ-Vollständigkeit, mit Celos echter
// Markenfarbe.
export const TOKEN_ICON: Record<AnyTokenSymbol, string> = {
  wBTC: '₿', wETH: 'Ξ', CELO: 'C', XAUoT: '🥇', USDC: '$', USDT: 'T', cUSD: '$',
};

export const TOKEN_COLOR: Record<AnyTokenSymbol, string> = {
  wBTC: '#F7931A', wETH: '#627EEA', CELO: '#FCFF52', XAUoT: 'var(--gold)',
  USDC: '#2775CA', USDT: '#26A17B', cUSD: '#35D07F',
};

// Textfarbe im Icon-Kreis — auf hellen Untergründen (Celo-Gelb, Gold) dunkler
// statt weißer Text, exakt wie in OSIRIS' TOKEN_ICON_TEXT.
export const TOKEN_ICON_TEXT: Record<AnyTokenSymbol, string> = {
  wBTC: '#ffffff', wETH: '#ffffff', CELO: 'var(--dark2)', XAUoT: 'var(--dark2)',
  USDC: '#ffffff', USDT: '#ffffff', cUSD: '#ffffff',
};
