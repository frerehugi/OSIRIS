import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection, usePublicClient, useWriteContract } from 'wagmi';
import { formatUnits, parseEventLogs, type Hex } from 'viem';
import { toDataSuffix } from '@celo/attribution-tags';
import {
  ERC20_ABI, DCA_VAULT_ABI, DCA_VAULT_FACTORY_ABI, FACTORY_ADDRESS,
  TARGET_TOKENS, INPUT_TOKENS, TRIGGER_VAULT_FACTORY_ADDRESS, SEND_VAULT_FACTORY_ADDRESS,
  ATTRIBUTION_TAG,
  type TokenInfo,
} from '../config';
import { TRIGGER_VAULT_ABI, TRIGGER_VAULT_FACTORY_ABI } from '../triggerVaultAbi';
import { SEND_VAULT_ABI, SEND_VAULT_FACTORY_ABI } from '../sendVaultAbi';
import type { AnyTokenSymbol } from '../tokenVisuals';
import TokenIcon from '../components/TokenIcon';

// Celo Attribution Tag (ERC-8021) — angehängt an jede Transaktion, die APIS
// selbst signieren lässt, damit sie in Celos Impact-/Reward-Tracking als
// APIS-Traffic zählt. In try/catch statt roh berechnet: ein ungültiger
// ATTRIBUTION_TAG-Platzhalter (z.B. Tippfehler beim Ersetzen) darf nicht den
// ganzen Confirm-Plan-Screen crashen — ohne Suffix bleibt der Screen
// funktionsfähig, nur eben (noch) nicht attributiert.
let DATA_SUFFIX: Hex | undefined;
try {
  DATA_SUFFIX = toDataSuffix(ATTRIBUTION_TAG) as Hex;
} catch {
  DATA_SUFFIX = undefined;
}

/// Confirm Plan — nimmt den Code entgegen, den propose_plan/propose_send_plan/
/// propose_direct_send (apis/backend) im Chat ausgeben, und führt ihn aus.
/// Ein einziger Screen/Button für alle drei Plan-Arten (siehe Chat: "confirm
/// plan und confirm send sind doch die gleichen Funktionen [...] dafür
/// reicht doch ein Button") — der Plan-Typ wird aus der Form des dekodierten
/// JSON selbst erkannt (isDcaPlan/isSendPlan/isDirectSend unten), nicht aus
/// einem separaten Menüpunkt. Genau wie schon vorher bei Buy+Sell-Trigger:
/// verschiedene Vault-Typen/Factories, aber ein Code/Screen.
///
/// DCA-Zweig (isDcaPlan): unverändert — spiegelt OSIRIS' eigenes
/// submitDcaPlan() in src/minipayWallet.ts 1:1 im Aufbau (createVault() →
/// approve() → setupPlan()), inkl. optionalem sellTrigger-Anhang über
/// TriggerVaultFactory/TriggerVault.
///
/// Send-Zweig (isSendPlan): dieselbe 3-Transaktionen-Sequenz, nur auf
/// SendVaultFactory/SendVault (siehe contracts/SendVault.sol) — kein Router,
/// kein minAmountOut, dafür ein RecipientPlan[]-Tupel-Array. Jede
/// Empfängeradresse wird in der Summary VOLL ausgeschrieben, nicht gekürzt
/// (siehe Sterntalers pageSummary()-Prinzip) — anders als der Rest von APIS,
/// wo eine gekürzte Adresse (0x1234...abcd) sonst Standard ist, weil hier
/// (anders als beim eigenen Address Book) kein vorab bestätigter Kontakt
/// dahintersteht.
///
/// Direct-Send-Zweig (isDirectSend): kein Vault, kein Keeper, keine Gebühr —
/// eine einzelne ERC20.transfer()-Tx (siehe planCompiler.ts,
/// compileDirectSend()-Kommentar zur Architekturentscheidung "Direkter
/// Transfer" für Stufe 1).
///
/// Der Plan-Code ist bewusst ein einfügbarer Text-Code statt eines Deep-
/// Links — gleiches Prinzip wie der Access-Grant-Code aus Create New Code
/// (siehe CreateCode.tsx): kein Backend/State nötig, um ihn zu übertragen,
/// nur base64url(JSON) von genau dem, was das jeweilige propose_*-Tool
/// zurückgibt.

