import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useConnection, usePublicClient, useReadContracts, useWriteContract } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import {
  ERC20_ABI, TARGET_TOKENS, INPUT_TOKENS, CONDITIONAL_SELL_ORDER_ADDRESS, type TokenInfo,
} from '../config';
import { CONDITIONAL_SELL_ORDER_ABI } from '../conditionalSellOrderAbi';
import { TOKEN_COLOR, type AnyTokenSymbol } from '../tokenVisuals';
import TokenIcon from '../components/TokenIcon';

/// Sell Trigger — legt eine ConditionalSellOrder an (siehe Gesamtplan §9/§15,
/// contracts/ConditionalSellOrder.sol). Zwei On-Chain-Transaktionen, gleiches
/// Zwei-Schritt-Muster wie OSIRIS' eigener submitDcaPlan() in
/// src/minipayWallet.ts: erst ERC20-Approve (Betrag = aktueller Bestand, nicht
/// unbegrenzt — geringstmögliche Freigabe für eine Order mit maxExecutions=1),
/// dann createOrder(). triggerAbove/triggerPrice sind rein informativ (siehe
/// Contract-Kommentar) — der Apis-Keeper liest sie, um zu wissen, wann er
/// execute() aufruft; der Contract selbst prüft die Bedingung nicht.
///
/// maxExecutions ist in dieser ersten Version fest auf 1 ("einmalig") gesetzt,
/// genau wie im Mockup ("50% of your wBTC, once") — kein UI-Feld dafür.

type TargetSymbol = keyof typeof TARGET_TOKENS;
type AnySymbol = TargetSymbol | keyof typeof INPUT_TOKENS;

const SELL_SYMBOLS = Object.keys(TARGET_TOKENS) as TargetSymbol[];
const ALL_TOKENS: Record<AnySymbol, TokenInfo> = { ...TARGET_TOKENS, ...INPUT_TOKENS };
const ALL_SYMBOLS = Object.keys(ALL_TOKENS) as AnySymbol[];

const MAX_EXECUTIONS = 1;

function isTargetSymbol(value: string | null): value is TargetSymbol {
  return !!value && (SELL_SYMBOLS as string[]).includes(value);
}

