// get_plans — Lese-Pfad für Plan-Status, analog zu get_balances: reine
// public-Client-Reads gegen die bestehenden, unveränderten OSIRIS-Contracts,
// keine eigene Logik/kein eigener State im Worker. Statuslogik 1:1 aus
// apis/app/src/hooks/usePlans.ts übernommen (dort React-gebunden, hier als
// plain Funktion, da der Worker keine Hooks hat).
//
// Bewusst OHNE Purchases-Historie (siehe Chat: "lass die purchases weg") —
// getUserPurchases() ist ein gechunkter eth_getLogs-Scan mit localStorage-
// Cache im Frontend; im stateless Worker gäbe es diesen Cache nicht, jede
// Chat-Anfrage würde also potenziell einen teuren Kalt-Scan auslösen.

import { formatUnits } from 'viem';
import type { ApisPublicClient } from './client';
import { DCA_VAULT_ABI, DCA_VAULT_FACTORY_ABI } from '../../../src/dcaVaultAbi';
import { TRIGGER_VAULT_ABI, TRIGGER_VAULT_FACTORY_ABI } from '../../../src/triggerVaultAbi';
import {
  ALL_FACTORY_ADDRESSES, ALL_TRIGGER_VAULT_FACTORY_ADDRESSES,
  INPUT_TOKENS, TARGET_TOKENS, type TokenInfo,
} from '../../../src/config';

const ALL_TOKENS_BY_ADDRESS: Record<string, TokenInfo> = Object.fromEntries(
  [...Object.values(TARGET_TOKENS), ...Object.values(INPUT_TOKENS)].map((token) => [token.address.toLowerCase(), token]),
);

const INPUT_TOKEN_ADDRESSES: Record<string, true> = Object.fromEntries(
  Object.values(INPUT_TOKENS).map((token) => [token.address.toLowerCase(), true as const]),
);

function tokenInfo(address: `0x${string}`): { symbol: string; decimals: number } {
  return ALL_TOKENS_BY_ADDRESS[address.toLowerCase()] ?? { symbol: `${address.slice(0, 6)}…`, decimals: 18 };
}

// ── DCA-Pläne ────────────────────────────────────────────────────────────

type DcaStatus = 'pending' | 'active' | 'cancelled' | 'complete';

interface DcaPlanSummary {
  address:     `0x${string}`;
  status:      DcaStatus;
  inputToken?: string;
  totalAmount?: string;
  progress?:   { step: number; totalSteps: number };
  targets?:    { token: string; percent: number }[];
}

async function readDcaVaults(publicClient: ApisPublicClient, owner: `0x${string}`): Promise<`0x${string}`[]> {
  // Alle bekannten Factory-Generationen (siehe ALL_FACTORY_ADDRESSES-Kommentar
  // in config.ts) — sonst verschwindet ein Plan aus einer älteren Migration
  // aus der Sicht der APIS-KI, obwohl er on-chain weiter existiert.
  const perFactory = await Promise.all(
    ALL_FACTORY_ADDRESSES.map((factoryAddress) =>
      publicClient.readContract({
        address: factoryAddress, abi: DCA_VAULT_FACTORY_ABI, functionName: 'getVaults', args: [owner],
      }) as Promise<`0x${string}`[]>,
    ),
  );
  return [...new Set(perFactory.flat())];
}

async function readDcaPlan(publicClient: ApisPublicClient, vaultAddress: `0x${string}`): Promise<DcaPlanSummary> {
  const read = (functionName: string) => publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName } as never);

  const [initialized, cancelled, currentStep, totalSteps, inputTokenAddress, totalDeposited, targetConfigs] = await Promise.all([
    read('initialized'), read('cancelled'), read('currentStep'), read('totalSteps'),
    read('inputToken'), read('totalDeposited'), read('getTargetConfigs'),
  ]) as [boolean, boolean, number, number, `0x${string}`, bigint, { token: `0x${string}`; bps: number }[]];

  if (!initialized) return { address: vaultAddress, status: 'pending' };

  const status: DcaStatus = cancelled ? 'cancelled' : Number(currentStep) >= Number(totalSteps) ? 'complete' : 'active';
  const inputInfo = tokenInfo(inputTokenAddress);

  return {
    address: vaultAddress,
    status,
    inputToken: inputInfo.symbol,
    totalAmount: formatUnits(totalDeposited, inputInfo.decimals),
    progress: { step: Number(currentStep), totalSteps: Number(totalSteps) },
    targets: targetConfigs.map((c) => ({ token: tokenInfo(c.token).symbol, percent: c.bps / 100 })),
  };
}

