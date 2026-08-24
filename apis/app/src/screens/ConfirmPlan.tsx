import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection, usePublicClient, useWriteContract } from 'wagmi';
import { formatUnits, parseEventLogs } from 'viem';
import {
  ERC20_ABI, DCA_VAULT_ABI, DCA_VAULT_FACTORY_ABI, FACTORY_ADDRESS,
  TARGET_TOKENS, INPUT_TOKENS, type TokenInfo,
} from '../config';
import type { AnyTokenSymbol } from '../tokenVisuals';
import TokenIcon from '../components/TokenIcon';

/// Confirm Plan — nimmt den Code entgegen, den `propose_plan` (apis/backend)
/// im Chat ausgibt, und führt ihn aus. Spiegelt OSIRIS' eigenes
/// submitDcaPlan() in src/minipayWallet.ts 1:1 im Aufbau (createVault() →
/// approve() → setupPlan(), dieselbe ABI-Argumentreihenfolge), hier über
/// wagmi statt über einen rohen viem-Client, damit es zum Rest von apis/app
/// passt.
///
/// Der Plan-Code ist bewusst ein einfügbarer Text-Code statt eines Deep-
/// Links — gleiches Prinzip wie der Access-Grant-Code aus Create New Code
/// (siehe CreateCode.tsx): kein Backend/State nötig, um ihn zu übertragen,
/// nur base64url(JSON) von genau dem, was propose_plan zurückgibt.
///
/// Nur der DCA-Kaufplan-Teil von propose_plan wird hier ausgeführt. Der
/// ältere sellOrders-Anhang (ConditionalSellOrder-basiert) ist mit der
/// TriggerVault-Umstellung (siehe TriggerPlanReview.tsx) entfallen — das
/// Backend gibt sellOrders derzeit noch im alten Format aus, das hier
/// bewusst ignoriert wird, bis planCompiler.ts auf TriggerVault umgestellt
/// ist. Sell-Trigger werden bis dahin über "Set up new trigger plan" im
/// Home-Menü separat eingerichtet.

interface ProposedPlan {
  summary: string;
  setupPlanArgs: {
    inputToken:              `0x${string}`;
    totalAmount:             string;
    duration:                number;
    interval:                number;
    firstExecutionTimestamp: number;
    targetTokens:            `0x${string}`[];
    targetBps:               number[];
  };
}

const ALL_TOKENS: Record<string, TokenInfo> = { ...TARGET_TOKENS, ...INPUT_TOKENS };
const ALL_TOKENS_BY_ADDRESS = new Map(Object.values(ALL_TOKENS).map((t) => [t.address.toLowerCase(), t]));

function tokenForAddress(address: string): { symbol: string; decimals: number } {
  return ALL_TOKENS_BY_ADDRESS.get(address.toLowerCase()) ?? { symbol: `${address.slice(0, 6)}…`, decimals: 18 };
}

function decodePlanCode(code: string): ProposedPlan {
  const normalized = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  const json = atob(normalized);
  const parsed = JSON.parse(json);
  if (!parsed?.setupPlanArgs) throw new Error('This code does not look like a plan code.');
  return parsed as ProposedPlan;
}

const INTERVAL_LABEL: Record<number, string> = { 3_600: 'hourly', 86_400: 'daily', 604_800: 'weekly' };

type Phase = 'idle' | 'creating-vault' | 'approving-buy' | 'setting-up-plan' | 'done';

