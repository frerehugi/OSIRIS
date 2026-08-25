import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection, usePublicClient, useReadContracts, useWriteContract } from 'wagmi';
import { formatUnits } from 'viem';
import {
  getUserVaults, readPlanStatus, cancelDcaPlan, runInBatches, RPC_BATCH_SIZE, resolveInputTokenSymbol,
} from '../../../../src/minipayWallet';
import {
  ERC20_ABI, DCA_VAULT_ABI, INPUT_TOKENS, TARGET_TOKENS, TRIGGER_VAULT_FACTORY_ADDRESS, type TokenInfo,
} from '../config';
import { TRIGGER_VAULT_ABI, TRIGGER_VAULT_FACTORY_ABI } from '../triggerVaultAbi';

/// Gemeinsame Datenschicht für alle 4 "My Plans"-Unterordner (Active/
/// Completed/Cancelled — My Purchases lädt separat, siehe Purchases.tsx).
/// Extrahiert unverändert aus der ursprünglichen (jetzt aufgeteilten)
/// Plans.tsx — liest weiterhin dieselben, unveränderten OSIRIS-Vaults wie
/// osirisapp.xyz selbst über src/minipayWallet.ts, plus die eigenständigen
/// TriggerVault-Pläne komplett über wagmi (siehe Kommentar dort zuvor).

export type VaultStatus = 'pending' | 'active' | 'cancelled' | 'complete';

export interface PlanAsset {
  symbol: string;
  bps:    number;
}

export interface PlanSummary {
  address:          `0x${string}`;
  status:           VaultStatus;
  inputTokenSymbol: string;
  totalAmount:      bigint;
  currentStep:      number;
  totalSteps:       number;
  assets:           PlanAsset[];
}

const TARGET_TOKEN_BY_ADDRESS: Record<string, string> = Object.fromEntries(
  Object.values(TARGET_TOKENS).map((token) => [token.address.toLowerCase(), token.symbol]),
);

export const STATUS_LABEL: Record<VaultStatus, string> = {
  pending: 'Setup incomplete', active: 'Active', cancelled: 'Cancelled', complete: 'Complete',
};

function computeStatus(status: Awaited<ReturnType<typeof readPlanStatus>>): VaultStatus {
  if (!status.initialized) return 'pending';
  if (status.cancelled) return 'cancelled';
  if (Number(status.currentStep) >= Number(status.totalSteps)) return 'complete';
  return 'active';
}

export function formatAmount(raw: bigint): string {
  return Number(formatUnits(raw, 6)).toFixed(2); // USDC/USDT — beide 6 Decimals
}

// ─── Trigger-Pläne (Buy/Sell, siehe TriggerVault.sol) ──────────────────────

export type TriggerPlanStatus = 'pending' | 'active' | 'expired' | 'cancelled' | 'executed';

export interface TriggerPlanSummary {
  address:         `0x${string}`;
  direction:       'buy' | 'sell';
  heldSymbol:      string;
  outputSymbol:    string;
  amountRaw:       bigint;
  heldDecimals:    number;
  triggerPriceUsd: number;
  expiresAt:       number; // 0 = zeitlich unbegrenzt
  status:          TriggerPlanStatus;
}

const ALL_TOKENS_BY_ADDRESS: Record<string, TokenInfo> = Object.fromEntries(
  [...Object.values(TARGET_TOKENS), ...Object.values(INPUT_TOKENS)].map((token) => [token.address.toLowerCase(), token]),
);

const INPUT_TOKEN_ADDRESSES: Record<string, true> = Object.fromEntries(
  Object.values(INPUT_TOKENS).map((token) => [token.address.toLowerCase(), true as const]),
);

// Eine Vault-Adresse liefert 9 Felder (siehe TRIGGER_VAULT_ABI) — dieselbe
// Reihenfolge wird beim Auslesen von useReadContracts' Ergebnis-Array wieder
// pro Vault "entpackt" (siehe buildTriggerPlanContracts/parseTriggerPlanRow).
const TRIGGER_FIELDS = ['heldToken', 'outputToken', 'amount', 'triggerAbove', 'triggerPrice', 'expiresAt', 'initialized', 'cancelled', 'executed'] as const;

function buildTriggerPlanContracts(vaultAddresses: readonly `0x${string}`[]) {
  return vaultAddresses.flatMap((vaultAddress) =>
    TRIGGER_FIELDS.map((functionName) => ({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName })),
  );
}

