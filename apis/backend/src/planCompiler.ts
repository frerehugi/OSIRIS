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

// Take-Profit ("above") und Stop-Loss ("below") sind beide gültige, unabhängige
// Sell-Order-Typen (siehe Chat) — deshalb hier als zwei optionale Preise statt
// eines Entweder-oder-Felds, genau wie im Sell-Trigger-Screen
// (apis/app/src/screens/SellTrigger.tsx). Mindestens einer der beiden muss
// gesetzt sein; jeder gesetzte Preis wird zu einer eigenen createOrder()-
// Order, beide teilen sich bps/maxExecutions (dieselbe Positionsgröße, nur
// die Richtung entscheidet, welche zuerst greift — kein automatisches
// One-Cancels-the-Other, siehe SellTrigger.tsx-Kommentar).
export interface SellTriggerDraft {
  sellToken:      keyof typeof TARGET_TOKENS;
  targetToken:    keyof typeof TARGET_TOKENS | keyof typeof INPUT_TOKENS;
  bps:            number;
  maxExecutions:  number;
  takeProfitUsd?: number;
  stopLossUsd?:   number;
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
  // Ein Eintrag pro gesetztem Take-Profit/Stop-Loss-Preis (1 oder 2), jeder
  // eine eigenständige createOrder()-Transaktion — siehe SellTriggerDraft.
  sellOrders?: {
    sellToken:     `0x${string}`;
    targetToken:   `0x${string}`;
    bps:           number;
    maxExecutions: number;
    priceCondition: { direction: 'above' | 'below'; priceUsd: number };
    // Rohe createOrder()-Argumente für ConditionalSellOrder.sol (siehe
    // contracts/ConditionalSellOrder.sol) — triggerAbove/triggerPrice sind
    // dort informationelle On-Chain-Metadaten, kein enforced Constraint.
    // triggerPrice ist priceUsd mit 8 Nachkommastellen (wie Chainlink/Squid),
    // als String (JSON kennt kein bigint), analog setupPlanArgs.totalAmount.
    createOrderArgs: {
      sellToken:     `0x${string}`;
      targetToken:   `0x${string}`;
      bps:           number;
      maxExecutions: number;
      triggerAbove:  boolean;
      triggerPrice:  string;
    };
  }[];
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

  let compiledSellOrders: CompiledPlan['sellOrders'];
  if (sellTrigger) {
    const sellToken = resolveTargetToken(sellTrigger.sellToken);
    const sellTargetToken = resolveAnyToken(sellTrigger.targetToken);
    if (!sellToken) errors.push(`Unknown sell token '${sellTrigger.sellToken}'.`);
    if (!sellTargetToken) errors.push(`Unknown sell target token '${sellTrigger.targetToken}'.`);
    if (sellToken && sellTargetToken && sellToken.address === sellTargetToken.address) {
      errors.push('Sell trigger token and target token must differ.');
    }
    if (sellTrigger.bps <= 0 || sellTrigger.bps > BPS_DENOMINATOR) {
      errors.push('Sell trigger bps must be between 1 and 10000.');
    }
    if (!Number.isInteger(sellTrigger.maxExecutions) || sellTrigger.maxExecutions <= 0) {
      errors.push('Sell trigger maxExecutions must be a positive whole number.');
    }

    const legs: { direction: 'above' | 'below'; priceUsd: number }[] = [];
    if (sellTrigger.takeProfitUsd !== undefined) {
      if (!(sellTrigger.takeProfitUsd > 0)) errors.push('Take-profit price must be greater than zero.');
      else legs.push({ direction: 'above', priceUsd: sellTrigger.takeProfitUsd });
    }
    if (sellTrigger.stopLossUsd !== undefined) {
      if (!(sellTrigger.stopLossUsd > 0)) errors.push('Stop-loss price must be greater than zero.');
      else legs.push({ direction: 'below', priceUsd: sellTrigger.stopLossUsd });
    }
    if (legs.length === 0) errors.push('Sell trigger needs at least a take-profit or a stop-loss price.');

    if (sellToken && sellTargetToken && legs.length > 0) {
      compiledSellOrders = legs.map((leg) => ({
        sellToken: sellToken.address,
        targetToken: sellTargetToken.address,
        bps: sellTrigger.bps,
        maxExecutions: sellTrigger.maxExecutions,
        priceCondition: { direction: leg.direction, priceUsd: leg.priceUsd },
        createOrderArgs: {
          sellToken: sellToken.address,
          targetToken: sellTargetToken.address,
          bps: sellTrigger.bps,
          maxExecutions: sellTrigger.maxExecutions,
          triggerAbove: leg.direction === 'above',
          triggerPrice: parseUnits(leg.priceUsd.toString(), 8).toString(),
        },
      }));
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  const firstExecutionTimestamp = Math.floor(Date.now() / 1000) + 60;

  const buySummary = `Buy: ${draft.totalAmount} ${draft.inputToken} split across ${draft.duration} ${draft.interval} tranches into ` +
    resolvedTargets.map((t) => `${t.bps / 100}% ${draft.targets.find((d) => resolveTargetToken(d.token)?.address === t.address)?.token}`).join(', ');
  const sellSummary = compiledSellOrders
    ? ' ' + compiledSellOrders.map((order) =>
        `Sell: ${sellTrigger!.bps / 100}% of held ${sellTrigger!.sellToken} for ${sellTrigger!.targetToken}, once, if price is ${order.priceCondition.direction} $${order.priceCondition.priceUsd} (${order.priceCondition.direction === 'above' ? 'take profit' : 'stop loss'}).`
      ).join(' ')
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
    sellOrders: compiledSellOrders,
  };
}
