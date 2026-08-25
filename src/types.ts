// Gemeinsame Typen für Frontend und Wallet-Integration.
// DcaPlanState spiegelt den Formular-State aus dem React-Frontend wider.

export const TOKENS = ['wBTC', 'wETH', 'CELO', 'XAUoT'] as const;
export type TokenType = (typeof TOKENS)[number];
export type TokenPercentages = Record<TokenType, number>;

export const INPUT_TOKENS_KEYS = ['USDC', 'USDT', 'cUSD'] as const;
export type InputToken = (typeof INPUT_TOKENS_KEYS)[number];

export type Interval = 'hourly' | 'daily' | 'weekly';

export const WEEKDAYS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday',
  'Friday', 'Saturday', 'Sunday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface DcaPlanState {
  step:          number;
  interval:      Interval | null;
  totalAmount:   string;
  inputToken:    InputToken;
  percentages:   TokenPercentages;
  duration:      string;
  executionTime: string;
  executionDay:  Weekday;
  timezone:      string;
}

// ─── Trigger-Plan (Price-Trigger-Erweiterung, siehe TriggerVault.sol) ──────────

export type TriggerDirection = 'buy' | 'sell';
export type TimeLimit = '1d' | '1w' | '1m' | 'none';

export const TIME_LIMIT_SECONDS: Record<TimeLimit, number> = {
  '1d': 86_400, '1w': 604_800, '1m': 2_592_000, none: 0,
};

export const TIME_LIMIT_LABEL: Record<TimeLimit, string> = {
  '1d': '1 day', '1w': '1 week', '1m': '1 month', none: 'No limit',
};

export interface TriggerPlanState {
  direction:    TriggerDirection;
  cryptoSymbol: TokenType;
  stableSymbol: InputToken;
  priceUsd:     string;
  amountHuman:  string; // Buy: USDC/USDT-Betrag; Sell: Krypto-Menge (aus dem Schieberegler)
  timeLimit:    TimeLimit;
}