function parseTriggerPlanRow(
  vaultAddress: `0x${string}`,
  results: readonly { status: 'success' | 'failure'; result?: unknown }[],
): TriggerPlanSummary | null {
  if (results.some((r) => r.status !== 'success')) return null;
  const [heldToken, outputToken, amountRaw, , triggerPriceRaw, expiresAtRaw, initialized, cancelled, executed] =
    results.map((r) => r.result) as [`0x${string}`, `0x${string}`, bigint, boolean, bigint, bigint, boolean, boolean, boolean];

  const heldInfo = ALL_TOKENS_BY_ADDRESS[heldToken.toLowerCase()];
  const outputInfo = ALL_TOKENS_BY_ADDRESS[outputToken.toLowerCase()];
  if (!heldInfo || !outputInfo) return null;

  const direction: 'buy' | 'sell' = heldToken.toLowerCase() in INPUT_TOKEN_ADDRESSES ? 'buy' : 'sell';
  const expiresAt = Number(expiresAtRaw);

  let status: TriggerPlanStatus;
  if (!initialized) status = 'pending';
  else if (cancelled) status = 'cancelled';
  else if (executed) status = 'executed';
  else if (expiresAt !== 0 && Date.now() / 1000 > expiresAt) status = 'expired';
  else status = 'active';

  return {
    address: vaultAddress,
    direction,
    heldSymbol: heldInfo.symbol,
    outputSymbol: outputInfo.symbol,
    amountRaw,
    heldDecimals: heldInfo.decimals,
    triggerPriceUsd: Number(formatUnits(triggerPriceRaw, 8)),
    expiresAt,
    status,
  };
}

export const TRIGGER_STATUS_LABEL: Record<TriggerPlanStatus, string> = {
  pending: 'Setup incomplete', active: 'Active', expired: 'Expired', cancelled: 'Cancelled', executed: 'Complete',
};

export function formatExpiry(expiresAt: number): string {
  if (expiresAt === 0) return 'No time limit';
  const diffMs = expiresAt * 1000 - Date.now();
  if (diffMs <= 0) return `Expired ${new Date(expiresAt * 1000).toLocaleDateString()}`;
  const days = Math.ceil(diffMs / 86_400_000);
  return days <= 1 ? 'Expires today' : `Expires in ${days} days`;
}

// Wiederverwendung der vorhandenen pending/active/cancelled/complete-Klassen
// (siehe App.css) statt eigener CSS für 'expired'/'executed' — 'expired'
// sieht wie 'cancelled' aus (beide "muss der User selbst noch cancel()en"),
// 'executed' wie 'complete'.
export function triggerPillClass(status: TriggerPlanStatus): string {
  if (status === 'executed') return 'complete';
  if (status === 'expired') return 'cancelled';
  return status;
}

