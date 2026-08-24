import type { TARGET_TOKENS, INPUT_TOKENS } from './config';

/// Gemeinsamer Entwurfs-Typ für den Buy-/Sell-Trigger-Flow (siehe Chat) —
/// wird per react-router `state` zwischen CoinSelect → Details → Review
/// weitergereicht (kein Backend/URL-Encoding nötig für einen rein
/// clientseitigen Mehrschritt-Flow).

export type TargetSymbol = keyof typeof TARGET_TOKENS;
export type StableSymbol = keyof typeof INPUT_TOKENS;

export type TimeLimit = '1d' | '1w' | '1m' | 'none';

export const TIME_LIMIT_SECONDS: Record<TimeLimit, number> = {
  '1d': 86_400,
  '1w': 604_800,
  '1m': 2_592_000,
  none: 0,
};

export const TIME_LIMIT_LABEL: Record<TimeLimit, string> = {
  '1d': '1 day', '1w': '1 week', '1m': '1 month', none: 'No limit',
};

export interface TriggerPlanDraft {
  direction:    'buy' | 'sell';
  cryptoSymbol: TargetSymbol;
  stableSymbol: StableSymbol;
  priceUsd:     number;
  amountHuman:  string; // Buy: USDC/USDT-Betrag; Sell: Krypto-Menge (aus dem Schieberegler)
  timeLimit:    TimeLimit;
}