export default function ConfirmPlan() {
  const navigate = useNavigate();
  const { address } = useConnection();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [codeInput, setCodeInput] = useState('');
  const [plan, setPlan] = useState<ProposedPlan | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [vaultAddress, setVaultAddress] = useState<`0x${string}` | null>(null);

  const loadCode = () => {
    setParseError(null);
    setPlan(null);
    try {
      setPlan(decodePlanCode(codeInput));
    } catch {
      setParseError('Could not read this code. Copy it exactly as it was given to you in the chat.');
    }
  };

  const busy = phase !== 'idle' && phase !== 'done';

  const handleConfirm = async () => {
    if (!address || !publicClient || !plan) return;
    setError(null);

    const { inputToken, totalAmount, duration, interval, firstExecutionTimestamp, targetTokens, targetBps } = plan.setupPlanArgs;
    const totalAmountRaw = BigInt(totalAmount);

    try {
      setPhase('creating-vault');
      const createVaultHash = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: DCA_VAULT_FACTORY_ABI,
        functionName: 'createVault',
      });
      const createVaultReceipt = await publicClient.waitForTransactionReceipt({ hash: createVaultHash });
      const [vaultCreatedEvent] = parseEventLogs({ abi: DCA_VAULT_FACTORY_ABI, eventName: 'VaultCreated', logs: createVaultReceipt.logs });
      const newVaultAddress = vaultCreatedEvent?.args.vault;
      if (!newVaultAddress) throw new Error('Vault was created, but its address could not be read from the event.');
      setVaultAddress(newVaultAddress);

      setPhase('approving-buy');
      const approveHash = await writeContractAsync({
        address: inputToken, abi: ERC20_ABI, functionName: 'approve', args: [newVaultAddress, totalAmountRaw],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      setPhase('setting-up-plan');
      const setupPlanHash = await writeContractAsync({
        address: newVaultAddress,
        abi: DCA_VAULT_ABI,
        functionName: 'setupPlan',
        args: [inputToken, totalAmountRaw, duration, BigInt(interval), BigInt(firstExecutionTimestamp), targetTokens, targetBps],
      });
      await publicClient.waitForTransactionReceipt({ hash: setupPlanHash });

      setPhase('done');
    } catch (err) {
      const label =
        phase === 'creating-vault' ? 'Creating the vault' :
        phase === 'approving-buy' ? 'Approval' : 'Setting up the plan';
      setError(err instanceof Error ? `${label} failed: ${err.message}` : `${label} failed. Please try again.`);
      setPhase('idle');
    }
  };

  if (phase === 'done' && plan) {
    const inputTokenInfo = tokenForAddress(plan.setupPlanArgs.inputToken);
    return (
      <div className="screen screen--sub">
        <div className="app-bar">
          <span className="app-bar__spacer" />
          <span className="app-bar__title">Confirm Plan</span>
          <span className="app-bar__spacer" />
        </div>
        <div className="sell-done">
          <div className="sell-done__icon">✓</div>
          <p className="sell-done__title">Plan is live</p>
          <p className="sell-done__sub">
            {formatUnits(BigInt(plan.setupPlanArgs.totalAmount), inputTokenInfo.decimals)} {inputTokenInfo.symbol} will now buy across {plan.setupPlanArgs.duration} {INTERVAL_LABEL[plan.setupPlanArgs.interval] ?? ''} tranches.
          </p>
          {vaultAddress && (
            <a className="sell-done__link" href={`https://celoscan.io/address/${vaultAddress}`} rel="noreferrer">
              View vault ↗
            </a>
          )}
          <button type="button" className="btn-gold" onClick={() => navigate('/plans')}>
            View My Plans
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">Confirm Plan</span>
        <span className="app-bar__spacer" />
      </div>

      {!plan && (
        <>
          <p className="createcode-sub">
            Paste the plan code your AI assistant gave you after negotiating a strategy.
          </p>
          <div className="sell-card">
            <textarea
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="Paste plan code here"
              rows={4}
              style={{
                width: '100%', minHeight: 88, background: 'transparent', border: 'none', color: 'var(--text)',
                fontSize: 13, fontFamily: "'SF Mono','JetBrains Mono',ui-monospace,monospace", resize: 'vertical', outline: 'none',
              }}
            />
          </div>
          {parseError && <p className="createcode-error">{parseError}</p>}
          <button type="button" className="btn-gold" onClick={loadCode} disabled={codeInput.trim() === ''}>
            Load Plan
          </button>
        </>
      )}

      {plan && (
        <>
          <div style={{ padding: '0 18px 8px', display: 'flex', justifyContent: 'center' }}>
            <span style={{
              fontSize: 11, color: 'var(--text-faint)', background: 'var(--card)', border: '1px solid var(--border)',
              borderRadius: 999, padding: '5px 12px',
            }}>
              Proposed plan
            </span>
          </div>

          <div className="section-label">Buy</div>
          <div className="sell-card">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: "'SF Mono','JetBrains Mono',ui-monospace,monospace", fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>
                {formatUnits(BigInt(plan.setupPlanArgs.totalAmount), tokenForAddress(plan.setupPlanArgs.inputToken).decimals)} {tokenForAddress(plan.setupPlanArgs.inputToken).symbol}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {plan.setupPlanArgs.duration} {INTERVAL_LABEL[plan.setupPlanArgs.interval] ?? ''} tranches
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {plan.setupPlanArgs.targetTokens.map((t, i) => {
                const info = tokenForAddress(t);
                return (
                  <span key={t} className="tag" style={{ background: 'var(--gold-dim)', color: 'var(--gold-light)' }}>
                    <TokenIcon token={info.symbol as AnyTokenSymbol} size={15} />
                    {(plan.setupPlanArgs.targetBps[i] / 100).toFixed(0)}% {info.symbol}
                  </span>
                );
              })}
            </div>
          </div>

          <p className="fee-note">
            <b>Apis fee:</b> 0.99%, min. $0.035 per step — only charged when a step actually executes.
          </p>
          <p className="fee-note">
            Apis never holds your funds. You sign every step yourself in MiniPay.
          </p>

          {error && <p className="createcode-error">{error}</p>}

          <button type="button" className="btn-gold" onClick={handleConfirm} disabled={busy || !address}>
            {phase === 'creating-vault' ? 'Confirm vault creation in MiniPay…'
              : phase === 'approving-buy' ? 'Confirm approval in MiniPay…'
              : phase === 'setting-up-plan' ? 'Confirm plan setup in MiniPay…'
              : 'Confirm & Sign in MiniPay'}
          </button>
        </>
      )}
    </div>
  );
}
