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
