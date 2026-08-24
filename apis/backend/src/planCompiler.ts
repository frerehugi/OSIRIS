// Plan-Compiler — übersetzt eine im Chat verhandelte Strategie in gültige
// setupPlan()-Parameter (siehe Gesamtplan §8/§9). Validiert vollständig gegen
// die tatsächlichen DcaVault-Contract-Constraints, BEVOR irgendetwas dem User
// zur Bestätigung vorgelegt wird — dieser Worker führt selbst nichts aus, er
// bereitet nur die Transaktion vor, die der User später in MiniPay signiert.

import { parseUnits } from 'viem';
import { INPUT_TOKENS, TARGET_TOKENS } from '../../../src/config';

const MAX_TARGETS = 10;
const BPS_DENOMINATOR = 10_000;

const INTERVAL_SECONDS: Record<string, number> = {
  hourly: 3_600,
  daily:  86_400,
  weekly: 604_800,
};

// Wie TIME_LIMIT_SECONDS in apis/app/src/triggerPlanTypes.ts — eigene Kopie
// statt Cross-Package-Import (siehe Gesamtplan §22, kein Sharing zwischen
// apis/app/backend/keeper).
const TIME_LIMIT_SECONDS: Record<string, number> = {
  '1d': 86_400, '1w': 604_800, '1m': 2_592_000, none: 0,
};

export interface PlanTargetInput {
  token: keyof typeof TARGET_TOKENS;
  bps:   number;
}

export interface PlanDraft {
  owner:       `0x${string}`;
  inputToken:  keyof typeof INPUT_TOKENS;
  totalAmount: string; // human units, e.g. "50.00"
  interval:    'hourly' | 'daily' | 'weekly';
  duration:    number; // Anzahl Tranchen
  targets:     PlanTargetInput[];
}

// Ein Sell-Trigger ist jetzt ein eigener TriggerVault-Plan (siehe
// contracts/TriggerVault.sol, ersetzt das frühere ConditionalSellOrder-
// Bracket aus takeProfitUsd/stopLossUsd) — echtes Escrow statt eines
// Allowance-Pulls, deshalb ein FESTER `amount` statt eines bps-Anteils an
// einem künftigen Bestand. Nur noch Take-Profit (Preis steigt auf/über
// triggerPriceUsd) — Stop-Loss wurde mit dem Umstieg auf Einzel-Preis+
// Zeitlimit gestrichen (siehe Chat: "Ersetzen — nur noch ein Preis +
// Zeitlimit", spiegelt apis/app/src/screens/SellPlanDetails.tsx).
export interface SellTriggerDraft {
  sellToken:       keyof typeof TARGET_TOKENS;
  targetToken:     keyof typeof TARGET_TOKENS | keyof typeof INPUT_TOKENS;
  amount:          string; // human units of sellToken, e.g. "0.05"
  triggerPriceUsd: number; // sell once the price is at or above this
  timeLimit?:      '1d' | '1w' | '1m' | 'none'; // default 'none' (unlimited)
}

export interface CompiledPlan {
  valid: true;
  summary: string;
  setupPlanArgs: {
    inputToken:              `0x${string}`;
    totalAmount:             string; // raw units, als String (JSON kennt kein bigint)
    duration:                number;
    interval:                number; // Sekunden
    firstExecutionTimestamp: number;
    targetTokens:            `0x${string}`[];
    targetBps:                number[];
  };
  // Der optionale angehängte Sell-Trigger, kompiliert zu den exakten
  // TriggerVault.setupPlan()-Argumenten (siehe contracts/TriggerVault.sol) —
  // eine eigenständige 3-Transaktionen-Sequenz (createVault → approve →
  // setupPlan), analog zum Buy-Plan oben, aber auf der TriggerVaultFactory
  // statt der DcaVaultFactory. triggerPrice ist priceUsd mit 8
  // Nachkommastellen (wie Chainlink/Squid), amount/triggerPrice als String
  // (JSON kennt kein bigint), analog setupPlanArgs.totalAmount.
  triggerSell?: {
    priceUsd: number;
    setupPlanArgs: {
      heldToken:    `0x${string}`; // das zu verkaufende Token (sellToken)
      outputToken:  `0x${string}`; // wofür verkauft wird (targetToken)
      watchToken:   `0x${string}`; // == heldToken, der beobachtete Preis
      amount:       string;
      triggerAbove: true; // nur noch Take-Profit, siehe SellTriggerDraft
      triggerPrice: string;
      expiresAt:    number; // 0 = zeitlich unbegrenzt
    };
  };
}

export interface InvalidPlan {
  valid: false;
  errors: string[];
}

function resolveTargetToken(symbol: string): { address: `0x${string}`; decimals: number } | undefined {
  return (TARGET_TOKENS as Record<string, { address: `0x${string}`; decimals: number }>)[symbol];
}

function resolveAnyToken(symbol: string): { address: `0x${string}`; decimals: number } | undefined {
  return resolveTargetToken(symbol)
    ?? (INPUT_TOKENS as Record<string, { address: `0x${string}`; decimals: number }>)[symbol];
}

