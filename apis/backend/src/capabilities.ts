// Capability-Schema — maschinenlesbare Beschreibung dessen, was OSIRIS/Squid
// und APIS' eigener TriggerVault-Contract können (siehe Gesamtplan §8). Rein
// statische Daten, reuse der bestehenden OSIRIS-Token-Konfiguration statt
// einer zweiten, potenziell abweichenden Kopie (gleiches Prinzip wie in
// apis/app/src/config.ts).

import { INPUT_TOKENS, TARGET_TOKENS } from '../../../src/config';

export function buildCapabilities() {
  return {
    network: { chainId: 42220, name: 'Celo Mainnet' },

    inputTokens: [
      { symbol: INPUT_TOKENS.USDC.symbol, address: INPUT_TOKENS.USDC.address, decimals: INPUT_TOKENS.USDC.decimals },
      { symbol: INPUT_TOKENS.USDT.symbol, address: INPUT_TOKENS.USDT.address, decimals: INPUT_TOKENS.USDT.decimals },
    ],

    targetTokens: [
      { symbol: TARGET_TOKENS.wBTC.symbol,  address: TARGET_TOKENS.wBTC.address,  decimals: TARGET_TOKENS.wBTC.decimals },
      { symbol: TARGET_TOKENS.wETH.symbol,  address: TARGET_TOKENS.wETH.address,  decimals: TARGET_TOKENS.wETH.decimals },
      { symbol: TARGET_TOKENS.CELO.symbol,  address: TARGET_TOKENS.CELO.address,  decimals: TARGET_TOKENS.CELO.decimals },
      { symbol: TARGET_TOKENS.XAUoT.symbol, address: TARGET_TOKENS.XAUoT.address, decimals: TARGET_TOKENS.XAUoT.decimals },
    ],

    dcaPlan: {
      description: 'Buy-only, time-scheduled plan on the existing, unmodified OSIRIS DcaVault contract.',
      maxTargets: 10,
      intervals: ['hourly', 'daily', 'weekly'],
      feeBps: 99,
      note: 'Fee is charged by the OSIRIS contract itself on every execution, independent of who calls it.',
    },

    triggerSellPlan: {
      description: 'A single-price, keeper-executed take-profit sell, escrowed for real in its own OSIRIS TriggerVault clone. Works on any held token, not only ones bought via OSIRIS.',
      feeBps: 99,
      direction: 'take-profit only — sells once the price is at or above the trigger price.',
      timeLimits: ['1d', '1w', '1m', 'none'],
      note: "The trigger price is evaluated off-chain by OSIRIS' shared keeper (soft trigger, same one that executes DCA tranches) — the contract itself has no oracle. Cancellable any time regardless of the time limit; a cancelled or expired-unexecuted plan returns the full escrowed amount to the owner.",
    },

    // Einzige tatsächlich verwendete Quelle — muss mit getTokenPriceUsd() in
    // keeper/squidKeeper.ts übereinstimmen. Mento SortedOracles/RedStone
    // standen hier früher als weitere Optionen, wurden aber nie verdrahtet
    // (siehe Kommentar dort: pragmatische V1-Entscheidung, eine einheitliche
    // Quelle statt pro-Token-Feed-IDs ohne Live-Verifikation) — der Eintrag
    // hier hätte der KI fälschlich Quellenvielfalt vorgegaukelt, die es nicht gibt.
    priceSources: [
      { id: 'squid-token-price', label: 'Squid /v2/token-price', onChain: false, covers: ['wBTC', 'wETH', 'CELO', 'XAUoT'] },
    ],

    accessGrant: {
      scopes: ['read', 'propose'],
      maxDurationDays: 30,
      note: 'Grants never include execution rights — every plan still requires the user’s own confirmation in MiniPay.',
    },
  };
}