interface DcaProposedPlan {
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
  triggerSell?: {
    priceUsd: number;
    setupPlanArgs: {
      heldToken:    `0x${string}`;
      outputToken:  `0x${string}`;
      watchToken:   `0x${string}`;
      amount:       string;
      triggerAbove: true;
      triggerPrice: string;
      expiresAt:    number;
    };
  };
}

interface SendProposedPlan {
  summary: string;
  setupPlanArgs: {
    token:                    `0x${string}`;
    recipients:               { wallet: `0x${string}`; totalAmount: string }[];
    duration:                 number;
    interval:                 number;
    firstExecutionTimestamp:  number;
  };
}

interface DirectSendProposedPlan {
  summary: string;
  transferArgs: {
    token:  `0x${string}`;
    to:     `0x${string}`;
    amount: string;
  };
}

type ProposedPlan = DcaProposedPlan | SendProposedPlan | DirectSendProposedPlan;

function isDirectSend(plan: ProposedPlan): plan is DirectSendProposedPlan {
  return 'transferArgs' in plan;
}
function isSendPlan(plan: ProposedPlan): plan is SendProposedPlan {
  return 'setupPlanArgs' in plan && 'recipients' in plan.setupPlanArgs;
}
function isDcaPlan(plan: ProposedPlan): plan is DcaProposedPlan {
  return 'setupPlanArgs' in plan && 'targetTokens' in plan.setupPlanArgs;
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
  if (!parsed?.setupPlanArgs && !parsed?.transferArgs) throw new Error('This code does not look like a plan code.');
  return parsed as ProposedPlan;
}

const INTERVAL_LABEL: Record<number, string> = { 3_600: 'hourly', 86_400: 'daily', 604_800: 'weekly' };

type Phase =
  | 'idle'
  | 'creating-vault' | 'approving-buy' | 'setting-up-plan'
  | 'creating-sell-vault' | 'approving-sell' | 'setting-up-sell-plan'
  | 'creating-send-vault' | 'approving-send' | 'setting-up-send-plan'
  | 'sending'
  | 'done';