export function compilePlan(draft: PlanDraft, sellTrigger?: SellTriggerDraft): CompiledPlan | InvalidPlan {
  const errors: string[] = [];

  const inputToken = INPUT_TOKENS[draft.inputToken];
  if (!inputToken) errors.push(`Unknown input token '${draft.inputToken}'. Use USDC or USDT.`);

  const interval = INTERVAL_SECONDS[draft.interval];
  if (!interval) errors.push(`Unknown interval '${draft.interval}'. Use hourly, daily, or weekly.`);

  if (!Number.isInteger(draft.duration) || draft.duration <= 0) {
    errors.push('Duration must be a positive whole number of tranches.');
  }

  if (draft.targets.length === 0 || draft.targets.length > MAX_TARGETS) {
    errors.push(`Plan must have between 1 and ${MAX_TARGETS} target tokens.`);
  }

  const seen = new Set<string>();
  let totalBps = 0;
  const resolvedTargets: { address: `0x${string}`; bps: number }[] = [];
  for (const target of draft.targets) {
    const resolved = resolveTargetToken(target.token);
    if (!resolved) {
      errors.push(`Unknown target token '${target.token}'.`);
      continue;
    }
    if (target.bps <= 0 || target.bps > BPS_DENOMINATOR) {
      errors.push(`Allocation for ${target.token} must be between 1 and ${BPS_DENOMINATOR} bps.`);
      continue;
    }
    if (seen.has(target.token)) {
      errors.push(`Duplicate target token '${target.token}'.`);
      continue;
    }
    seen.add(target.token);
    totalBps += target.bps;
    resolvedTargets.push({ address: resolved.address, bps: target.bps });
  }
  if (resolvedTargets.length > 0 && totalBps !== BPS_DENOMINATOR) {
    errors.push(`Target allocations must sum to exactly 100% (${BPS_DENOMINATOR} bps) — got ${totalBps / 100}%.`);
  }

  let totalAmountRaw = 0n;
  if (inputToken) {
    try {
      totalAmountRaw = parseUnits(draft.totalAmount, inputToken.decimals);
    } catch {
      errors.push(`'${draft.totalAmount}' is not a valid amount.`);
    }
    if (totalAmountRaw <= 0n) errors.push('Total amount must be greater than zero.');
    // Spiegel der echten Contract-Prüfung (DcaVault.setupPlan: `_totalAmount < _duration` reverts) —
    // nicht OSIRIS' strengere Frontend-UX-Mindestgrenze (0.5 USDC), sondern die tatsächliche On-Chain-Grenze.
    if (draft.duration > 0 && totalAmountRaw < BigInt(draft.duration)) {
      errors.push('Total amount is too small for this many tranches — the contract would reject it.');
    }
  }

  let compiledTriggerSell: CompiledPlan['triggerSell'];
  if (sellTrigger) {
    const sellToken = resolveTargetToken(sellTrigger.sellToken);
    const sellTargetToken = resolveAnyToken(sellTrigger.targetToken);
    if (!sellToken) errors.push(`Unknown sell token '${sellTrigger.sellToken}'.`);
    if (!sellTargetToken) errors.push(`Unknown sell target token '${sellTrigger.targetToken}'.`);
    if (sellToken && sellTargetToken && sellToken.address === sellTargetToken.address) {
      errors.push('Sell trigger token and target token must differ.');
    }
    if (!(sellTrigger.triggerPriceUsd > 0)) errors.push('Sell trigger price must be greater than zero.');

    let sellAmountRaw = 0n;
    if (sellToken) {
      try {
        sellAmountRaw = parseUnits(sellTrigger.amount, sellToken.decimals);
      } catch {
        errors.push(`'${sellTrigger.amount}' is not a valid sell trigger amount.`);
      }
      if (sellAmountRaw <= 0n) errors.push('Sell trigger amount must be greater than zero.');
    }

    const timeLimit = sellTrigger.timeLimit ?? 'none';
    if (!(timeLimit in TIME_LIMIT_SECONDS)) errors.push(`Unknown time limit '${timeLimit}'. Use 1d, 1w, 1m, or none.`);

    if (sellToken && sellTargetToken && sellAmountRaw > 0n && sellTrigger.triggerPriceUsd > 0) {
      const limitSeconds = TIME_LIMIT_SECONDS[timeLimit] ?? 0;
      const expiresAt = limitSeconds === 0 ? 0 : Math.floor(Date.now() / 1000) + limitSeconds;
      compiledTriggerSell = {
        priceUsd: sellTrigger.triggerPriceUsd,
        setupPlanArgs: {
          heldToken: sellToken.address,
          outputToken: sellTargetToken.address,
          watchToken: sellToken.address,
          amount: sellAmountRaw.toString(),
          triggerAbove: true,
          triggerPrice: parseUnits(sellTrigger.triggerPriceUsd.toString(), 8).toString(),
          expiresAt,
        },
      };
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  const firstExecutionTimestamp = Math.floor(Date.now() / 1000) + 60;

  const buySummary = `Buy: ${draft.totalAmount} ${draft.inputToken} split across ${draft.duration} ${draft.interval} tranches into ` +
    resolvedTargets.map((t) => `${t.bps / 100}% ${draft.targets.find((d) => resolveTargetToken(d.token)?.address === t.address)?.token}`).join(', ');
  const sellSummary = compiledTriggerSell
    ? ` Sell: ${sellTrigger!.amount} ${sellTrigger!.sellToken} for ${sellTrigger!.targetToken}, once, if price is at or above $${compiledTriggerSell.priceUsd} (take profit)` +
      (compiledTriggerSell.setupPlanArgs.expiresAt === 0 ? '.' : ` — expires ${new Date(compiledTriggerSell.setupPlanArgs.expiresAt * 1000).toISOString()}.`)
    : '';

  return {
    valid: true,
    summary: buySummary + sellSummary,
    setupPlanArgs: {
      inputToken: inputToken.address,
      totalAmount: totalAmountRaw.toString(),
      duration: draft.duration,
      interval,
      firstExecutionTimestamp,
      targetTokens: resolvedTargets.map((t) => t.address),
      targetBps: resolvedTargets.map((t) => t.bps),
    },
    triggerSell: compiledTriggerSell,
  };
}