export function usePlans() {
  const { address } = useConnection();

  const [plans, setPlans]     = useState<PlanSummary[] | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmingAddress, setConfirmingAddress] = useState<`0x${string}` | null>(null);
  const [cancellingAddress, setCancellingAddress] = useState<`0x${string}` | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const vaultAddresses = await getUserVaults(address);
      const summaries = await runInBatches(vaultAddresses, RPC_BATCH_SIZE, async (vaultAddress): Promise<PlanSummary> => {
        const status = await readPlanStatus(vaultAddress);
        const assets: PlanAsset[] = status.targetConfigs
          .map((config) => ({ symbol: TARGET_TOKEN_BY_ADDRESS[config.token.toLowerCase()], bps: config.bps }))
          .filter((asset): asset is PlanAsset => !!asset.symbol);
        return {
          address: vaultAddress,
          status: computeStatus(status),
          inputTokenSymbol: resolveInputTokenSymbol(status.inputToken),
          totalAmount: status.totalDeposited,
          currentStep: Number(status.currentStep),
          totalSteps: Number(status.totalSteps),
          assets,
        };
      });
      setPlans(summaries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your plans.');
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { void load(); }, [load]);

  // Kein window.confirm() — MiniPays In-App-Browser unterdrückt native
  // Dialoge (gleicher Grund wie in OSIRIS' eigenem App.tsx) — Bestätigung
  // läuft über einen zweiten Tap.
  const confirmCancel = async (vaultAddress: `0x${string}`) => {
    if (!address) return;
    setConfirmingAddress(null);
    setCancellingAddress(vaultAddress);
    setCancelError(null);
    try {
      await cancelDcaPlan(vaultAddress, address);
      await load();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Cancel failed. Please try again.');
    } finally {
      setCancellingAddress(null);
    }
  };

  // ── Trigger-Pläne (Buy/Sell, siehe TriggerVault.sol) — eigene Factory, komplett
  // über wagmi statt über minipayWallet.ts gelesen (siehe Kommentar oben).
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const { data: vaultListData, isLoading: vaultListLoading, refetch: refetchVaultList } = useReadContracts({
    allowFailure: true,
    contracts: address
      ? [{ address: TRIGGER_VAULT_FACTORY_ADDRESS, abi: TRIGGER_VAULT_FACTORY_ABI, functionName: 'getVaults' as const, args: [address] as const }]
      : [],
  });
  const triggerVaultAddresses = vaultListData?.[0]?.status === 'success' ? (vaultListData[0].result as `0x${string}`[]) : [];

  const { data: triggerDetailData, isLoading: triggerDetailsLoading, refetch: refetchTriggerDetails } = useReadContracts({
    allowFailure: true,
    contracts: buildTriggerPlanContracts(triggerVaultAddresses),
  });

  const triggerPlans = useMemo(() => {
    if (!triggerDetailData) return [];
    const rows: TriggerPlanSummary[] = [];
    triggerVaultAddresses.forEach((vaultAddress, i) => {
      const slice = triggerDetailData.slice(i * TRIGGER_FIELDS.length, (i + 1) * TRIGGER_FIELDS.length);
      const parsed = parseTriggerPlanRow(vaultAddress, slice);
      if (parsed) rows.push(parsed);
    });
    return rows;
  }, [triggerVaultAddresses, triggerDetailData]);

  const [triggerConfirmingAddress, setTriggerConfirmingAddress] = useState<`0x${string}` | null>(null);
  const [triggerCancellingAddress, setTriggerCancellingAddress] = useState<`0x${string}` | null>(null);
  const [triggerCancelError, setTriggerCancelError] = useState<string | null>(null);

  const confirmTriggerCancel = async (vaultAddress: `0x${string}`) => {
    if (!publicClient) return;
    setTriggerConfirmingAddress(null);
    setTriggerCancellingAddress(vaultAddress);
    setTriggerCancelError(null);
    try {
      const hash = await writeContractAsync({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: 'cancel' });
      await publicClient.waitForTransactionReceipt({ hash });
      await Promise.all([refetchVaultList(), refetchTriggerDetails()]);
    } catch (err) {
      setTriggerCancelError(err instanceof Error ? err.message : 'Cancel failed. Please try again.');
    } finally {
      setTriggerCancellingAddress(null);
    }
  };

  // ── "Finish & close" für verwaiste, nie initialisierte DCA-Vaults ──────────
  //
  // Ein pending-Vault (initialized === false) kann NICHT über cancelPlan()
  // beendet werden — der Contract verlangt initialized === true (siehe
  // DcaVault.sol: cancelPlan() revertet mit NotInitialized()). Gleichzeitig
  // ist inputToken/targetTokens für einen pending-Vault unbekannt (wird erst
  // von setupPlan() selbst gesetzt), die ursprünglich geplanten Werte lassen
  // sich also nicht rekonstruieren. Lösung: setupPlan() mit einem trivialen
  // Platzhalter (0.01 USDC, 1 Schritt, 100% CELO) nachholen, danach sofort
  // cancelPlan() — das gibt den vollen Betrag zurück (keine Fee außerhalb von
  // executeStep()) und überführt den Vault sauber von 'pending' zu
  // 'cancelled'. Kostet nur Gas (approve + setupPlan + cancelPlan).
  const FINISH_PLACEHOLDER_AMOUNT = 10_000n; // 0.01 USDC (6 Dezimalstellen)

  const [finishConfirmingAddress, setFinishConfirmingAddress] = useState<`0x${string}` | null>(null);
  const [finishingAddress, setFinishingAddress] = useState<`0x${string}` | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);

  const finishPendingPlan = async (vaultAddress: `0x${string}`) => {
    if (!publicClient) return;
    setFinishConfirmingAddress(null);
    setFinishingAddress(vaultAddress);
    setFinishError(null);
    try {
      const approveHash = await writeContractAsync({
        address: INPUT_TOKENS.USDC.address, abi: ERC20_ABI, functionName: 'approve',
        args: [vaultAddress, FINISH_PLACEHOLDER_AMOUNT],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      const setupHash = await writeContractAsync({
        address: vaultAddress, abi: DCA_VAULT_ABI, functionName: 'setupPlan',
        args: [
          INPUT_TOKENS.USDC.address, FINISH_PLACEHOLDER_AMOUNT, 1, 1n,
          BigInt(Math.floor(Date.now() / 1000) + 60), [TARGET_TOKENS.CELO.address], [10_000],
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash: setupHash });

      const cancelHash = await writeContractAsync({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: 'cancelPlan' });
      await publicClient.waitForTransactionReceipt({ hash: cancelHash });

      await load();
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : 'Could not finish this plan. Please try again.');
    } finally {
      setFinishingAddress(null);
    }
  };

  return {
    plans, plansLoading: loading, plansError: error,
    confirmingAddress, setConfirmingAddress, cancellingAddress, cancelError, confirmCancel,

    finishConfirmingAddress, setFinishConfirmingAddress, finishingAddress, finishError, finishPendingPlan,

    triggerPlans, triggerPlansLoading: vaultListLoading || triggerDetailsLoading, triggerCancelError,
    triggerConfirmingAddress, setTriggerConfirmingAddress, triggerCancellingAddress, confirmTriggerCancel,
  };
}
