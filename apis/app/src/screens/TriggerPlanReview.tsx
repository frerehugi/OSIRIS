import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useConnection, usePublicClient, useWriteContract } from 'wagmi';
import { parseUnits, parseEventLogs } from 'viem';
import { ERC20_ABI, INPUT_TOKENS, TARGET_TOKENS, TRIGGER_VAULT_FACTORY_ADDRESS } from '../config';
import { TRIGGER_VAULT_ABI, TRIGGER_VAULT_FACTORY_ABI } from '../triggerVaultAbi';
import TokenIcon from '../components/TokenIcon';
import { TIME_LIMIT_LABEL, TIME_LIMIT_SECONDS, type TriggerPlanDraft } from '../triggerPlanTypes';

type Phase = 'idle' | 'creating-vault' | 'approving' | 'setting-up-plan' | 'done';

/// Letzter Schritt beider Trigger-Plan-Flows — Review + 3-Transaktionen-
/// Bestätigung (siehe Chat: "Set up vault, transfer USDC/USDT, Set up plan").
/// Spiegelt src/minipayWallet.ts' submitDcaPlan() im Aufbau (createVault() →
/// approve() → setupPlan()), hier auf TriggerVaultFactory/TriggerVault statt
/// DcaVaultFactory/DcaVault — siehe contracts/TriggerVault.sol.
export default function TriggerPlanReview() {
  const navigate = useNavigate();
  const location = useLocation();
  const { address } = useConnection();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const draft = location.state as TriggerPlanDraft | null;

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [vaultAddress, setVaultAddress] = useState<`0x${string}` | null>(null);

  if (!draft) {
    navigate('/trigger-setup', { replace: true });
    return null;
  }

  const cryptoToken = TARGET_TOKENS[draft.cryptoSymbol];
  const stableToken = INPUT_TOKENS[draft.stableSymbol];
  const isBuy = draft.direction === 'buy';

  const heldToken   = isBuy ? stableToken : cryptoToken;
  const outputToken = isBuy ? cryptoToken : stableToken;
  const watchToken  = cryptoToken;
  const triggerAbove = !isBuy; // Buy: Dip-Kauf (Preis <= Trigger) · Sell: Take-Profit (Preis >= Trigger)

  const busy = phase !== 'idle' && phase !== 'done';

  const handleConfirm = async () => {
    if (!address || !publicClient) return;
    setError(null);

    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(draft.amountHuman, heldToken.decimals);
    } catch {
      setError('Invalid amount.');
      return;
    }
    if (amountRaw <= 0n) { setError('Amount must be greater than zero.'); return; }

    const triggerPriceRaw = parseUnits(draft.priceUsd.toString(), 8);
    const limitSeconds = TIME_LIMIT_SECONDS[draft.timeLimit];
    const expiresAt = limitSeconds === 0 ? 0n : BigInt(Math.floor(Date.now() / 1000) + limitSeconds);

    try {
      setPhase('creating-vault');
      const createVaultHash = await writeContractAsync({
        address: TRIGGER_VAULT_FACTORY_ADDRESS, abi: TRIGGER_VAULT_FACTORY_ABI, functionName: 'createVault',
      });
      const createVaultReceipt = await publicClient.waitForTransactionReceipt({ hash: createVaultHash });
      const [vaultCreatedEvent] = parseEventLogs({ abi: TRIGGER_VAULT_FACTORY_ABI, eventName: 'VaultCreated', logs: createVaultReceipt.logs });
      const newVaultAddress = vaultCreatedEvent?.args.vault;
      if (!newVaultAddress) throw new Error('Vault was created, but its address could not be read from the event.');
      setVaultAddress(newVaultAddress);

      setPhase('approving');
      const approveHash = await writeContractAsync({
        address: heldToken.address, abi: ERC20_ABI, functionName: 'approve', args: [newVaultAddress, amountRaw],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      setPhase('setting-up-plan');
      const setupPlanHash = await writeContractAsync({
        address: newVaultAddress,
        abi: TRIGGER_VAULT_ABI,
        functionName: 'setupPlan',
        args: [heldToken.address, outputToken.address, watchToken.address, amountRaw, triggerAbove, triggerPriceRaw, expiresAt],
      });
      await publicClient.waitForTransactionReceipt({ hash: setupPlanHash });

      setPhase('done');
    } catch (err) {
      const label =
        phase === 'creating-vault' ? 'Creating the vault' :
        phase === 'approving' ? 'Approval' : 'Setting up the plan';
      setError(err instanceof Error ? `${label} failed: ${err.message}` : `${label} failed. Please try again.`);
      setPhase('idle');
    }
  };

  if (phase === 'done' && vaultAddress) {
    return (
      <div className="screen screen--sub">
        <div className="app-bar">
          <span className="app-bar__spacer" />
          <span className="app-bar__title">{isBuy ? 'Buy Plan' : 'Sell Plan'}</span>
          <span className="app-bar__spacer" />
        </div>
        <div className="sell-done">
          <div className="sell-done__icon">✓</div>
          <p className="sell-done__title">Plan is live</p>
          <p className="sell-done__sub">
            {isBuy
              ? `Apis will buy ${draft.amountHuman} ${draft.stableSymbol} worth of ${draft.cryptoSymbol} once the price drops to $${draft.priceUsd.toLocaleString()} or below.`
              : `Apis will sell ${draft.amountHuman} ${draft.cryptoSymbol} once the price reaches $${draft.priceUsd.toLocaleString()} or above.`}
            {' '}The result goes straight to your MiniPay wallet.
          </p>
          <a className="sell-done__link" href={`https://celoscan.io/address/${vaultAddress}`} rel="noreferrer">
            View vault ↗
          </a>
          <button type="button" className="btn-gold" onClick={() => navigate('/home')}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate(-1)} aria-label="Back">
          ‹
        </button>
        <span className="app-bar__title">{isBuy ? 'Review Buy Plan' : 'Review Sell Plan'}</span>
        <span className="app-bar__spacer" />
      </div>

      <div className="section-label">{isBuy ? 'Buy' : 'Sell'}</div>
      <div className="sell-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <TokenIcon token={draft.cryptoSymbol} size={22} />
          <span style={{ fontSize: 16, fontWeight: 700 }}>{draft.cryptoSymbol}</span>
        </div>
        {isBuy ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Spend <b style={{ color: 'var(--text)' }}>{draft.amountHuman} {draft.stableSymbol}</b> once the price drops to
            {' '}<b style={{ color: 'var(--success)' }}>${draft.priceUsd.toLocaleString()}</b> or below.
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Sell <b style={{ color: 'var(--text)' }}>{draft.amountHuman} {draft.cryptoSymbol}</b> for {draft.stableSymbol} once the price reaches
            {' '}<b style={{ color: 'var(--success)' }}>${draft.priceUsd.toLocaleString()}</b> or above.
          </div>
        )}
      </div>

      <div className="section-label">Time limit</div>
      <div className="sell-card">
        <span style={{ fontSize: 14 }}>{TIME_LIMIT_LABEL[draft.timeLimit]}</span>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '8px 0 0' }}>
          You can cancel this plan any time, whether or not it has a time limit.
        </p>
      </div>

      <p className="fee-note">
        <b>Apis fee:</b> 0.99%, min. $0.035 — only charged when the plan actually executes.
      </p>
      <p className="fee-note">
        Apis never holds your funds after this. Your {heldToken.symbol} sits in your own vault until it triggers, and you sign every step yourself in MiniPay.
      </p>

      {error && <p className="createcode-error">{error}</p>}

      <button type="button" className="btn-gold" onClick={handleConfirm} disabled={busy || !address}>
        {phase === 'creating-vault' ? 'Confirm vault creation in MiniPay…'
          : phase === 'approving' ? 'Confirm approval in MiniPay…'
          : phase === 'setting-up-plan' ? 'Confirm plan setup in MiniPay…'
          : 'Confirm & Sign in MiniPay'}
      </button>
      <p className="code-card__foot" style={{ margin: '10px 18px 24px', justifyContent: 'center' }}>
        3 taps in MiniPay: set up vault, transfer {heldToken.symbol}, set up plan
      </p>
    </div>
  );
}