type SellOutcome = { status: 'created'; vaultAddress: `0x${string}` } | { status: 'skipped-no-balance' };

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
  const [sellOutcome, setSellOutcome] = useState<SellOutcome | null>(null);

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

    // ── Direct Send: kein Vault, eine Tx ────────────────────────────────
    if (isDirectSend(plan)) {
      try {
        setPhase('sending');
        const hash = await writeContractAsync({
          address: plan.transferArgs.token,
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [plan.transferArgs.to, BigInt(plan.transferArgs.amount)],
          dataSuffix: DATA_SUFFIX,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        setPhase('done');
      } catch (err) {
        setError(err instanceof Error ? `Send failed: ${err.message}` : 'Send failed. Please try again.');
        setPhase('idle');
      }
      return;
    }

    // ── Send Plan: eigener 3-Tx-Ablauf auf SendVaultFactory/SendVault ───
    if (isSendPlan(plan)) {
      let currentPhase: Phase = 'creating-send-vault';
      try {
        const { token, recipients, duration, interval, firstExecutionTimestamp } = plan.setupPlanArgs;
        const totalAmountRaw = recipients.reduce((sum, r) => sum + BigInt(r.totalAmount), 0n);
        const submitFirstExecutionTimestamp = Math.max(firstExecutionTimestamp, Math.floor(Date.now() / 1000) + 60);

        currentPhase = 'creating-send-vault';
        setPhase('creating-send-vault');
        const createVaultHash = await writeContractAsync({
          address: SEND_VAULT_FACTORY_ADDRESS,
          abi: SEND_VAULT_FACTORY_ABI,
          functionName: 'createVault',
          dataSuffix: DATA_SUFFIX,
        });
        const createVaultReceipt = await publicClient.waitForTransactionReceipt({ hash: createVaultHash });
        const [vaultCreatedEvent] = parseEventLogs({ abi: SEND_VAULT_FACTORY_ABI, eventName: 'VaultCreated', logs: createVaultReceipt.logs });
        const newVaultAddress = vaultCreatedEvent?.args.vault;
        if (!newVaultAddress) throw new Error('Vault was created, but its address could not be read from the event.');
        setVaultAddress(newVaultAddress);

        currentPhase = 'approving-send';
        setPhase('approving-send');
        const approveHash = await writeContractAsync({
          address: token, abi: ERC20_ABI, functionName: 'approve', args: [newVaultAddress, totalAmountRaw],
          dataSuffix: DATA_SUFFIX,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });

        currentPhase = 'setting-up-send-plan';
        setPhase('setting-up-send-plan');
        const setupPlanHash = await writeContractAsync({
          address: newVaultAddress,
          abi: SEND_VAULT_ABI,
          functionName: 'setupPlan',
          args: [
            token,
            recipients.map((r) => ({ wallet: r.wallet, totalAmount: BigInt(r.totalAmount) })),
            duration,
            BigInt(interval),
            BigInt(submitFirstExecutionTimestamp),
          ],
          dataSuffix: DATA_SUFFIX,
        });
        await publicClient.waitForTransactionReceipt({ hash: setupPlanHash });

        setPhase('done');
      } catch (err) {
        const label =
          currentPhase === 'creating-send-vault' ? 'Creating the vault' :
          currentPhase === 'approving-send' ? 'Approval' : 'Setting up the plan';
        setError(err instanceof Error ? `${label} failed: ${err.message}` : `${label} failed. Please try again.`);
        setPhase('idle');
      }
      return;
    }

    // ── DCA-Plan (+ optionaler Sell-Trigger) — unverändert ──────────────
    const { inputToken, totalAmount, duration, interval, firstExecutionTimestamp, targetTokens, targetBps } = plan.setupPlanArgs;
    const totalAmountRaw = BigInt(totalAmount);

    // propose_plan compiles firstExecutionTimestamp as "now + 60s" at the
    // moment the AI proposes the plan — but real submission happens later
    // (chat round-trip, app switch, an approve tx to wait for), so by the
    // time setupPlan() actually lands on-chain that timestamp can already be
    // in the past, and the contract reverts with InvalidTimestamp(). Reclamp
    // to "now + 60s" here, right before submission, instead of trusting the
    // AI-proposed value blindly.
    const submitFirstExecutionTimestamp = Math.max(
      firstExecutionTimestamp,
      Math.floor(Date.now() / 1000) + 60,
    );

    // React state updates (setPhase) are batched/async — reading `phase`
    // itself inside the catch block below would see the value from when
    // handleConfirm() was invoked (always 'idle'), not the phase active when
    // the error actually occurred. Track it separately, outside React state.
    let currentPhase: Phase = 'creating-vault';

    try {
      currentPhase = 'creating-vault';
      setPhase('creating-vault');
      const createVaultHash = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: DCA_VAULT_FACTORY_ABI,
        functionName: 'createVault',
        dataSuffix: DATA_SUFFIX,
      });
      const createVaultReceipt = await publicClient.waitForTransactionReceipt({ hash: createVaultHash });
      const [vaultCreatedEvent] = parseEventLogs({ abi: DCA_VAULT_FACTORY_ABI, eventName: 'VaultCreated', logs: createVaultReceipt.logs });
      const newVaultAddress = vaultCreatedEvent?.args.vault;
      if (!newVaultAddress) throw new Error('Vault was created, but its address could not be read from the event.');
      setVaultAddress(newVaultAddress);

      currentPhase = 'approving-buy';
      setPhase('approving-buy');
      const approveHash = await writeContractAsync({
        address: inputToken, abi: ERC20_ABI, functionName: 'approve', args: [newVaultAddress, totalAmountRaw],
        dataSuffix: DATA_SUFFIX,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      currentPhase = 'setting-up-plan';
      setPhase('setting-up-plan');
      const setupPlanHash = await writeContractAsync({
        address: newVaultAddress,
        abi: DCA_VAULT_ABI,
        functionName: 'setupPlan',
        args: [inputToken, totalAmountRaw, duration, BigInt(interval), BigInt(submitFirstExecutionTimestamp), targetTokens, targetBps],
        dataSuffix: DATA_SUFFIX,
      });
      await publicClient.waitForTransactionReceipt({ hash: setupPlanHash });

      // ── Angehängter Sell-Trigger (nur, wenn das sellToken JETZT SCHON in ausreichender Menge gehalten wird) ──
      if (plan.triggerSell) {
        const { heldToken, outputToken, watchToken, amount, triggerAbove, triggerPrice, expiresAt } = plan.triggerSell.setupPlanArgs;
        const sellAmountRaw = BigInt(amount);
        const currentBalance = await publicClient.readContract({
          address: heldToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [address],
        }) as bigint;

        if (currentBalance < sellAmountRaw) {
          setSellOutcome({ status: 'skipped-no-balance' });
        } else {
          currentPhase = 'creating-sell-vault';
          setPhase('creating-sell-vault');
          const createSellVaultHash = await writeContractAsync({
            address: TRIGGER_VAULT_FACTORY_ADDRESS, abi: TRIGGER_VAULT_FACTORY_ABI, functionName: 'createVault',
            dataSuffix: DATA_SUFFIX,
          });
          const createSellVaultReceipt = await publicClient.waitForTransactionReceipt({ hash: createSellVaultHash });
          const [sellVaultCreatedEvent] = parseEventLogs({ abi: TRIGGER_VAULT_FACTORY_ABI, eventName: 'VaultCreated', logs: createSellVaultReceipt.logs });
          const newSellVaultAddress = sellVaultCreatedEvent?.args.vault;
          if (!newSellVaultAddress) throw new Error('Sell vault was created, but its address could not be read from the event.');

          currentPhase = 'approving-sell';
          setPhase('approving-sell');
          const sellApproveHash = await writeContractAsync({
            address: heldToken, abi: ERC20_ABI, functionName: 'approve', args: [newSellVaultAddress, sellAmountRaw],
            dataSuffix: DATA_SUFFIX,
          });
          await publicClient.waitForTransactionReceipt({ hash: sellApproveHash });

          currentPhase = 'setting-up-sell-plan';
          setPhase('setting-up-sell-plan');
          const setupSellPlanHash = await writeContractAsync({
            address: newSellVaultAddress,
            abi: TRIGGER_VAULT_ABI,
            functionName: 'setupPlan',
            args: [heldToken, outputToken, watchToken, sellAmountRaw, triggerAbove, BigInt(triggerPrice), BigInt(expiresAt)],
            dataSuffix: DATA_SUFFIX,
          });
          await publicClient.waitForTransactionReceipt({ hash: setupSellPlanHash });

          setSellOutcome({ status: 'created', vaultAddress: newSellVaultAddress });
        }
      }

      setPhase('done');
    } catch (err) {
      const label =
        currentPhase === 'creating-vault' ? 'Creating the vault' :
        currentPhase === 'approving-buy' ? 'Approval' :
        currentPhase === 'setting-up-plan' ? 'Setting up the plan' :
        currentPhase === 'creating-sell-vault' ? 'Creating the sell vault' :
        currentPhase === 'approving-sell' ? 'Sell approval' : 'Setting up the sell plan';
      setError(err instanceof Error ? `${label} failed: ${err.message}` : `${label} failed. Please try again.`);
      setPhase('idle');
    }
  };

  if (phase === 'done' && plan) {
    if (isDirectSend(plan)) {
      const tokenInfo = tokenForAddress(plan.transferArgs.token);
      return (
        <div className="screen screen--sub">
          <div className="app-bar">
            <span className="app-bar__spacer" />
            <span className="app-bar__title">Confirm Plan</span>
            <span className="app-bar__spacer" />
          </div>
          <div className="sell-done">
            <div className="sell-done__icon">✓</div>
            <p className="sell-done__title">Sent</p>
            <p className="sell-done__sub">
              {formatUnits(BigInt(plan.transferArgs.amount), tokenInfo.decimals)} {tokenInfo.symbol} was sent to {plan.transferArgs.to}.
            </p>
            <button type="button" className="btn-gold" onClick={() => navigate('/home')}>
              Back to Home
            </button>
          </div>
        </div>
      );
    }

    if (isSendPlan(plan)) {
      const tokenInfo = tokenForAddress(plan.setupPlanArgs.token);
      const totalRaw = plan.setupPlanArgs.recipients.reduce((sum, r) => sum + BigInt(r.totalAmount), 0n);
      return (
        <div className="screen screen--sub">
          <div className="app-bar">
            <span className="app-bar__spacer" />
            <span className="app-bar__title">Confirm Plan</span>
            <span className="app-bar__spacer" />
          </div>
          <div className="sell-done">
            <div className="sell-done__icon">✓</div>
            <p className="sell-done__title">Send plan is live</p>
            <p className="sell-done__sub">
              {formatUnits(totalRaw, tokenInfo.decimals)} {tokenInfo.symbol} will now go out to {plan.setupPlanArgs.recipients.length} recipient{plan.setupPlanArgs.recipients.length === 1 ? '' : 's'}, {INTERVAL_LABEL[plan.setupPlanArgs.interval] ?? ''} over {plan.setupPlanArgs.duration} payout{plan.setupPlanArgs.duration === 1 ? '' : 's'}.
            </p>
            {vaultAddress && (
              <a className="sell-done__link" href={`https://celoscan.io/address/${vaultAddress}`} rel="noreferrer">
                View vault on Celoscan ↗
              </a>
            )}
            <button type="button" className="btn-gold" onClick={() => navigate('/plans')}>
              View My Plans
            </button>
          </div>
        </div>
      );
    }

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
          {plan.triggerSell && sellOutcome?.status === 'created' && (
            <p className="sell-done__sub">
              Sell trigger on {tokenForAddress(plan.triggerSell.setupPlanArgs.heldToken).symbol} (at or above ${plan.triggerSell.priceUsd.toLocaleString()}) is active.
            </p>
          )}
          {plan.triggerSell && sellOutcome?.status === 'skipped-no-balance' && (
            <p className="sell-done__sub">
              Sell trigger on {tokenForAddress(plan.triggerSell.setupPlanArgs.heldToken).symbol} wasn't set up — you don't hold enough of it yet. Set it up manually in OSIRIS once you do.
            </p>
          )}
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
            Paste the plan code your AI assistant gave you — works for buy plans, sell triggers, and sends.
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

      {/* ── Direct-Send-Zweig: eine Zeile, eine Tx ─────────────────────── */}
      {plan && isDirectSend(plan) && (
        <>
          <div style={{ padding: '0 18px 8px', display: 'flex', justifyContent: 'center' }}>
            <span style={{
              fontSize: 11, color: 'var(--text-faint)', background: 'var(--card)', border: '1px solid var(--border)',
              borderRadius: 999, padding: '5px 12px',
            }}>
              Proposed plan · detected: Direct send
            </span>
          </div>

          <div className="section-label">Send</div>
          <div className="sell-card">
            <div className="recipient-row">
              <TokenIcon token={tokenForAddress(plan.transferArgs.token).symbol as AnyTokenSymbol} size={26} />
              <span className="recipient-row__addr">{plan.transferArgs.to}</span>
              <span className="recipient-row__amt">
                {formatUnits(BigInt(plan.transferArgs.amount), tokenForAddress(plan.transferArgs.token).decimals)} {tokenForAddress(plan.transferArgs.token).symbol}
              </span>
            </div>
          </div>
          <p className="fee-note">No vault, no keeper, no fee — a single wallet transfer, sent right away.</p>
          <div className="warn-note">Double-check the address above. Sends cannot be reversed.</div>

          {error && <p className="createcode-error">{error}</p>}

          <button type="button" className="btn-gold" onClick={handleConfirm} disabled={busy || !address}>
            {phase === 'sending' ? 'Confirm send in MiniPay…' : 'Confirm & Sign in MiniPay'}
          </button>
        </>
      )}

      {/* ── Send-Plan-Zweig: mehrere Empfänger, geplant ────────────────── */}
      {plan && isSendPlan(plan) && (
        <>
          <div style={{ padding: '0 18px 8px', display: 'flex', justifyContent: 'center' }}>
            <span style={{
              fontSize: 11, color: 'var(--text-faint)', background: 'var(--card)', border: '1px solid var(--border)',
              borderRadius: 999, padding: '5px 12px',
            }}>
              Proposed plan · detected: Send
            </span>
          </div>

          <div className="section-label">Send</div>
          <div className="sell-card">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: "'SF Mono','JetBrains Mono',ui-monospace,monospace", fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>
                {formatUnits(plan.setupPlanArgs.recipients.reduce((sum, r) => sum + BigInt(r.totalAmount), 0n), tokenForAddress(plan.setupPlanArgs.token).decimals)} {tokenForAddress(plan.setupPlanArgs.token).symbol}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {plan.setupPlanArgs.duration} {INTERVAL_LABEL[plan.setupPlanArgs.interval] ?? ''} payout{plan.setupPlanArgs.duration === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          <div className="section-label">Recipients ({plan.setupPlanArgs.recipients.length})</div>
          <div className="sell-card">
            {plan.setupPlanArgs.recipients.map((r, i) => (
              <div className="recipient-row" key={r.wallet + i}>
                <span className="recipient-row__addr">{r.wallet}</span>
                <span className="recipient-row__amt">
                  {formatUnits(BigInt(r.totalAmount), tokenForAddress(plan.setupPlanArgs.token).decimals)} {tokenForAddress(plan.setupPlanArgs.token).symbol}
                </span>
              </div>
            ))}
          </div>
          <p className="fee-note">Paid out in {plan.setupPlanArgs.duration} equal {INTERVAL_LABEL[plan.setupPlanArgs.interval] ?? ''} instalments per recipient, starting in ~1 minute.</p>

          <p className="fee-note">
            <b>Fee:</b> 0.49% per payout, min. $0.009 — charged by the SendVault contract itself, only when a payout actually executes.
          </p>
          <p className="fee-note">
            APIS never holds your funds. You sign every step yourself in MiniPay.
          </p>
          <div className="warn-note">Double-check every address above. Sends cannot be reversed.</div>

          {error && <p className="createcode-error">{error}</p>}

          <button type="button" className="btn-gold" onClick={handleConfirm} disabled={busy || !address}>
            {phase === 'creating-send-vault' ? 'Confirm vault creation in MiniPay…'
              : phase === 'approving-send' ? 'Confirm approval in MiniPay…'
              : phase === 'setting-up-send-plan' ? 'Confirm plan setup in MiniPay…'
              : 'Confirm & Sign in MiniPay'}
          </button>
        </>
      )}

      {/* ── DCA-Plan-Zweig (+ optionaler Sell-Trigger) — unverändert ───── */}
      {plan && isDcaPlan(plan) && (
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

          {plan.triggerSell && (
            <>
              <div className="section-label">Sell</div>
              <div className="sell-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <TokenIcon token={tokenForAddress(plan.triggerSell.setupPlanArgs.heldToken).symbol as AnyTokenSymbol} size={16} />
                    {formatUnits(BigInt(plan.triggerSell.setupPlanArgs.amount), tokenForAddress(plan.triggerSell.setupPlanArgs.heldToken).decimals)} {tokenForAddress(plan.triggerSell.setupPlanArgs.heldToken).symbol}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--success)' }}>
                    at or above ${plan.triggerSell.priceUsd.toLocaleString()}
                  </span>
                </div>
              </div>
              <p className="sell-sub">Only created if you already hold enough of it — otherwise set up later from My Holdings.</p>
            </>
          )}

          <p className="fee-note">
            <b>Fee:</b> 0.99%, min. $0.035 per execution — charged by the OSIRIS contract itself, only when a step actually executes.
          </p>
          <p className="fee-note">
            APIS never holds your funds. You sign every step yourself in MiniPay.
          </p>

          {error && <p className="createcode-error">{error}</p>}

          <button type="button" className="btn-gold" onClick={handleConfirm} disabled={busy || !address}>
            {phase === 'creating-vault' ? 'Confirm vault creation in MiniPay…'
              : phase === 'approving-buy' ? 'Confirm approval in MiniPay…'
              : phase === 'setting-up-plan' ? 'Confirm plan setup in MiniPay…'
              : phase === 'creating-sell-vault' ? 'Confirm sell vault creation in MiniPay…'
              : phase === 'approving-sell' ? 'Confirm sell approval in MiniPay…'
              : phase === 'setting-up-sell-plan' ? 'Confirm sell plan setup in MiniPay…'
              : 'Confirm & Sign in MiniPay'}
          </button>
        </>
      )}
    </div>
  );
}