// ── Trigger-Pläne (Buy/Sell) ────────────────────────────────────────────

type TriggerStatus = 'pending' | 'active' | 'expired' | 'cancelled' | 'executed';

interface TriggerPlanSummary {
  address:      `0x${string}`;
  direction:    'buy' | 'sell';
  status:       TriggerStatus;
  heldToken:    string;
  outputToken:  string;
  amount:       string;
  triggerPriceUsd: number;
  expiresAt:    number; // 0 = kein Zeitlimit
}

async function readTriggerVaults(publicClient: ApisPublicClient, owner: `0x${string}`): Promise<`0x${string}`[]> {
  // Jede bekannte Factory-Generation (siehe ALL_TRIGGER_VAULT_FACTORY_ADDRESSES
  // in config.ts) — gleicher Grund wie readDcaVaults() oben.
  const perFactory = await Promise.all(
    ALL_TRIGGER_VAULT_FACTORY_ADDRESSES.map((factoryAddress) =>
      publicClient.readContract({
        address: factoryAddress, abi: TRIGGER_VAULT_FACTORY_ABI, functionName: 'getVaults', args: [owner],
      }) as Promise<`0x${string}`[]>,
    ),
  );
  return [...new Set(perFactory.flat())];
}

async function readTriggerPlan(publicClient: ApisPublicClient, vaultAddress: `0x${string}`): Promise<TriggerPlanSummary | null> {
  const read = (functionName: string) => publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName } as never);

  const [heldToken, outputToken, amount, triggerPriceRaw, expiresAtRaw, initialized, cancelled, executed] = await Promise.all([
    read('heldToken'), read('outputToken'), read('amount'), read('triggerPrice'),
    read('expiresAt'), read('initialized'), read('cancelled'), read('executed'),
  ]) as [`0x${string}`, `0x${string}`, bigint, bigint, bigint, boolean, boolean, boolean];

  const heldInfo = tokenInfo(heldToken);
  const outputInfo = tokenInfo(outputToken);
  const expiresAt = Number(expiresAtRaw);

  let status: TriggerStatus;
  if (!initialized) status = 'pending';
  else if (cancelled) status = 'cancelled';
  else if (executed) status = 'executed';
  else if (expiresAt !== 0 && Date.now() / 1000 > expiresAt) status = 'expired';
  else status = 'active';

  return {
    address: vaultAddress,
    direction: heldToken.toLowerCase() in INPUT_TOKEN_ADDRESSES ? 'buy' : 'sell',
    status,
    heldToken: heldInfo.symbol,
    outputToken: outputInfo.symbol,
    amount: formatUnits(amount, heldInfo.decimals),
    triggerPriceUsd: Number(formatUnits(triggerPriceRaw, 8)),
    expiresAt,
  };
}

export async function getPlansForOwner(publicClient: ApisPublicClient, owner: `0x${string}`) {
  const [dcaVaultAddresses, triggerVaultAddresses] = await Promise.all([
    readDcaVaults(publicClient, owner),
    readTriggerVaults(publicClient, owner),
  ]);

  const [dcaPlans, triggerPlansRaw] = await Promise.all([
    Promise.all(dcaVaultAddresses.map((address) => readDcaPlan(publicClient, address))),
    Promise.all(triggerVaultAddresses.map((address) => readTriggerPlan(publicClient, address))),
  ]);

  const triggerPlans = triggerPlansRaw.filter((p): p is TriggerPlanSummary => p !== null);

  return { owner, dcaPlans, triggerPlans };
}
