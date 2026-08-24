import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection, usePublicClient, useReadContracts, useWriteContract } from 'wagmi';
import { formatUnits } from 'viem';
import {
  getUserVaults, readPlanStatus, cancelDcaPlan, runInBatches, RPC_BATCH_SIZE, resolveInputTokenSymbol,
} from '../../../../src/minipayWallet';
import { INPUT_TOKENS, TARGET_TOKENS, TRIGGER_VAULT_FACTORY_ADDRESS, type TokenInfo } from '../config';
import { TRIGGER_VAULT_ABI, TRIGGER_VAULT_FACTORY_ABI } from '../triggerVaultAbi';
import { TOKEN_COLOR, type AnyTokenSymbol } from '../tokenVisuals';
import TokenIcon from '../components/TokenIcon';

/// My Plans liest dieselben, unveränderten OSIRIS-Vaults wie osirisapp.xyz
/// selbst — Apis hat keine eigene Vault-Factory für DCA-Pläne, sie nutzt
/// ausschließlich die bestehende (siehe Gesamtplan §1/§9). Wiederverwendet
/// OSIRIS' eigene, bereits erprobte Lese-/Cancel-Funktionen direkt aus
/// src/minipayWallet.ts statt einer zweiten Implementierung.
///
/// Trigger-Pläne (Buy/Sell, siehe TriggerVault.sol) sind eine zweite,
/// eigenständige Liste darunter — eigene Factory, eigene ABI (siehe
/// triggerVaultAbi.ts), komplett über wagmi statt über minipayWallet.ts'
/// OSIRIS-eigenen Client gelesen, um die OSIRIS-App-Datei unangetastet zu
/// lassen (siehe Chat: "An der OSIRIS App wird nichts verändert").

type VaultStatus = 'pending' | 'active' | 'cancelled' | 'complete';

interface PlanAsset {
  symbol: string;
  bps:    number;
}

