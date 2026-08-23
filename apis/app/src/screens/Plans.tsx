import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from 'wagmi';
import { formatUnits } from 'viem';
import {
  getUserVaults, readPlanStatus, cancelDcaPlan, runInBatches, RPC_BATCH_SIZE, resolveInputTokenSymbol,
} from '../../../../src/minipayWallet';
import { TARGET_TOKENS } from '../config';
import { TOKEN_COLOR, type AnyTokenSymbol } from '../tokenVisuals';
import TokenIcon from '../components/TokenIcon';

/// My Plans liest dieselben, unveränderten OSIRIS-Vaults wie osirisapp.xyz
/// selbst — Apis hat keine eigene Vault-Factory, sie nutzt ausschließlich
/// die bestehende (siehe Gesamtplan §1/§9). Wiederverwendet OSIRIS' eigene,
/// bereits erprobte Lese-/Cancel-Funktionen direkt aus src/minipayWallet.ts
/// statt einer zweiten Implementierung.
///
/// ConditionalSellOrder-Orders sind hier noch NICHT dabei — der Contract ist
/// bislang nur lokal getestet, noch nicht deployt (Gesamtplan §20/§23).

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

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">My Plans</span>
        <span className="app-bar__spacer" />
      </div>

      {loading && <p className="plans-note">Loading your plans…</p>}
      {error && <p className="createcode-error">{error}</p>}
      {cancelError && <p className="createcode-error">{cancelError}</p>}
      {!loading && !error && plans?.length === 0 && (
        <p className="plans-note">No plans yet. Set one up by chatting with your AI assistant.</p>
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
    </div>
  );
}