function formatBalance(raw: bigint, decimals: number): string {
  return Number(formatUnits(raw, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

type Phase = 'idle' | 'approving' | 'creating' | 'done';

export default function SellTrigger() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { address } = useConnection();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const queryToken = searchParams.get('token');
  const [sellSymbol, setSellSymbol] = useState<TargetSymbol>(isTargetSymbol(queryToken) ? queryToken : 'wBTC');
  const [targetSymbol, setTargetSymbol] = useState<AnySymbol>('USDC');
  const [percent, setPercent] = useState(50);
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [priceInput, setPriceInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);

  const sellToken = TARGET_TOKENS[sellSymbol];
  const targetChoices = ALL_SYMBOLS.filter((symbol) => symbol !== sellSymbol);
  const resolvedTargetSymbol = targetChoices.includes(targetSymbol) ? targetSymbol : targetChoices[0];

  const { data: balanceResults, isLoading: balanceLoading } = useReadContracts({
    allowFailure: true,
    contracts: address
      ? [{ address: sellToken.address, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [address] as const }]
      : [],
  });
  const balanceResult = balanceResults?.[0];
  const balanceRaw = balanceResult?.status === 'success' ? (balanceResult.result as bigint) : null;

  const busy = phase === 'approving' || phase === 'creating';

  const handleSubmit = async () => {
    if (!address || !publicClient) return;
    setError(null);

    const priceNum = Number(priceInput.replace(/,/g, ''));
    if (!(priceNum > 0)) {
      setError('Enter a valid price greater than zero.');
      return;
    }
    if (!balanceRaw || balanceRaw === 0n) {
      setError(`You have no ${sellSymbol} to sell.`);
      return;
    }

    const bps = percent * 100;
    const triggerPrice = parseUnits(priceNum.toString(), 8);
    const targetTokenInfo = ALL_TOKENS[resolvedTargetSymbol];

    try {
      setPhase('approving');
      const approveHash = await writeContractAsync({
        address: sellToken.address,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [CONDITIONAL_SELL_ORDER_ADDRESS, balanceRaw],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      setPhase('creating');
      const createHash = await writeContractAsync({
        address: CONDITIONAL_SELL_ORDER_ADDRESS,
        abi: CONDITIONAL_SELL_ORDER_ABI,
        functionName: 'createOrder',
        args: [sellToken.address, targetTokenInfo.address, bps, MAX_EXECUTIONS, direction === 'above', triggerPrice],
      });
      await publicClient.waitForTransactionReceipt({ hash: createHash });

      setTxHash(createHash);
      setPhase('done');
    } catch (err) {
      const label = phase === 'approving' ? 'Approval' : 'Creating the sell trigger';
      setError(err instanceof Error ? `${label} failed: ${err.message}` : `${label} failed. Please try again.`);
      setPhase('idle');
    }
  };

  if (phase === 'done' && txHash) {
    return (
      <div className="screen screen--sub">
        <div className="app-bar">
          <span className="app-bar__spacer" />
          <span className="app-bar__title">Sell Trigger</span>
          <span className="app-bar__spacer" />
        </div>
        <div className="sell-done">
          <div className="sell-done__icon">✓</div>
          <p className="sell-done__title">Sell trigger created</p>
          <p className="sell-done__sub">
            Apis will watch the price and sell {percent}% of your {sellSymbol} for {resolvedTargetSymbol} once it goes {direction} ${priceInput}.
          </p>
          <a
            className="sell-done__link"
            href={`https://celoscan.io/tx/${txHash}`}
            rel="noreferrer"
          >
            View transaction ↗
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
        <span className="app-bar__title">Sell Trigger</span>
        <span className="app-bar__spacer" />
      </div>

      <div className="section-label">Sell</div>
      <div className="segmented segmented--4">
        {SELL_SYMBOLS.map((symbol) => (
          <button
            key={symbol}
            type="button"
            className={symbol === sellSymbol ? 'active' : undefined}
            onClick={() => setSellSymbol(symbol)}
          >
            <TokenIcon token={symbol as AnyTokenSymbol} size={14} /> {symbol}
          </button>
        ))}
      </div>
      <p className="sell-sub">
        {balanceLoading ? 'Loading balance…' : balanceRaw !== null ? `${formatBalance(balanceRaw, sellToken.decimals)} ${sellSymbol} held` : '— held'}
      </p>

      <div className="section-label">Amount to sell</div>
      <div className="sell-card">
        <div className="sell-amount">
          <div className="sell-amount__value">{percent}%</div>
          <div className="sell-amount__of">of your {sellSymbol}, once</div>
        </div>
        <input
          className={`sell-slider slider-thumb-${sellSymbol}`}
          type="range"
          min={1}
          max={100}
          value={percent}
          onChange={(e) => setPercent(Number(e.target.value))}
          style={{
            background: `linear-gradient(to right, ${TOKEN_COLOR[sellSymbol]} 0%, ${TOKEN_COLOR[sellSymbol]} ${percent}%, rgba(255,255,255,0.12) ${percent}%, rgba(255,255,255,0.12) 100%)`,
          }}
        />
      </div>

      <div className="section-label">For</div>
      <div className="sell-card sell-card--row">
        <select
          className="sell-select"
          value={resolvedTargetSymbol}
          onChange={(e) => setTargetSymbol(e.target.value as AnySymbol)}
        >
          {targetChoices.map((symbol) => (
            <option key={symbol} value={symbol}>{symbol}</option>
          ))}
        </select>
      </div>

      <div className="section-label">Condition</div>
      <div className="sell-card">
        <div className="segmented">
          <button type="button" className={direction === 'above' ? 'active' : undefined} onClick={() => setDirection('above')}>
            Price above
          </button>
          <button type="button" className={direction === 'below' ? 'active' : undefined} onClick={() => setDirection('below')}>
            Price below
          </button>
        </div>
        <div className="sell-price-row">
          <span>$</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
          />
          <span>USD</span>
        </div>
      </div>

      <p className="source-chip">Checked every 5 min by the Apis keeper (Squid price feed)</p>

      <p className="fee-note">
        <b>Apis fee:</b> 0.99%, min. $0.035 — only charged when this order actually executes. No hidden costs, no subscription.
      </p>

      {error && <p className="createcode-error">{error}</p>}

      <button type="button" className="btn-gold" onClick={handleSubmit} disabled={busy || !address}>
        {phase === 'approving' ? 'Confirm approval in MiniPay…' : phase === 'creating' ? 'Confirm in MiniPay…' : 'Create Sell Trigger'}
      </button>
      <p className="code-card__foot" style={{ margin: '10px 18px 24px', justifyContent: 'center' }}>
        You'll confirm this next in MiniPay
      </p>
    </div>
  );
}