interface PlanSummary {
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

const STATUS_LABEL: Record<VaultStatus, string> = {
  pending: 'Setup incomplete', active: 'Active', cancelled: 'Cancelled', complete: 'Complete',
};

function computeStatus(status: Awaited<ReturnType<typeof readPlanStatus>>): VaultStatus {
  if (!status.initialized) return 'pending';
  if (status.cancelled) return 'cancelled';
  if (Number(status.currentStep) >= Number(status.totalSteps)) return 'complete';
  return 'active';
}

function formatAmount(raw: bigint): string {
  return Number(formatUnits(raw, 6)).toFixed(2); // USDC/USDT — beide 6 Decimals
}

// ─── Trigger-Pläne (Buy/Sell, siehe TriggerVault.sol) ──────────────────────

type TriggerPlanStatus = 'pending' | 'active' | 'expired' | 'cancelled' | 'executed';

interface TriggerPlanSummary {
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

const TRIGGER_STATUS_LABEL: Record<TriggerPlanStatus, string> = {
  pending: 'Setup incomplete', active: 'Active', expired: 'Expired', cancelled: 'Cancelled', executed: 'Complete',
};

function formatExpiry(expiresAt: number): string {
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
function triggerPillClass(status: TriggerPlanStatus): string {
  if (status === 'executed') return 'complete';
  if (status === 'expired') return 'cancelled';
  return status;
}

export default function Plans() {
  const navigate = useNavigate();
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

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">My Plans</span>
        <span className="app-bar__spacer" />
      </div>

      <div className="section-label">DCA Plans</div>
      {loading && <p className="plans-note">Loading your plans…</p>}
      {error && <p className="createcode-error">{error}</p>}
      {cancelError && <p className="createcode-error">{cancelError}</p>}
      {!loading && !error && plans?.length === 0 && (
        <p className="plans-note">No DCA plans yet. Set one up by chatting with your AI assistant.</p>
      )}

      <div className="plan-list">
        {plans?.map((plan) => (
          <div key={plan.address} className={`plan-card plan-card--${plan.status}`}>
            <div className="plan-card__top">
              <a className="plan-card__address" href={`https://celoscan.io/address/${plan.address}`} rel="noreferrer">
                {plan.address.slice(0, 6)}…{plan.address.slice(-4)}
              </a>
              <span className={`pill pill--${plan.status}`}>{STATUS_LABEL[plan.status]}</span>
            </div>

            {plan.status !== 'pending' && (
              <>
                <div className="plan-card__amount">{formatAmount(plan.totalAmount)} {plan.inputTokenSymbol}</div>

                <div className="plan-card__progress">
                  <div className="plan-card__progress-track">
                    <div
                      className="plan-card__progress-fill"
                      style={{ width: `${plan.totalSteps > 0 ? Math.min(100, (plan.currentStep / plan.totalSteps) * 100) : 0}%` }}
                    />
                  </div>
                  <span>{plan.currentStep} / {plan.totalSteps}</span>
                </div>

                {plan.assets.length > 0 && (
                  <>
                    <div className="plan-card__assets-bar">
                      {plan.assets.map((asset) => (
                        <span
                          key={asset.symbol}
                          style={{ width: `${asset.bps / 100}%`, background: TOKEN_COLOR[asset.symbol as AnyTokenSymbol] }}
                        />
                      ))}
                    </div>
                    <div className="plan-card__assets">
                      {plan.assets.map((asset) => (
                        <span key={asset.symbol} className="tag">
                          <TokenIcon token={asset.symbol as AnyTokenSymbol} size={15} />
                          {(asset.bps / 100).toFixed(0)}% {asset.symbol}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {plan.status === 'active' && (
              confirmingAddress === plan.address ? (
                <div className="plan-card__confirm">
                  <p>Cancel this plan? Your remaining balance will be returned to your wallet.</p>
                  <div className="plan-card__confirm-actions">
                    <button type="button" className="btn-ghost" onClick={() => setConfirmingAddress(null)}>No, keep it</button>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => confirmCancel(plan.address)}
                      disabled={cancellingAddress === plan.address}
                    >
                      {cancellingAddress === plan.address ? 'Cancelling…' : 'Yes, cancel'}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn-danger" onClick={() => setConfirmingAddress(plan.address)}>
                  Cancel plan
                </button>
              )
            )}
          </div>
        ))}
      </div>

      <div className="section-label" style={{ marginTop: 8 }}>Trigger Plans</div>
      {(vaultListLoading || triggerDetailsLoading) && <p className="plans-note">Loading your trigger plans…</p>}
      {triggerCancelError && <p className="createcode-error">{triggerCancelError}</p>}
      {!vaultListLoading && !triggerDetailsLoading && triggerPlans.length === 0 && (
        <p className="plans-note">No buy/sell trigger plans yet. Set one up from "Set up new trigger plan".</p>
      )}

      <div className="plan-list">
        {triggerPlans.map((plan) => (
          <div key={plan.address} className={`plan-card plan-card--${triggerPillClass(plan.status)}`}>
            <div className="plan-card__top">
              <a className="plan-card__address" href={`https://celoscan.io/address/${plan.address}`} rel="noreferrer">
                {plan.address.slice(0, 6)}…{plan.address.slice(-4)}
              </a>
              <span className={`pill pill--${triggerPillClass(plan.status)}`}>{TRIGGER_STATUS_LABEL[plan.status]}</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <TokenIcon token={(plan.direction === 'buy' ? plan.outputSymbol : plan.heldSymbol) as AnyTokenSymbol} size={20} />
              <span style={{ fontSize: 14, fontWeight: 700 }}>
                {plan.direction === 'buy'
                  ? `Buy ${plan.outputSymbol} with ${formatUnits(plan.amountRaw, plan.heldDecimals)} ${plan.heldSymbol}`
                  : `Sell ${formatUnits(plan.amountRaw, plan.heldDecimals)} ${plan.heldSymbol} for ${plan.outputSymbol}`}
              </span>
            </div>
            <p className="sell-sub">
              Triggers {plan.direction === 'buy' ? 'at or below' : 'at or above'} ${plan.triggerPriceUsd.toLocaleString()} · {formatExpiry(plan.expiresAt)}
            </p>

            {(plan.status === 'active' || plan.status === 'expired') && (
              triggerConfirmingAddress === plan.address ? (
                <div className="plan-card__confirm">
                  <p>Cancel this plan? Your locked {plan.heldSymbol} will be returned to your wallet.</p>
                  <div className="plan-card__confirm-actions">
                    <button type="button" className="btn-ghost" onClick={() => setTriggerConfirmingAddress(null)}>No, keep it</button>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => confirmTriggerCancel(plan.address)}
                      disabled={triggerCancellingAddress === plan.address}
                    >
                      {triggerCancellingAddress === plan.address ? 'Cancelling…' : 'Yes, cancel'}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn-danger" onClick={() => setTriggerConfirmingAddress(plan.address)}>
                  Cancel plan
                </button>
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
