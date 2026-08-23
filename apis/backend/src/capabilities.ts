// Capability-Schema — maschinenlesbare Beschreibung dessen, was OSIRIS/Squid
// und Apis' eigener ConditionalSellOrder-Contract können (siehe Gesamtplan §8).
// Rein statische Daten, reuse der bestehenden OSIRIS-Token-Konfiguration statt
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

    sellOrder: {
      description: 'Conditional, keeper-executed sell order on Apis’s own ConditionalSellOrder contract. Works on any held token, not only ones bought via OSIRIS.',
      feeBps: 99,
      typicalMaxExecutions: 1,
      note: 'Price conditions are evaluated off-chain by the Apis keeper (soft trigger) — the contract itself has no oracle.',
    },

    priceSources: [
      { id: 'mento-sorted-oracles', label: 'Mento SortedOracles', onChain: true,  covers: ['CELO', 'wETH', 'XAUoT'] },
      { id: 'redstone',             label: 'RedStone',            onChain: false, covers: ['XAUoT', 'wBTC'] },
      { id: 'squid-token-price',    label: 'Squid /token-price',  onChain: false, covers: ['wBTC', 'wETH', 'CELO', 'XAUoT'] },
    ],

    accessGrant: {
      scopes: ['read', 'propose'],
      maxDurationDays: 30,
      note: 'Grants never include execution rights — every plan still requires the user’s own confirmation in MiniPay.',
    },
  };
}
