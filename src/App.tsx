import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatUnits } from 'viem';
import {
  connectWallet, submitDcaPlan, cancelDcaPlan, getUserVaults, readPlanStatus, getUserPurchases,
  runInBatches, RPC_BATCH_SIZE, resolveInputTokenSymbol, getAddCashDeeplink,
  getUserTriggerVaults, submitTriggerPlan, cancelTriggerPlan, readTriggerVaultStatus, getTargetTokenBalance,
  type SubmitDcaPlanPhase, type PurchaseEvent, type SubmitTriggerPlanPhase,
} from './minipayWallet';
import { TARGET_TOKENS, INPUT_TOKENS as INPUT_TOKEN_INFO, INTERVAL_SECONDS } from './config';
import {
  TOKENS,
  WEEKDAYS,
  TIME_LIMIT_LABEL,
  type TokenType,
  type Weekday,
  type InputToken,
  type DcaPlanState,
  type Interval,
  type TriggerPlanState,
  type TriggerDirection,
} from './types';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const INPUT_TOKENS = ['USDC', 'USDT'] as const;

const TOTAL_PERCENT      = 100;
const MIN_TRANCHE        = 0.5;
const MAX_STEP           = 6;
const MAX_DURATION       = 365;
const MAX_AMOUNT_DECIMALS = 6;

interface ValidationResult {
  valid:    boolean;
  message?: string;
}

type VaultStatus = 'pending' | 'active' | 'cancelled' | 'complete';

interface VaultAsset {
  token: TokenType;
  bps:   number; // von 10_000 = 100%
}

interface VaultSummary {
  address: `0x${string}`;
  status:  VaultStatus;
  // Abschluss- bzw. Cancel-Zeitpunkt (Unix-Sekunden) für complete/cancelled —
  // null bei active/pending oder wenn der Zeitpunkt nicht ermittelbar ist
  // (z.B. ein außerhalb dieser App gecancelter Plan, siehe getCancelledAt()).
  // Wird nur für die Anzeige auf der History-Seite gebraucht.
  eventTimestamp: number | null;
  // Für die Plan-Karte (leer/0 bei status 'pending', da setupPlan() dort noch
  // nicht lief und der Contract entsprechend nur Default-Werte liefert).
  inputTokenSymbol: string;
  totalAmount:      bigint; // roh, 6 Dezimalstellen (USDC/USDT)
  interval:         Interval | null;
  currentStep:      number;
  totalSteps:       number;
  assets:           VaultAsset[];
}

// ─── Trigger-Plan-Zusammenfassung ("Your Plans", siehe TriggerVault.sol) ───────

type TriggerVaultStatus = 'pending' | 'active' | 'expired' | 'cancelled' | 'executed';

interface TriggerVaultSummary {
  address:         `0x${string}`;
  status:          TriggerVaultStatus;
  direction:       TriggerDirection;
  cryptoSymbol:    TokenType;  // immer die Krypto-Seite (== watchToken)
  stableSymbol:    InputToken; // immer die Stablecoin-Seite
  amountRaw:       bigint;     // Menge des heldToken (Buy: Stablecoin, Sell: Kryptotoken)
  heldDecimals:    number;
  triggerPriceUsd: number;
  expiresAt:       number; // 0 = zeitlich unbegrenzt
}

type View =
  | 'connect' | 'vaultList' | 'wizard' | 'success' | 'history' | 'purchases' | 'about' | 'terms' | 'privacy'
  | 'newPlanChoice' | 'triggerDirection' | 'triggerCoin' | 'triggerDetailsBuy' | 'triggerDetailsSell'
  | 'triggerSummary' | 'triggerSuccess';

const SUBMIT_PHASE_LABEL: Record<SubmitDcaPlanPhase, string> = {
  'creating-vault':   '⏳ Creating vault...',
  'approving':        '⏳ Approving USDC...',
  'setting-up-plan':  '⏳ Setting up plan...',
};

// Anders als SUBMIT_PHASE_LABEL keine feste Record-Map: welches Token
// freigegeben wird, hängt bei Trigger-Plänen von der Richtung ab
// (heldToken = Stablecoin bei Buy, Zieltoken bei Sell).
function triggerSubmitPhaseLabel(phase: SubmitTriggerPlanPhase, heldSymbol: string): string {
  if (phase === 'creating-vault') return '⏳ Creating vault...';
  if (phase === 'approving') return `⏳ Approving ${heldSymbol}...`;
  return '⏳ Setting up plan...';
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

const createInitialFormState = (): DcaPlanState => ({
  step:          1,
  interval:      null,
  totalAmount:   '',
  inputToken:    'USDC',
  percentages:   { wBTC: 0, wETH: 0, CELO: 0, XAUoT: 0 },
  duration:      '',
  executionTime: '12:00',
  executionDay:  'Monday',
  timezone:      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
});

const createInitialTriggerDraft = (): TriggerPlanState => ({
  direction: 'buy', cryptoSymbol: 'wBTC', stableSymbol: 'USDC', priceUsd: '', amountHuman: '', timeLimit: 'none',
});

function parseStrictDecimal(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const decimals = trimmed.split('.')[1]?.length ?? 0;
  if (decimals > MAX_AMOUNT_DECIMALS) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStrictPositiveInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validateAmount(amountText: string): ValidationResult {
  const amount = parseStrictDecimal(amountText);
  if (amount === null) return { valid: false, message: `Enter a valid amount with up to ${MAX_AMOUNT_DECIMALS} decimals.` };
  if (amount <= 0)    return { valid: false, message: 'Amount must be greater than zero.' };
  return { valid: true };
}

function validateDuration(durationText: string, totalAmountText: string, inputToken: InputToken): ValidationResult {
  const duration    = parseStrictPositiveInteger(durationText);
  const totalAmount = parseStrictDecimal(totalAmountText);
  if (duration === null)    return { valid: false, message: 'Duration must be a positive whole number.' };
  if (duration > MAX_DURATION) return { valid: false, message: `Duration cannot exceed ${MAX_DURATION}.` };
  if (totalAmount === null) return { valid: false, message: 'Enter a valid total amount first.' };
  const trancheAmount = totalAmount / duration;
  if (trancheAmount < MIN_TRANCHE) return { valid: false, message: `Each tranche must be at least ${MIN_TRANCHE.toFixed(2)} ${inputToken}.` };
  return { valid: true };
}

function validateFullPlan(formData: DcaPlanState): ValidationResult {
  if (!formData.interval)  return { valid: false, message: 'Choose daily or weekly investing.' };
  const amountValidation = validateAmount(formData.totalAmount);
  if (!amountValidation.valid) return amountValidation;
  const totalAllocated = TOKENS.reduce((sum, token) => sum + formData.percentages[token], 0);
  if (totalAllocated !== TOTAL_PERCENT) return { valid: false, message: 'Allocation must equal exactly 100%.' };
  const durationValidation = validateDuration(formData.duration, formData.totalAmount, formData.inputToken);
  if (!durationValidation.valid) return durationValidation;
  if (!/^\d{2}:\d{2}$/.test(formData.executionTime)) return { valid: false, message: 'Choose a valid execution time.' };
  return { valid: true };
}

const INTERVAL_UNIT: Record<Interval, { singular: string; plural: string }> = {
  hourly: { singular: 'hour', plural: 'hours' },
  daily:  { singular: 'day',  plural: 'days' },
  weekly: { singular: 'week', plural: 'weeks' },
};

function intervalUnit(interval: Interval | null, plural = true): string {
  const unit = INTERVAL_UNIT[interval ?? 'daily'];
  return plural ? unit.plural : unit.singular;
}

// Reverse-Lookup Contract-Sekunden -> Interval-Label, für die Plan-Karte
// (der Contract liefert nur den rohen Sekundenwert, siehe INTERVAL_SECONDS).
const INTERVAL_BY_SECONDS: Record<string, Interval> = Object.fromEntries(
  (Object.entries(INTERVAL_SECONDS) as [Interval, number][]).map(([key, seconds]) => [String(seconds), key]),
);

const INTERVAL_MODE_LABEL: Record<Interval, string> = {
  hourly: '⏱ Hourly',
  daily:  '📅 Daily',
  weekly: '📆 Weekly',
};

function formatHistoryTimestamp(eventTimestamp: number | null): string {
  if (eventTimestamp === null) return 'Date unknown';
  return new Date(eventTimestamp * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function getUtcTimeDisplay(localTime: string): string {
  const [hours, minutes] = localTime.split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return 'Invalid time';
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString().slice(11, 16);
}

function computeVaultStatus(status: Awaited<ReturnType<typeof readPlanStatus>>): VaultStatus {
  if (!status.initialized) return 'pending';
  if (status.cancelled)    return 'cancelled';
  if (status.currentStep >= status.totalSteps) return 'complete';
  return 'active';
}

// Abgeschlossene und gecancelte Pläne werden sofort aus "Your Plans" entfernt
// und landen stattdessen auf der History-Seite (siehe view === 'history') —
// eventTimestamp wird dort nur noch zur Anzeige gebraucht, nicht mehr für
// eine Verzögerung.

// Der Contract speichert keinen expliziten "abgeschlossen am"-Zeitstempel —
// nach dem letzten executeStep() wurde nextExecutionTimestamp aber bereits um
// ein weiteres `interval` erhöht, daher ist (nextExecutionTimestamp - interval)
// die beste verfügbare Näherung für den Zeitpunkt der letzten Ausführung.
function completedEventTimestamp(status: Awaited<ReturnType<typeof readPlanStatus>>): number {
  return Number(status.nextExecutionTimestamp - status.interval);
}

// Für den Cancel-Zeitpunkt gibt es kein On-Chain-Äquivalent (cancelPlan()
// rührt nextExecutionTimestamp nicht an, das wäre also keine brauchbare
// Näherung). Stattdessen wird der Zeitpunkt beim Canceln lokal gemerkt — kennt
// die App ihn nicht (z.B. Cancel von einem anderen Gerät aus), gilt der Plan
// als nicht-veraltet und bleibt sicherheitshalber sichtbar.
const CANCELLED_AT_KEY_PREFIX = 'osiris_cancelledAt_';

function recordCancelledAt(vaultAddress: string): void {
  try {
    localStorage.setItem(CANCELLED_AT_KEY_PREFIX + vaultAddress, String(Date.now()));
  } catch {
    // localStorage kann in manchen eingebetteten WebViews blockiert sein — kein Blocker.
  }
}

function getCancelledAt(vaultAddress: string): number | null {
  try {
    const raw = localStorage.getItem(CANCELLED_AT_KEY_PREFIX + vaultAddress);
    return raw ? Number(raw) / 1000 : null; // ms -> s
  } catch {
    return null;
  }
}

const TOKEN_ICONS: Record<TokenType, string> = { wBTC: '₿', wETH: 'Ξ', CELO: 'C', XAUoT: '🥇' };
const TOKEN_LABELS: Record<TokenType, string> = { wBTC: 'wBTC', wETH: 'wETH', CELO: 'CELO', XAUoT: 'Gold' };

// Original-Markenfarben aus den Squid-Router-Buy-Screens in MiniPay (Bitcoin-
// Orange, Ethereum-Blauviolett, Celo-Gelb), Gold nutzt den bestehenden
// Gold-Akzent der App statt einer weiteren Farbe.
const TOKEN_COLOR: Record<TokenType, string> = {
  wBTC:  '#F7931A',
  wETH:  '#627EEA',
  CELO:  '#FCFF52',
  XAUoT: 'var(--gold)',
};

// Textfarbe im Icon-Kreis — auf den hellen Untergründen (Celo-Gelb, Gold)
// braucht es dunklen statt weißen Text für genug Kontrast.
const TOKEN_ICON_TEXT: Record<TokenType, string> = {
  wBTC:  '#ffffff',
  wETH:  '#ffffff',
  CELO:  'var(--dark2)',
  XAUoT: 'var(--dark2)',
};

function TokenIcon({ token, size = 20 }: { token: TokenType; size?: number }) {
  return (
    <span
      className="token-icon"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.55,
        background: TOKEN_COLOR[token],
        color: TOKEN_ICON_TEXT[token],
      }}
    >
      {TOKEN_ICONS[token]}
    </span>
  );
}

// Wie viele Nachkommastellen pro Token sinnvoll angezeigt werden — an der
// jeweils üblichen Größenordnung der Beträge orientiert, nicht an den
// tatsächlichen On-Chain-Dezimalstellen (die wären für wBTC z.B. 8, aber so
// viele Nachkommastellen sind für die Anzeige nicht lesbar).
const TOKEN_DISPLAY_DECIMALS: Record<TokenType, number> = { wBTC: 6, wETH: 5, CELO: 2, XAUoT: 4 };

// Reverse-Lookup Zieltoken-Adresse -> TokenType, um DcaSwapExecuted-Events
// (die nur die Adresse mitliefern) den 4 UI-Kategorien zuzuordnen.
const TARGET_TOKEN_BY_ADDRESS: Record<string, TokenType> = Object.fromEntries(
  TOKENS.map((token) => [TARGET_TOKENS[token].address.toLowerCase(), token]),
) as Record<string, TokenType>;

function formatTokenAmount(raw: bigint, token: TokenType): string {
  const value = Number(formatUnits(raw, TARGET_TOKENS[token].decimals));
  return value.toFixed(TOKEN_DISPLAY_DECIMALS[token]);
}

// amountIn ist immer USDC oder USDT (beide 6 Dezimalstellen) — für die
// aggregierte Summe wird das bewusst nicht auf ein einzelnes Symbol
// festgelegt (siehe Aufruf-Stellen), um keinen falschen Token-Namen
// vorzutäuschen, wenn ein Nutzer mit beiden Stablecoins gekauft hat.
function formatInputAmount(raw: bigint): string {
  return Number(formatUnits(raw, 6)).toFixed(2);
}

// Der Keeper läuft stündlich (siehe .github/workflows/keeper.yml) — eine
// minutengenaue Startzeit würde also ohnehin nur ±1h eingehalten. Die Auswahl
// beschränkt sich deshalb bewusst auf volle Stunden.
const EXECUTION_HOURS = Array.from({ length: 24 }, (_, hour) => `${hour.toString().padStart(2, '0')}:00`);

// ─── Trigger-Plan-Hilfsfunktionen ──────────────────────────────────────────────

// Reverse-Lookup Stablecoin-Adresse -> Symbol, Pendant zu TARGET_TOKEN_BY_ADDRESS
// oben (welches die 4 Zieltoken abdeckt) — zusammen lässt sich damit jede
// heldToken/outputToken-Adresse eines TriggerVaults einem UI-Symbol zuordnen.
const STABLE_TOKEN_BY_ADDRESS: Record<string, InputToken> = Object.fromEntries(
  INPUT_TOKENS.map((symbol) => [INPUT_TOKEN_INFO[symbol].address.toLowerCase(), symbol]),
) as Record<string, InputToken>;

function computeTriggerStatus(
  initialized: boolean, cancelled: boolean, executed: boolean, expiresAt: number,
): TriggerVaultStatus {
  if (!initialized) return 'pending';
  if (cancelled) return 'cancelled';
  if (executed) return 'executed';
  if (expiresAt !== 0 && Date.now() / 1000 > expiresAt) return 'expired';
  return 'active';
}

const TRIGGER_STATUS_PILL_LABEL: Record<TriggerVaultStatus, string> = {
  pending:   'Setup incomplete',
  active:    'Active',
  expired:   'Expired',
  cancelled: 'Cancelled',
  executed:  'Complete',
};

// Wiederverwendung der vorhandenen pending/active/cancelled/complete-Klassen
// (siehe App.css) statt eigener CSS für 'expired'/'executed' — 'expired'
// sieht wie 'cancelled' aus (beide "muss der User selbst noch cancel()en"),
// 'executed' wie 'complete'.
function triggerStatusClass(status: TriggerVaultStatus): VaultStatus {
  if (status === 'executed') return 'complete';
  if (status === 'expired') return 'cancelled';
  return status;
}

function formatExpiry(expiresAt: number): string {
  if (expiresAt === 0) return 'No time limit';
  const diffMs = expiresAt * 1000 - Date.now();
  if (diffMs <= 0) return `Expired ${new Date(expiresAt * 1000).toLocaleDateString()}`;
  const days = Math.ceil(diffMs / 86_400_000);
  return days <= 1 ? 'Expires today' : `Expires in ${days} days`;
}

// Landing-Entscheidung nach Connect/Cancel: Ein Nutzer mit AUSSCHLIESSLICH
// Trigger-Plänen (keinen DCA-Plänen) soll genauso auf "Your Plans" landen wie
// jemand mit DCA-Plänen — nicht blind in den DCA-Wizard gedrängt werden.
function hasVisiblePlans(dcaVaults: VaultSummary[], triggerVaults: TriggerVaultSummary[]): boolean {
  return dcaVaults.some((v) => v.status === 'active' || v.status === 'pending')
      || triggerVaults.some((v) => v.status === 'active' || v.status === 'pending');
}

// ─── UI-Komponenten ───────────────────────────────────────────────────────────

function Card({ children }: { children: ReactNode }) {
  return <main className="card">{children}</main>;
}

function Button({
  onClick, disabled, children, variant = 'primary', type = 'button',
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'success';
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      className={`button button-${variant}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function InputField({
  id, label, type, value, onChange, placeholder, min, step, error,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  min?: string;
  step?: string;
  error?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        min={min}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && <p id={`${id}-error`} className="error">{error}</p>}
    </div>
  );
}

const STATUS_PILL_LABEL: Record<VaultStatus, string> = {
  pending:   'Setup incomplete',
  active:    'Active',
  cancelled: 'Cancelled',
  complete:  'Complete',
};

// Kleine Übersichtsleiste der 4 Zieltoken oben auf "Your Plans" — rein
// dekorativ (keine Live-Kurse), zeigt auf einen Blick, welche Assets die App
// unterstützt, in den jeweiligen Markenfarben.
function TokenTicker() {
  return (
    <div className="ticker">
      {TOKENS.map((token) => (
        <div key={token} className="ticker-chip">
          <div className="ticker-dot" style={{ background: TOKEN_COLOR[token] }} />
          <div className="ticker-symbol">{TOKEN_LABELS[token]}</div>
        </div>
      ))}
    </div>
  );
}

// Zeigt einen Plan als Karte mit den 7 Kernfeldern (Vault, Status, Amount,
// Modus, Progress, Assets, plus einen optionalen Trailing-Slot für den
// Cancel-Button bzw. eine History-Zeitangabe) — genutzt sowohl in "Your
// Plans" (active/pending) als auch in "History" (complete/cancelled).
function PlanCard({ vault, extra }: { vault: VaultSummary; extra?: ReactNode }) {
  const progressPercent = vault.totalSteps > 0
    ? Math.min(100, (vault.currentStep / vault.totalSteps) * 100)
    : 0;
  const isMuted = vault.status === 'cancelled';

  return (
    <div className={`plan plan-${vault.status}`}>
      <div className="plan-vault">
        <span className="vault-address">
          🔗{' '}
          <a href={`https://celoscan.io/address/${vault.address}`} rel="noreferrer">
            {vault.address.slice(0, 6)}…{vault.address.slice(-4)} ↗
          </a>
        </span>
        <span className={`status-pill status-${vault.status}`}>{STATUS_PILL_LABEL[vault.status]}</span>
      </div>

      {vault.status !== 'pending' && (
        <>
          <div className="plan-meta">
            <div>
              <span className="amount-label">Amount</span>
              <span className="amount-value">{formatInputAmount(vault.totalAmount)} {vault.inputTokenSymbol}</span>
            </div>
            {vault.interval && <span className="mode-tag">{INTERVAL_MODE_LABEL[vault.interval]}</span>}
          </div>

          <div className="progress-block">
            <div className="progress-label">
              <span>Progress</span>
              <b>{vault.currentStep} / {vault.totalSteps} {intervalUnit(vault.interval)}</b>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>

          {vault.assets.length > 0 && (
            <div className="assets-block">
              <span className="assets-label">Assets</span>
              <div className="assets-bar">
                {vault.assets.map((asset) => (
                  <span
                    key={asset.token}
                    className={isMuted ? 'asset-seg-muted' : undefined}
                    style={{ width: `${asset.bps / 100}%`, background: isMuted ? undefined : TOKEN_COLOR[asset.token] }}
                  />
                ))}
              </div>
              <div className="assets-legend">
                {vault.assets.map((asset) => (
                  <span key={asset.token} className="legend-entry">
                    {isMuted
                      ? <span className="dot dot-muted" />
                      : <TokenIcon token={asset.token} size={15} />}
                    {(asset.bps / 100).toFixed(0)}% {TOKEN_LABELS[asset.token]}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {extra}
    </div>
  );
}

// Pendant zu PlanCard für Trigger-Pläne — gleiche Karten-Optik (Vault-Adresse,
// Status-Pill), aber statt Progress-Bar/Assets-Legende eine Preisbedingung als
// Klartext (kein "Fortschritt" bei einem einmaligen Trigger).
function TriggerPlanCard({ vault, extra }: { vault: TriggerVaultSummary; extra?: ReactNode }) {
  const isBuy = vault.direction === 'buy';
  const status = triggerStatusClass(vault.status);
  const amountText = isBuy
    ? `${formatUnits(vault.amountRaw, vault.heldDecimals)} ${vault.stableSymbol}`
    : `${formatTokenAmount(vault.amountRaw, vault.cryptoSymbol)} ${TOKEN_LABELS[vault.cryptoSymbol]}`;

  return (
    <div className={`plan plan-${status}`}>
      <div className="plan-vault">
        <span className="vault-address">
          🔗{' '}
          <a href={`https://celoscan.io/address/${vault.address}`} rel="noreferrer">
            {vault.address.slice(0, 6)}…{vault.address.slice(-4)} ↗
          </a>
        </span>
        <span className={`status-pill status-${status}`}>{TRIGGER_STATUS_PILL_LABEL[vault.status]}</span>
      </div>

      <div className="plan-meta">
        <div className="title-row">
          <TokenIcon token={vault.cryptoSymbol} size={20} />
          <strong>{isBuy ? 'Buy' : 'Sell'} {TOKEN_LABELS[vault.cryptoSymbol]}</strong>
        </div>
        <span className="mode-tag">⚡ {isBuy ? 'Buy Trigger' : 'Sell Trigger'}</span>
      </div>

      <div className="status info">
        {isBuy
          ? <>Buy <strong>{amountText}</strong> worth of {TOKEN_LABELS[vault.cryptoSymbol]} once price drops to <strong>${vault.triggerPriceUsd.toLocaleString()}</strong> or below.</>
          : <>Sell <strong>{amountText}</strong> once price rises to <strong>${vault.triggerPriceUsd.toLocaleString()}</strong> or above.</>}
      </div>
      <span className="muted" style={{ fontSize: '0.76rem' }}>{formatExpiry(vault.expiresAt)} · cancel any time</span>

      {extra}
    </div>
  );
}

// ─── Haupt-App ────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView]               = useState<View>('connect');
  const [walletAddress, setWalletAddress] = useState<`0x${string}` | null>(null);
  const [existingVaults, setExistingVaults] = useState<VaultSummary[]>([]);
  const [vaultsLoading, setVaultsLoading] = useState(false);
  const [vaultsError, setVaultsError]   = useState<string | null>(null);
  const [cancellingAddress, setCancellingAddress] = useState<`0x${string}` | null>(null);
  const [cancelError, setCancelError]   = useState<string | null>(null);
  const [confirmingAddress, setConfirmingAddress] = useState<`0x${string}` | null>(null);

  const [purchases, setPurchases]       = useState<PurchaseEvent[] | null>(null);
  const [purchasesLoading, setPurchasesLoading] = useState(false);
  const [purchasesProgress, setPurchasesProgress] = useState(0); // 0..1
  const [purchasesError, setPurchasesError]     = useState<string | null>(null);
  const [selectedToken, setSelectedToken]       = useState<TokenType | null>(null);

  const [formData, setFormData]       = useState<DcaPlanState>(() => createInitialFormState());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<SubmitDcaPlanPhase | null>(null);
  const [newVaultAddress, setNewVaultAddress] = useState<`0x${string}` | null>(null);

  // ── Trigger-Plan: gespeicherte Pläne ("Your Plans") ─────────────────────────
  const [triggerVaults, setTriggerVaults]           = useState<TriggerVaultSummary[]>([]);
  const [triggerCancellingAddress, setTriggerCancellingAddress] = useState<`0x${string}` | null>(null);
  const [triggerConfirmingAddress, setTriggerConfirmingAddress] = useState<`0x${string}` | null>(null);
  const [triggerCancelError, setTriggerCancelError] = useState<string | null>(null);

  // ── Trigger-Plan: neuer Plan (Wizard) ────────────────────────────────────────
  const [triggerDirectionChoice, setTriggerDirectionChoice] = useState<TriggerDirection | null>(null);
  const [triggerCoinChoice, setTriggerCoinChoice]     = useState<TokenType | null>(null);
  const [triggerDraft, setTriggerDraft]               = useState<TriggerPlanState>(createInitialTriggerDraft());
  const [sellBalances, setSellBalances]               = useState<Partial<Record<TokenType, bigint>>>({});
  const [sellBalancesLoading, setSellBalancesLoading] = useState(false);
  const [sellPercent, setSellPercent]                 = useState(50);
  const [triggerDetailsError, setTriggerDetailsError] = useState<string | null>(null);
  const [triggerSubmitError, setTriggerSubmitError]   = useState<string | null>(null);
  const [isTriggerSubmitting, setIsTriggerSubmitting] = useState(false);
  const [triggerSubmitPhase, setTriggerSubmitPhase]   = useState<SubmitTriggerPlanPhase | null>(null);
  const [newTriggerVaultAddress, setNewTriggerVaultAddress] = useState<`0x${string}` | null>(null);

  const updateTriggerField = <K extends keyof TriggerPlanState>(field: K, value: TriggerPlanState[K]) => {
    setTriggerDetailsError(null);
    setTriggerDraft((previous) => ({ ...previous, [field]: value }));
  };

  const updateField = <K extends keyof DcaPlanState>(field: K, value: DcaPlanState[K]) => {
    setSubmitError(null);
    setFormData((previous) => ({ ...previous, [field]: value }));
  };

  const totalAllocated = useMemo(
    () => TOKENS.reduce((sum, token) => sum + formData.percentages[token], 0),
    [formData.percentages],
  );

  // "Your Plans" zeigt nur aktive/noch einzurichtende Pläne — abgeschlossene
  // und gecancelte wandern sofort in "History" (siehe historyEntries unten).
  const visiblePlans = useMemo(
    () => existingVaults.filter((v) => v.status === 'active' || v.status === 'pending'),
    [existingVaults],
  );
  const historyEntries = useMemo(
    () => existingVaults
      .filter((v) => v.status === 'complete' || v.status === 'cancelled')
      .sort((a, b) => (b.eventTimestamp ?? 0) - (a.eventTimestamp ?? 0)),
    [existingVaults],
  );

  // Trigger-Pläne haben (anders als DCA) noch keine History-Ansicht — einmal
  // gecancelt/ausgeführt verschwinden sie einfach aus "Your Plans" (weiterhin
  // einsehbar über den Celoscan-Link, den die Karte schon zeigte).
  const visibleTriggerPlans = useMemo(
    () => triggerVaults.filter((v) => v.status === 'active' || v.status === 'pending'),
    [triggerVaults],
  );

  // "My Purchases": alle DcaSwapExecuted-Events, nach Zieltoken gruppiert.
  const purchasesByToken = useMemo(() => {
    const groups: Record<TokenType, PurchaseEvent[]> = { wBTC: [], wETH: [], CELO: [], XAUoT: [] };
    if (!purchases) return groups;
    for (const purchase of purchases) {
      const token = TARGET_TOKEN_BY_ADDRESS[purchase.targetToken.toLowerCase()];
      if (token) groups[token].push(purchase);
    }
    return groups;
  }, [purchases]);

  const purchaseTotals = useMemo(() => {
    const totals = {} as Record<TokenType, { amountOut: bigint; amountIn: bigint; count: number }>;
    for (const token of TOKENS) {
      const rows = purchasesByToken[token];
      totals[token] = {
        amountOut: rows.reduce((sum, row) => sum + row.amountOut, 0n),
        amountIn:  rows.reduce((sum, row) => sum + row.amountIn, 0n),
        count:     rows.length,
      };
    }
    return totals;
  }, [purchasesByToken]);

  const totalInvested = useMemo(
    () => TOKENS.reduce((sum, token) => sum + purchaseTotals[token].amountIn, 0n),
    [purchaseTotals],
  );

  const remainingBudget     = TOTAL_PERCENT - totalAllocated;
  const amountValidation    = validateAmount(formData.totalAmount);
  const durationValidation  = validateDuration(formData.duration, formData.totalAmount, formData.inputToken);
  const totalAmount         = parseStrictDecimal(formData.totalAmount) ?? 0;
  const duration            = parseStrictPositiveInteger(formData.duration) ?? 0;
  const trancheAmount       = duration > 0 ? totalAmount / duration : 0;
  const utcDisplay          = getUtcTimeDisplay(formData.executionTime);

  // Stündliche Pläne haben keinen festen Tageszeitpunkt, daher überspringt der
  // Wizard für sie Schritt 5 (Zeitplan) in beide Richtungen.
  const nextPage = () => setFormData((p) => {
    let step = Math.min(p.step + 1, MAX_STEP);
    if (p.interval === 'hourly' && step === 5) step = 6;
    return { ...p, step };
  });
  const prevPage = () => setFormData((p) => {
    let step = Math.max(p.step - 1, 1);
    if (p.interval === 'hourly' && step === 5) step = 4;
    return { ...p, step };
  });

  const handleSliderChange = (token: TokenType, value: number) => {
    const safeValue   = Math.max(0, Math.min(TOTAL_PERCENT, value));
    const otherSum    = TOKENS.filter((t) => t !== token).reduce((sum, t) => sum + formData.percentages[t], 0);
    const maxAllowed  = TOTAL_PERCENT - otherSum;
    updateField('percentages', { ...formData.percentages, [token]: Math.min(safeValue, maxAllowed) });
  };

  // ── Wallet verbinden + eigene Vaults laden ────────────────────────────────

  // Gibt die geladenen Vaults zurück, statt selbst über den Ziel-View zu
  // entscheiden — loadVaults läuft asynchron im Hintergrund (RPC-Batches,
  // ~2s), und ein Aufrufer wie handleConnect kann inzwischen längst nicht
  // mehr an der Stelle sein, an der der Nutzer noch auf das Ergebnis wartet
  // (z.B. wenn er zwischenzeitlich manuell zu "About" navigiert hat). Der
  // Aufrufer entscheidet daher selbst, ob/wann und zu welchem View er anhand
  // der Rückgabe (kombiniert mit loadTriggerVaults(), siehe hasVisiblePlans)
  // navigiert.
  const loadVaults = async (address: `0x${string}`): Promise<VaultSummary[]> => {
    setVaultsLoading(true);
    setVaultsError(null);
    try {
      const vaultAddresses = await getUserVaults(address);
      // Gebatcht statt komplett parallel — bei vielen Vaults (je 8 Reads via
      // readPlanStatus) hat der öffentliche RPC-Knoten unter voller Last
      // wiederholt mit "Load failed" abgebrochen.
      const summaries = await runInBatches(vaultAddresses, RPC_BATCH_SIZE, async (vaultAddress): Promise<VaultSummary> => {
        const status = await readPlanStatus(vaultAddress);
        const vaultStatus = computeVaultStatus(status);
        const eventTimestamp =
          vaultStatus === 'complete'  ? completedEventTimestamp(status) :
          vaultStatus === 'cancelled' ? getCancelledAt(vaultAddress) :
          null;
        const assets: VaultAsset[] = status.targetConfigs
          .map((config) => ({
            token: TARGET_TOKEN_BY_ADDRESS[config.token.toLowerCase()],
            bps:   config.bps,
          }))
          .filter((asset): asset is VaultAsset => asset.token !== undefined);
        return {
          address:           vaultAddress,
          status:            vaultStatus,
          eventTimestamp,
          inputTokenSymbol:  resolveInputTokenSymbol(status.inputToken),
          totalAmount:       status.totalDeposited,
          interval:          INTERVAL_BY_SECONDS[String(status.interval)] ?? null,
          currentStep:       Number(status.currentStep),
          totalSteps:        Number(status.totalSteps),
          assets,
        };
      });
      setExistingVaults(summaries);
      return summaries;
    } catch (error) {
      console.error('Loading existing vaults failed', error);
      setVaultsError(error instanceof Error ? error.message : 'Could not load your vaults.');
      return []; // Nutzer trotzdem nicht blockieren
    } finally {
      setVaultsLoading(false);
    }
  };

  // Pendant zu loadVaults für Trigger-Pläne — gleiches Batching-Motiv (je 10
  // Reads via readTriggerVaultStatus pro Vault).
  const loadTriggerVaults = async (address: `0x${string}`): Promise<TriggerVaultSummary[]> => {
    try {
      const vaultAddresses = await getUserTriggerVaults(address);
      const summaries = await runInBatches(vaultAddresses, RPC_BATCH_SIZE, async (vaultAddress): Promise<TriggerVaultSummary | null> => {
        const status = await readTriggerVaultStatus(vaultAddress);
        const triggerStatus = computeTriggerStatus(status.initialized, status.cancelled, status.executed, Number(status.expiresAt));
        // heldToken bestimmt Richtung + Menge: Buy hält den Stablecoin, Sell
        // hält das Zieltoken (siehe TriggerVault-Architekturkommentar).
        const heldIsCrypto = TARGET_TOKEN_BY_ADDRESS[status.heldToken.toLowerCase()] !== undefined;
        const cryptoSymbol = heldIsCrypto
          ? TARGET_TOKEN_BY_ADDRESS[status.heldToken.toLowerCase()]
          : TARGET_TOKEN_BY_ADDRESS[status.outputToken.toLowerCase()];
        const stableSymbol = heldIsCrypto
          ? STABLE_TOKEN_BY_ADDRESS[status.outputToken.toLowerCase()]
          : STABLE_TOKEN_BY_ADDRESS[status.heldToken.toLowerCase()];
        if (!cryptoSymbol || !stableSymbol) return null; // unbekannte Token-Paarung, überspringen
        return {
          address:         vaultAddress,
          status:          triggerStatus,
          direction:       heldIsCrypto ? 'sell' : 'buy',
          cryptoSymbol,
          stableSymbol,
          amountRaw:       status.amount,
          heldDecimals:    heldIsCrypto ? TARGET_TOKENS[cryptoSymbol].decimals : INPUT_TOKEN_INFO[stableSymbol].decimals,
          triggerPriceUsd: Number(status.triggerPrice) / 1e8,
          expiresAt:       Number(status.expiresAt),
        };
      });
      const filtered = summaries.filter((s): s is TriggerVaultSummary => s !== null);
      setTriggerVaults(filtered);
      return filtered;
    } catch (error) {
      console.error('Loading trigger vaults failed', error);
      return [];
    }
  };

  // ── "My Purchases" öffnen ─────────────────────────────────────────────────
  //
  // Lädt bei jedem Öffnen frisch (statt zu cachen) — Swap-Events können sich
  // durch den stündlichen Keeper-Lauf jederzeit ändern, und die Liste ist
  // klein genug, dass ein Re-Fetch pro Klick unproblematisch ist.

  const openPurchases = async () => {
    setSelectedToken(null);
    setView('purchases');
    setPurchasesError(null);
    setPurchasesProgress(0);
    setPurchasesLoading(true);
    try {
      const vaultAddresses = existingVaults.map((v) => v.address);
      const events = await getUserPurchases(vaultAddresses, setPurchasesProgress);
      setPurchases(events);
    } catch (error) {
      console.error('Loading purchases failed', error);
      setPurchasesError(error instanceof Error ? error.message : 'Could not load your purchase history.');
    } finally {
      setPurchasesLoading(false);
    }
  };

  // Kein window.confirm() — MiniPays In-App-Browser (wie viele eingebettete
  // WebViews) unterdrückt native Dialoge und liefert sofort `false` zurück,
  // ohne den Dialog je anzuzeigen. Bestätigung läuft deshalb über einen
  // zweiten Klick innerhalb der App (confirmingAddress-State unten).

  const requestCancel = (vaultAddress: `0x${string}`) => {
    setCancelError(null);
    setConfirmingAddress(vaultAddress);
  };

  const abortCancel = () => setConfirmingAddress(null);

  const confirmCancel = async (vaultAddress: `0x${string}`) => {
    if (!walletAddress) return;
    setConfirmingAddress(null);
    setCancellingAddress(vaultAddress);
    setCancelError(null);
    try {
      await cancelDcaPlan(vaultAddress, walletAddress);
      recordCancelledAt(vaultAddress);
      const summaries = await loadVaults(walletAddress);
      setView(hasVisiblePlans(summaries, triggerVaults) ? 'vaultList' : 'newPlanChoice');
    } catch (error) {
      console.error('Cancel failed', error);
      setCancelError(error instanceof Error ? error.message : 'Cancel failed. Please try again.');
    } finally {
      setCancellingAddress(null);
    }
  };

  const handleConnect = async () => {
    setVaultsError(null);
    try {
      const address = await connectWallet();
      setWalletAddress(address);
      const [dcaSummaries, triggerSummaries] = await Promise.all([loadVaults(address), loadTriggerVaults(address)]);
      const nextView = hasVisiblePlans(dcaSummaries, triggerSummaries) ? 'vaultList' : 'newPlanChoice';
      // Nur übernehmen, wenn der Nutzer währenddessen nicht selbst schon
      // woanders hin navigiert hat (z.B. zu "About") — sonst würde das hier
      // die manuelle Navigation nach ein paar Sekunden Ladezeit überschreiben.
      setView((prev) => (prev === 'connect' ? nextView : prev));
    } catch (error) {
      console.error('Wallet connection failed', error);
      setVaultsError(error instanceof Error ? error.message : 'Wallet connection failed.');
    }
  };

  // MiniPay-Vorgabe: Verbindung passiert automatisch beim Laden, nie über
  // einen manuellen "Connect Wallet"-Button. Der Ref-Guard verhindert einen
  // doppelten Connect-Dialog durch Reacts StrictMode-Doppelaufruf in Dev.
  const autoConnectStarted = useRef(false);
  useEffect(() => {
    if (autoConnectStarted.current) return;
    autoConnectStarted.current = true;
    void handleConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startNewPlan = () => {
    setSubmitError(null);
    setNewVaultAddress(null);
    setFormData(createInitialFormState());
    setView('wizard');
  };

  const resetForm = () => {
    setSubmitError(null);
    setIsSubmitting(false);
    setSubmitPhase(null);
    setNewVaultAddress(null);
    setFormData(createInitialFormState());
    if (walletAddress) {
      void loadVaults(walletAddress).then((summaries) => {
        setView(hasVisiblePlans(summaries, triggerVaults) ? 'vaultList' : 'newPlanChoice');
      });
    } else {
      setView('connect');
    }
  };

  // ── Trigger-Plan: Wizard-Navigation ──────────────────────────────────────

  const openNewPlanChoice = () => setView('newPlanChoice');

  const startNewTriggerPlan = () => {
    setTriggerSubmitError(null);
    setNewTriggerVaultAddress(null);
    setTriggerDirectionChoice(null);
    setTriggerCoinChoice(null);
    setSellPercent(50);
    setTriggerDraft(createInitialTriggerDraft());
    setView('triggerDirection');
  };

  const chooseTriggerDirection = (direction: TriggerDirection) => {
    setTriggerDirectionChoice(direction);
    updateTriggerField('direction', direction);
  };

  // Guthaben nur für den Sell-Zweig geladen (Buy braucht keine Zieltoken-
  // Bilanz) — dieselbe on-chain balanceOf()-Quelle wie getTargetTokenBalance
  // in minipayWallet.ts, bewusst nicht aus den My-Purchases-Events (siehe dort).
  const loadSellBalances = async () => {
    if (!walletAddress) return;
    setSellBalancesLoading(true);
    try {
      const entries = await Promise.all(
        TOKENS.map(async (token) => [token, await getTargetTokenBalance(TARGET_TOKENS[token].address, walletAddress)] as const),
      );
      setSellBalances(Object.fromEntries(entries));
    } catch (error) {
      console.error('Loading sell balances failed', error);
    } finally {
      setSellBalancesLoading(false);
    }
  };

  const confirmTriggerDirection = () => {
    if (!triggerDirectionChoice) return;
    setTriggerCoinChoice(null);
    if (triggerDirectionChoice === 'sell') void loadSellBalances();
    setView('triggerCoin');
  };

  const chooseTriggerCoin = (token: TokenType) => {
    setTriggerCoinChoice(token);
    updateTriggerField('cryptoSymbol', token);
  };

  const confirmTriggerCoin = () => {
    if (!triggerCoinChoice || !triggerDirectionChoice) return;
    setTriggerDraft((previous) => ({
      ...previous,
      cryptoSymbol: triggerCoinChoice,
      stableSymbol: triggerDirectionChoice === 'buy' ? 'USDC' : 'USDT',
      priceUsd:     '',
      amountHuman:  '',
    }));
    setTriggerDetailsError(null);
    if (triggerDirectionChoice === 'sell') {
      setSellPercent(50);
      setView('triggerDetailsSell');
    } else {
      setView('triggerDetailsBuy');
    }
  };

  const sellBalanceRaw = triggerCoinChoice ? sellBalances[triggerCoinChoice] ?? 0n : 0n;
  const sellBalanceHuman = triggerCoinChoice ? Number(formatUnits(sellBalanceRaw, TARGET_TOKENS[triggerCoinChoice].decimals)) : 0;
  const sellAmountHuman = (sellBalanceHuman * sellPercent) / 100;

  const handleSellPercentChange = (percent: number) => {
    const safePercent = Math.max(1, Math.min(100, percent));
    setSellPercent(safePercent);
    const amount = (sellBalanceHuman * safePercent) / 100;
    // Wie viele Nachkommastellen sinnvoll sind, hängt vom Zieltoken ab (siehe
    // TOKEN_DISPLAY_DECIMALS) — On-Chain-Präzision (bis zu 18 Dezimalstellen)
    // würde nur zu für Menschen unlesbaren Beträgen führen.
    const decimals = triggerCoinChoice ? TOKEN_DISPLAY_DECIMALS[triggerCoinChoice] : 6;
    updateTriggerField('amountHuman', amount.toFixed(decimals));
  };

  const submitTriggerBuyDetails = () => {
    const priceValidation = validateAmount(triggerDraft.priceUsd);
    if (!priceValidation.valid) { setTriggerDetailsError(priceValidation.message ?? 'Enter a valid trigger price.'); return; }
    const amountValidationResult = validateAmount(triggerDraft.amountHuman);
    if (!amountValidationResult.valid) { setTriggerDetailsError(amountValidationResult.message ?? 'Enter a valid amount.'); return; }
    setTriggerDetailsError(null);
    setView('triggerSummary');
  };

  const submitTriggerSellDetails = () => {
    const priceValidation = validateAmount(triggerDraft.priceUsd);
    if (!priceValidation.valid) { setTriggerDetailsError(priceValidation.message ?? 'Enter a valid sell price.'); return; }
    if (sellAmountHuman <= 0) { setTriggerDetailsError('Your balance for this coin is 0.'); return; }
    setTriggerDetailsError(null);
    setView('triggerSummary');
  };

  const handleTriggerSubmit = async () => {
    setIsTriggerSubmitting(true);
    setTriggerSubmitError(null);
    try {
      const ownerAddress = walletAddress ?? await connectWallet();
      if (!walletAddress) setWalletAddress(ownerAddress);

      const result = await submitTriggerPlan(triggerDraft, ownerAddress, setTriggerSubmitPhase);
      setNewTriggerVaultAddress(result.vaultAddress);
      setView('triggerSuccess');
    } catch (error) {
      console.error('Trigger plan submission failed', error);
      setTriggerSubmitError(error instanceof Error ? error.message : 'The wallet action failed. Please try again.');
    } finally {
      setIsTriggerSubmitting(false);
      setTriggerSubmitPhase(null);
    }
  };

  const resetTriggerForm = () => {
    setTriggerSubmitError(null);
    setIsTriggerSubmitting(false);
    setTriggerSubmitPhase(null);
    setNewTriggerVaultAddress(null);
    setTriggerDraft(createInitialTriggerDraft());
    if (walletAddress) {
      void loadTriggerVaults(walletAddress).then((summaries) => {
        setView(hasVisiblePlans(existingVaults, summaries) ? 'vaultList' : 'newPlanChoice');
      });
    } else {
      setView('connect');
    }
  };

  // ── Trigger-Plan: Cancel (gleiches Zwei-Klick-Muster wie DCA, siehe oben) ──

  const requestTriggerCancel = (vaultAddress: `0x${string}`) => {
    setTriggerCancelError(null);
    setTriggerConfirmingAddress(vaultAddress);
  };

  const abortTriggerCancel = () => setTriggerConfirmingAddress(null);

  const confirmTriggerCancel = async (vaultAddress: `0x${string}`) => {
    if (!walletAddress) return;
    setTriggerConfirmingAddress(null);
    setTriggerCancellingAddress(vaultAddress);
    setTriggerCancelError(null);
    try {
      await cancelTriggerPlan(vaultAddress, walletAddress);
      await loadTriggerVaults(walletAddress);
    } catch (error) {
      console.error('Trigger cancel failed', error);
      setTriggerCancelError(error instanceof Error ? error.message : 'Cancel failed. Please try again.');
    } finally {
      setTriggerCancellingAddress(null);
    }
  };

  const handleContractDeployment = async () => {
    const validation = validateFullPlan(formData);
    if (!validation.valid) { setSubmitError(validation.message ?? 'Please check your plan.'); return; }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const ownerAddress = walletAddress ?? await connectWallet();
      if (!walletAddress) setWalletAddress(ownerAddress);

      const result = await submitDcaPlan(formData, ownerAddress, setSubmitPhase);
      setNewVaultAddress(result.vaultAddress);
      setView('success');
    } catch (error) {
      console.error('DCA plan submission failed', error);
      setSubmitError(error instanceof Error ? error.message : 'The wallet action failed. Please try again.');
    } finally {
      setIsSubmitting(false);
      setSubmitPhase(null);
    }
  };

  // ── View: Wallet verbinden ─────────────────────────────────────────────────

  if (view === 'connect') {
    return (
      <Card>
        <section className="stack center">
          {/* Verbindung passiert automatisch (siehe autoConnectStarted-Effekt oben) —
              kein sichtbarer "Connect Wallet"-Button. Das Banner selbst ist trotzdem
              antippbar und löst denselben Connect-Versuch erneut aus: manche WebViews
              blockieren eth_requestAccounts stillschweigend, wenn es nicht durch eine
              echte Nutzer-Geste (Tap/Click) ausgelöst wurde, nicht durch einen
              automatischen Aufruf beim Laden — ohne diesen Ausweg bliebe die Seite in
              dem Fall dauerhaft hängen. Kein sichtbarer Hinweis nötig: Auf ein
              scheinbar hängendes Bild zu tippen ist die natürliche Reaktion. */}
          <img
            src="./banner.jpg"
            alt="OSIRIS"
            className="banner"
            role="button"
            tabIndex={0}
            aria-label="Reconnect"
            style={{ cursor: 'pointer' }}
            onClick={() => { if (!vaultsLoading) void handleConnect(); }}
            onKeyDown={(event) => {
              if ((event.key === 'Enter' || event.key === ' ') && !vaultsLoading) handleConnect();
            }}
          />
          <h1>OSIRIS</h1>
          <p className="eyebrow">OSnabrück Investment and Risk Management System</p>
          <p className="muted" style={{ fontSize: '0.85rem', maxWidth: '32ch', margin: '0 auto' }}>
            Automatic crypto investing on Celo — on a schedule, or the moment your price is hit. Non-custodial,
            your vault, your keys.
          </p>
          {vaultsError && <p className="error">{vaultsError}</p>}
          <Button variant="secondary" onClick={() => setView('about')}>ℹ️ About OSIRIS</Button>
          <a
            href="https://apis.osirisapp.xyz/connect"
            rel="noreferrer"
            className="button button-secondary"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}
          >
            🐝 Manage OSIRIS with your AI
          </a>
        </section>
      </Card>
    );
  }

  // ── View: About ──────────────────────────────────────────────────────────

  if (view === 'about') {
    return (
      <Card>
        <section className="stack">
          <h2>ℹ️ About OSIRIS</h2>
          <p className="muted">
            OSIRIS is a non-custodial investing protocol on Celo. Two ways to use it: set up a{' '}
            <strong>DCA plan</strong> that automatically buys a diversified crypto basket from your USDC/USDT on a
            schedule you choose, or set a <strong>price trigger</strong> that buys or sells the moment your target
            price is hit — no manual swaps, no missed entries, no watching charts.
          </p>

          <div className="summary">
            <p><strong>🔒 Non-custodial</strong></p>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Your funds live in your own dedicated smart contract vault, created just for
              you. Only you can cancel a plan and withdraw — OSIRIS never holds custody.
            </p>
          </div>

          <div className="summary">
            <p><strong>🔄 How it works</strong></p>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              1. Configure your plan (amount, allocation/target price, interval)<br />
              2. Your own vault is created<br />
              3. An automated keeper executes it — on schedule, or once your price is hit<br />
              4. Assets arrive directly in your wallet
            </p>
          </div>

          <div className="summary">
            <p><strong>💰 Fees</strong></p>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              0.99% per execution, minimum $0.035 — whichever is higher. No hidden costs,
              no subscription.
            </p>
          </div>

          <div className="summary">
            <p><strong>🪙 Target assets</strong></p>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              wBTC · wETH · CELO · Gold (XAUoT) — choose your own allocation, nothing is fixed.
            </p>
          </div>

          <div className="summary">
            <p><strong>🐝 Manage with AI — Apis</strong></p>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Apis connects OSIRIS to your AI assistant — Claude, ChatGPT, Gemini, or Grok. Chat about your plan in
              plain language and it proposes one for you; nothing runs until you confirm and sign it yourself in
              MiniPay. Apis never holds your funds or private keys.
            </p>
            <a
              href="https://apis.osirisapp.xyz/connect"
              rel="noreferrer"
              className="muted"
              style={{ fontSize: '0.85rem' }}
            >
              Set up Apis for your AI assistant ↗
            </a>
          </div>

          <a
            href="https://celoscan.io/address/0xba148255d757912442A97f87c50DD2F65FBab7E0"
            rel="noreferrer"
            className="muted"
            style={{ fontSize: '0.85rem' }}
          >
            View verified contract on Celoscan ↗
          </a>

          <a href="https://t.me/osirisapp" rel="noreferrer" className="muted" style={{ fontSize: '0.85rem' }}>
            OSIRIS Telegram group — our only point of contact ↗
          </a>

          <div className="button-row">
            <Button variant="secondary" onClick={() => setView('terms')}>Terms</Button>
            <Button variant="secondary" onClick={() => setView('privacy')}>Privacy</Button>
          </div>

          <Button variant="secondary" onClick={() => setView('connect')}>← Back</Button>
        </section>
      </Card>
    );
  }

  // ── View: Terms and Conditions ───────────────────────────────────────────

  if (view === 'terms') {
    return (
      <Card>
        <section className="stack">
          <h2>📄 Terms and Conditions</h2>
          <p className="muted" style={{ fontSize: '0.8rem' }}>Last updated: August 2026</p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            OSIRIS, and Apis (the AI layer that talks to it), are independent, non-commercial projects built by
            Schmitz &amp; Hugenberg for two reasons: to push forward what's technically possible at the intersection
            of Web3 and AI agents, and because building this kind of thing is genuinely fun. Neither is a regulated
            financial product, a company, or a service with a business behind it — nothing in this app constitutes
            financial, investment, tax, or legal advice.
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            <strong>Experimental technology, no warranty.</strong> OSIRIS and Apis are built on very new, largely
            untested combinations of technology — EVM smart contracts, cross-chain DEX routing, off-chain price
            triggers with no on-chain oracle, and AI agents (Claude, ChatGPT, Gemini, Grok, and others) proposing
            transactions on your behalf. All of it — contracts, keeper infrastructure, this app, and Apis — is
            provided strictly "as is" and "as available", without any warranty of any kind, express or implied,
            including warranties of merchantability, fitness for a particular purpose, non-infringement,
            availability, accuracy, or freedom from errors, bugs, or vulnerabilities. Schmitz &amp; Hugenberg give
            absolutely no guarantee that any part of this will function correctly, securely, continuously, or at
            all — and specifically do not guarantee that unaudited smart contracts are free of exploitable bugs.
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            <strong>Use at your own risk.</strong> You use OSIRIS and Apis entirely at your own risk and
            exclusively with your own funds. Smart contracts and blockchain infrastructure can fail, be exploited,
            or behave unexpectedly; token prices are volatile and can lose most or all of their value; an AI
            assistant can misunderstand you or propose a plan that doesn't match your intent. You are solely
            responsible for reviewing anything an AI proposes and for evaluating whether to use OSIRIS or Apis at
            all. Never commit more than you can afford to lose entirely.
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            <strong>AI-assisted plans (Apis).</strong> An AI assistant connected via Apis can read your balances
            and propose a plan, but it can never move funds or execute anything by itself — every action still
            requires your own confirmation and signature in MiniPay. Schmitz &amp; Hugenberg do not control, and
            accept no responsibility for, the AI providers themselves (Anthropic, OpenAI, Google, xAI, or any
            other) or the accuracy of what they say or propose.
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            <strong>No liability.</strong> To the fullest extent permitted by law, Schmitz &amp; Hugenberg, their
            contributors, and anyone associated with OSIRIS or Apis accept no liability whatsoever for any direct,
            indirect, incidental, or consequential loss or damage — including loss of funds, tokens, or data —
            arising from your use of, or inability to use, OSIRIS or Apis, whether caused by a smart contract bug,
            a third-party service (including the Squid Router, any DEX it routes through, or any connected AI
            provider), network/RPC failures, wallet software, or any other cause.
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            <strong>Non-custodial.</strong> OSIRIS never takes custody of your funds. Each vault is your own smart
            contract; only you can cancel a plan and withdraw. This does not eliminate smart-contract or market
            risk — see above.
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            <strong>Research and hobby project, not a business.</strong> OSIRIS and Apis are a research and hobby
            effort, not a company with support SLAs or roadmap commitments. The OSIRIS Telegram group
            (t.me/osirisapp) is our only official point of contact — support there is offered on a best-effort
            basis and is not guaranteed, and we are not responsible for anyone or anything claiming to represent
            OSIRIS or Apis elsewhere. These terms may change at any time without prior notice; continued use of
            OSIRIS or Apis after a change constitutes acceptance of the updated terms.
          </p>
          <Button variant="secondary" onClick={() => setView('about')}>← Back</Button>
        </section>
      </Card>
    );
  }

  // ── View: Privacy Policy ─────────────────────────────────────────────────

  if (view === 'privacy') {
    return (
      <Card>
        <section className="stack">
          <h2>🔒 Privacy Policy</h2>
          <p className="muted" style={{ fontSize: '0.8rem' }}>Last updated: August 2026</p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            OSIRIS is a non-commercial passion project by Schmitz &amp; Hugenberg. This
            app does not run its own backend server, does not use analytics or tracking
            scripts, and does not ask for or store any personal information (name, email,
            phone number, etc.) — MiniPay/Trust Wallet identify you to OSIRIS only by your
            public wallet address.
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            <strong>On-chain data.</strong> Your wallet address, transactions, and vault
            activity are recorded on the public Celo blockchain by design — that is how
            any blockchain works, and it is outside OSIRIS's control. Anyone can view this
            public on-chain data (e.g. via Celoscan), independent of this app.
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            <strong>Local storage.</strong> This app stores a small cache of already-seen
            purchase history on your own device (browser/WebView local storage), purely to
            speed up loading. It never leaves your device and is not accessible to us.
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            <strong>Third parties.</strong> To function, OSIRIS talks directly from your
            device to: public Celo RPC nodes (to read/write blockchain data) and the Squid
            Router API (to find swap routes). These services may see your wallet address
            and IP address as part of normal network requests; OSIRIS does not control
            their own data handling — see their respective policies.
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Questions about this policy: the OSIRIS Telegram group (t.me/osirisapp) is our only official point of
            contact.
          </p>
          <Button variant="secondary" onClick={() => setView('about')}>← Back</Button>
        </section>
      </Card>
    );
  }

  // ── View: Liste bestehender Vaults ────────────────────────────────────────

  if (view === 'vaultList') {
    return (
      <Card>
        <section className="stack">
          <TokenTicker />
          <div className="view-header">
            <h2>📂 Your Plans</h2>
            <button className="view-header__info" type="button" aria-label="About OSIRIS" onClick={() => setView('about')}>ℹ️</button>
          </div>
          <div className="plan-list">
            {visiblePlans.map((v) => (
              <PlanCard
                key={v.address}
                vault={v}
                extra={v.status === 'active' ? (
                  confirmingAddress === v.address ? (
                    <div className="stack">
                      <p className="muted" style={{ fontSize: '0.85rem' }}>
                        Cancel this plan? Your remaining balance will be returned to your wallet. This cannot be undone.
                      </p>
                      <div className="button-row">
                        <Button variant="secondary" onClick={abortCancel}>No, keep it</Button>
                        <Button
                          variant="danger"
                          onClick={() => confirmCancel(v.address)}
                          disabled={cancellingAddress === v.address}
                        >
                          {cancellingAddress === v.address ? '⏳ Cancelling...' : 'Yes, Cancel'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button variant="danger" onClick={() => requestCancel(v.address)}>
                      ✗ Cancel Plan
                    </Button>
                  )
                ) : undefined}
              />
            ))}
            {visibleTriggerPlans.map((v) => (
              <TriggerPlanCard
                key={v.address}
                vault={v}
                extra={v.status === 'active' ? (
                  triggerConfirmingAddress === v.address ? (
                    <div className="stack">
                      <p className="muted" style={{ fontSize: '0.85rem' }}>
                        Cancel this plan? Your remaining balance will be returned to your wallet. This cannot be undone.
                      </p>
                      <div className="button-row">
                        <Button variant="secondary" onClick={abortTriggerCancel}>No, keep it</Button>
                        <Button
                          variant="danger"
                          onClick={() => confirmTriggerCancel(v.address)}
                          disabled={triggerCancellingAddress === v.address}
                        >
                          {triggerCancellingAddress === v.address ? '⏳ Cancelling...' : 'Yes, Cancel'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button variant="danger" onClick={() => requestTriggerCancel(v.address)}>
                      ✗ Cancel Plan
                    </Button>
                  )
                ) : undefined}
              />
            ))}
          </div>
          {cancelError && <p className="error">{cancelError}</p>}
          {triggerCancelError && <p className="error">{triggerCancelError}</p>}
          <div className="button-row">
            <Button variant="secondary" onClick={() => setView('connect')}>← Disconnect</Button>
            <Button variant="secondary" onClick={() => setView('history')}>🕘 History</Button>
            <Button variant="secondary" onClick={openPurchases}>💰 My Purchases</Button>
            <Button onClick={openNewPlanChoice}>+ New Plan</Button>
          </div>
        </section>
      </Card>
    );
  }

  // ── View: History (abgeschlossene + gecancelte Pläne) ─────────────────────

  if (view === 'history') {
    return (
      <Card>
        <section className="stack">
          <h2>🕘 Plan History</h2>
          {historyEntries.length === 0 && (
            <p className="muted">No past plans yet.</p>
          )}
          <div className="plan-list">
            {historyEntries.map((v) => (
              <PlanCard
                key={v.address}
                vault={v}
                extra={
                  <span className="cancelled-note">
                    {v.status === 'cancelled' ? 'Cancelled on' : 'Completed on'} {formatHistoryTimestamp(v.eventTimestamp)}
                  </span>
                }
              />
            ))}
          </div>
          <Button variant="secondary" onClick={() => setView('vaultList')}>← Back to My Plans</Button>
        </section>
      </Card>
    );
  }

  // ── View: My Purchases (Übersicht + Detail pro Token) ──────────────────────

  if (view === 'purchases') {
    // ── Sub-Screen: Detail-Liste für ein einzelnes Zieltoken ──────────────
    if (selectedToken) {
      const rows  = purchasesByToken[selectedToken];
      const total = purchaseTotals[selectedToken];
      return (
        <Card>
          <section className="stack">
            <h2 className="title-row"><TokenIcon token={selectedToken} size={26} /> {TOKEN_LABELS[selectedToken]} Purchases</h2>
            <div className="summary">
              <p>Total holdings: <strong>{formatTokenAmount(total.amountOut, selectedToken)} {TOKEN_LABELS[selectedToken]}</strong></p>
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                ≈ {formatInputAmount(total.amountIn)} USDC/USDT invested across {total.count} purchase{total.count === 1 ? '' : 's'}
              </p>
            </div>
            {rows.length === 0 && <p className="muted">No purchases yet.</p>}
            {rows.map((row) => (
              <div key={row.txHash + row.step} className="summary">
                <p>Step {row.step}: <strong>+{formatTokenAmount(row.amountOut, selectedToken)} {TOKEN_LABELS[selectedToken]}</strong></p>
                <p className="muted" style={{ fontSize: '0.8rem' }}>
                  for {formatInputAmount(row.amountIn)} {row.inputTokenSymbol} · {formatHistoryTimestamp(row.timestamp)}
                </p>
                <a
                  href={`https://celoscan.io/tx/${row.txHash}`}
                  rel="noreferrer"
                  style={{ fontSize: '0.8rem' }}
                >
                  {row.txHash.slice(0, 8)}…{row.txHash.slice(-6)} ↗
                </a>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setSelectedToken(null)}>← Back to My Purchases</Button>
          </section>
        </Card>
      );
    }

    // ── Sub-Screen: Übersicht mit den 4 Summen-Kacheln ─────────────────────
    return (
      <Card>
        <section className="stack">
          <h2>💰 My Purchases</h2>
          {purchasesLoading && (
            <div className="progress-block">
              <div className="progress-label">
                <span className="muted">⏳ Loading your purchase history...</span>
                <b>{Math.round(purchasesProgress * 100)}%</b>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.round(purchasesProgress * 100)}%` }} />
              </div>
            </div>
          )}
          {purchasesError && <p className="error">{purchasesError}</p>}
          {!purchasesLoading && !purchasesError && purchases && (
            <>
              <div className="summary">
                <p>Total invested: <strong>{formatInputAmount(totalInvested)} USDC/USDT</strong></p>
              </div>
              <div className="tile-grid">
                {TOKENS.map((token) => (
                  <button
                    key={token}
                    type="button"
                    className="tile"
                    onClick={() => setSelectedToken(token)}
                  >
                    <span className="tile-symbol"><TokenIcon token={token} size={16} /> {TOKEN_LABELS[token]}</span>
                    <span className="tile-amount">{formatTokenAmount(purchaseTotals[token].amountOut, token)}</span>
                    <span className="muted" style={{ fontSize: '0.75rem' }}>
                      {purchaseTotals[token].count} purchase{purchaseTotals[token].count === 1 ? '' : 's'}
                    </span>
                  </button>
                ))}
              </div>
              {purchases.length === 0 && <p className="muted">No purchases yet.</p>}
            </>
          )}
          <Button variant="secondary" onClick={() => setView('vaultList')}>← Back to My Plans</Button>
        </section>
      </Card>
    );
  }

  // ── View: Erfolg ───────────────────────────────────────────────────────────

  if (view === 'success' && newVaultAddress) {
    return (
      <Card>
        <section className="stack center">
          <div style={{ fontSize: '3.5rem' }}>✅</div>
          <h2 style={{ color: '#6ee7b7' }}>Plan Submitted!</h2>
          <p>
            <strong>{formData.totalAmount} {formData.inputToken}</strong> over{' '}
            {formData.duration} {intervalUnit(formData.interval)}
          </p>
          <a
            href={`https://celoscan.io/address/${newVaultAddress}`}
            rel="noreferrer"
            className="muted"
          >
            View vault {newVaultAddress.slice(0, 6)}…{newVaultAddress.slice(-4)} on Celoscan ↗
          </a>
          <Button onClick={resetForm}>Back to My Plans</Button>
        </section>
      </Card>
    );
  }

  // ── View: Neuer Plan — Typenauswahl ─────────────────────────────────────────

  if (view === 'newPlanChoice') {
    return (
      <Card>
        <section className="stack">
          <h2>✨ New Plan</h2>
          <p className="muted">Choose the kind of plan you want to set up.</p>
          {vaultsError && <p className="error">Could not load your existing plans: {vaultsError}</p>}
          <button className="new-plan-tile" type="button" onClick={startNewPlan}>
            <span className="new-plan-tile__icon">📅</span>
            <span>
              <span className="new-plan-tile__title" style={{ display: 'block' }}>DCA Plan</span>
              <span className="new-plan-tile__sub">Buy on a recurring schedule — hourly, daily, or weekly</span>
            </span>
            <span className="new-plan-tile__chev">›</span>
          </button>
          <button className="new-plan-tile" type="button" onClick={startNewTriggerPlan}>
            <span className="new-plan-tile__icon">⚡</span>
            <span>
              <span className="new-plan-tile__title" style={{ display: 'block' }}>Trigger Plan</span>
              <span className="new-plan-tile__sub">Buy or sell once your price is hit — one-shot, cancel any time</span>
            </span>
            <span className="new-plan-tile__chev">›</span>
          </button>
          {(visiblePlans.length > 0 || visibleTriggerPlans.length > 0) && (
            <Button variant="secondary" onClick={() => setView('vaultList')}>← Back to My Plans</Button>
          )}
        </section>
      </Card>
    );
  }

  // ── View: Trigger-Plan — Richtung ────────────────────────────────────────────

  if (view === 'triggerDirection') {
    return (
      <Card>
        <section className="stack">
          <h2>⚡ New Trigger Plan</h2>
          <p className="muted">Buy a coin once it drops to your price, or sell a holding once it rises to yours.</p>
          <div className="pill-toggle">
            <button
              type="button"
              className={triggerDirectionChoice === 'buy' ? 'active' : undefined}
              onClick={() => chooseTriggerDirection('buy')}
            >
              💰 Buy
            </button>
            <button
              type="button"
              className={triggerDirectionChoice === 'sell' ? 'active' : undefined}
              onClick={() => chooseTriggerDirection('sell')}
            >
              💸 Sell
            </button>
          </div>
          <div className="button-row">
            <Button variant="secondary" onClick={() => setView('newPlanChoice')}>← Back</Button>
            <Button onClick={confirmTriggerDirection} disabled={!triggerDirectionChoice}>Next →</Button>
          </div>
        </section>
      </Card>
    );
  }

  // ── View: Trigger-Plan — Coin-Auswahl ────────────────────────────────────────

  if (view === 'triggerCoin') {
    return (
      <Card>
        <section className="stack">
          <h2>{triggerDirectionChoice === 'buy' ? 'Which coin do you want to buy?' : 'Which holding do you want to sell?'}</h2>
          <div className="tile-grid">
            {TOKENS.map((token) => (
              <button
                key={token}
                type="button"
                className={triggerCoinChoice === token ? 'tile tile--selected' : 'tile'}
                onClick={() => chooseTriggerCoin(token)}
              >
                <span className="tile-symbol"><TokenIcon token={token} size={20} /> {TOKEN_LABELS[token]}</span>
                {triggerDirectionChoice === 'sell' && (
                  <span className="tile-balance">
                    {sellBalancesLoading
                      ? 'loading…'
                      : `${formatTokenAmount(sellBalances[token] ?? 0n, token)} held`}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="button-row">
            <Button variant="secondary" onClick={() => setView('triggerDirection')}>← Back</Button>
            <Button onClick={confirmTriggerCoin} disabled={!triggerCoinChoice}>Next →</Button>
          </div>
        </section>
      </Card>
    );
  }

  // ── View: Trigger-Plan — Details (Buy) ───────────────────────────────────────

  if (view === 'triggerDetailsBuy' && triggerCoinChoice) {
    return (
      <Card>
        <section className="stack">
          <h2 className="title-row"><TokenIcon token={triggerCoinChoice} size={20} /> Buy {TOKEN_LABELS[triggerCoinChoice]}</h2>
          <InputField
            id="buyTriggerPrice"
            label="Trigger price — buy at or below"
            type="text"
            value={triggerDraft.priceUsd}
            onChange={(value) => updateTriggerField('priceUsd', value)}
            placeholder="65000"
          />
          <div className="amount-row">
            <InputField
              id="buyTriggerAmount"
              label="Amount to spend"
              type="text"
              value={triggerDraft.amountHuman}
              onChange={(value) => updateTriggerField('amountHuman', value)}
              placeholder="100.00"
            />
            <div className="field token-select">
              <label htmlFor="buyTriggerStable">Token</label>
              <select
                id="buyTriggerStable"
                value={triggerDraft.stableSymbol}
                onChange={(event) => updateTriggerField('stableSymbol', event.target.value as InputToken)}
              >
                {INPUT_TOKENS.map((token) => (
                  <option key={token} value={token}>{token}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Time limit</label>
            <div className="pill-toggle">
              {(['1d', '1w', 'none'] as const).map((limit) => (
                <button
                  key={limit}
                  type="button"
                  className={triggerDraft.timeLimit === limit ? 'active' : undefined}
                  onClick={() => updateTriggerField('timeLimit', limit)}
                >
                  {TIME_LIMIT_LABEL[limit]}
                </button>
              ))}
            </div>
          </div>
          {triggerDetailsError && <p className="error">{triggerDetailsError}</p>}
          <div className="button-row">
            <Button variant="secondary" onClick={() => setView('triggerCoin')}>← Back</Button>
            <Button onClick={submitTriggerBuyDetails}>Next →</Button>
          </div>
        </section>
      </Card>
    );
  }

  // ── View: Trigger-Plan — Details (Sell) ──────────────────────────────────────

  if (view === 'triggerDetailsSell' && triggerCoinChoice) {
    return (
      <Card>
        <section className="stack">
          <h2 className="title-row"><TokenIcon token={triggerCoinChoice} size={20} /> Sell {TOKEN_LABELS[triggerCoinChoice]}</h2>
          <div className="slider-row">
            <div className="label-row">
              <label htmlFor="sellTriggerSlider">Amount to sell</label>
              <strong>{sellPercent}%</strong>
            </div>
            <input
              id="sellTriggerSlider"
              type="range"
              min="1"
              max="100"
              value={sellPercent}
              onChange={(event) => handleSellPercentChange(Number(event.target.value))}
              className={`slider-thumb-${triggerCoinChoice}`}
              style={{
                background: `linear-gradient(to right, ${TOKEN_COLOR[triggerCoinChoice]} 0%, ${TOKEN_COLOR[triggerCoinChoice]} ${sellPercent}%, rgba(255,255,255,0.12) ${sellPercent}%, rgba(255,255,255,0.12) 100%)`,
              }}
            />
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              {sellAmountHuman.toFixed(TOKEN_DISPLAY_DECIMALS[triggerCoinChoice])} of {formatTokenAmount(sellBalanceRaw, triggerCoinChoice)} {TOKEN_LABELS[triggerCoinChoice]}
            </span>
          </div>
          <div className="field">
            <label htmlFor="sellTriggerPrice">Sell price — sell at or above</label>
            <div className="amount-row">
              <input
                id="sellTriggerPrice"
                type="text"
                inputMode="decimal"
                value={triggerDraft.priceUsd}
                onChange={(event) => updateTriggerField('priceUsd', event.target.value)}
                placeholder="75000"
                style={{ flex: 1, minHeight: 42, padding: '10px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: 12, color: 'var(--text)', font: 'inherit' }}
              />
              <div className="field token-select" style={{ gap: 0 }}>
                <select
                  id="sellTriggerStable"
                  value={triggerDraft.stableSymbol}
                  onChange={(event) => updateTriggerField('stableSymbol', event.target.value as InputToken)}
                  style={{ minHeight: 42 }}
                >
                  {INPUT_TOKENS.map((token) => (
                    <option key={token} value={token}>{token}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="field">
            <label>Time limit</label>
            <div className="pill-toggle">
              {(['1d', '1w', 'none'] as const).map((limit) => (
                <button
                  key={limit}
                  type="button"
                  className={triggerDraft.timeLimit === limit ? 'active' : undefined}
                  onClick={() => updateTriggerField('timeLimit', limit)}
                >
                  {TIME_LIMIT_LABEL[limit]}
                </button>
              ))}
            </div>
          </div>
          {triggerDetailsError && <p className="error">{triggerDetailsError}</p>}
          <div className="button-row">
            <Button variant="secondary" onClick={() => setView('triggerCoin')}>← Back</Button>
            <Button onClick={submitTriggerSellDetails}>Next →</Button>
          </div>
        </section>
      </Card>
    );
  }

  // ── View: Trigger-Plan — Zusammenfassung ─────────────────────────────────────

  if (view === 'triggerSummary' && triggerCoinChoice) {
    const isBuy = triggerDraft.direction === 'buy';
    const priceNum = parseStrictDecimal(triggerDraft.priceUsd) ?? 0;
    const heldSymbol = isBuy ? triggerDraft.stableSymbol : TOKEN_LABELS[triggerCoinChoice];
    return (
      <Card>
        <section className="stack center">
          <h2>📋 Summary</h2>
          <div className="summary">
            <p className="title-row"><TokenIcon token={triggerCoinChoice} size={18} /> <strong>{isBuy ? 'Buy' : 'Sell'} {TOKEN_LABELS[triggerCoinChoice]}</strong></p>
            <hr />
            {isBuy ? (
              <>
                <p>Spend: <strong>{triggerDraft.amountHuman} {triggerDraft.stableSymbol}</strong></p>
                <p>Trigger: buy at or below <strong>${priceNum.toLocaleString()}</strong></p>
              </>
            ) : (
              <>
                <p>Amount: <strong>{triggerDraft.amountHuman} {TOKEN_LABELS[triggerCoinChoice]}</strong> ({sellPercent}% of holding)</p>
                <p>Trigger: sell at or above <strong>${priceNum.toLocaleString()}</strong></p>
              </>
            )}
            <p>Time limit: <strong>{TIME_LIMIT_LABEL[triggerDraft.timeLimit]}</strong></p>
            <hr />
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Cancel any time — locked funds return to your wallet immediately.
            </p>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Confirming requires 3 wallet transactions: creating your vault, approving {heldSymbol}, and starting the plan.
          </p>
          {triggerSubmitError && (
            <>
              <p className="error">{triggerSubmitError}</p>
              <a href={getAddCashDeeplink()} rel="noreferrer" className="muted" style={{ fontSize: '0.85rem' }}>
                Need more funds? Add cash via MiniPay ↗
              </a>
            </>
          )}
          <div className="button-row">
            <Button variant="danger" onClick={resetTriggerForm} disabled={isTriggerSubmitting}>✗ Decline</Button>
            <Button variant="success" onClick={handleTriggerSubmit} disabled={isTriggerSubmitting}>
              {isTriggerSubmitting ? triggerSubmitPhaseLabel(triggerSubmitPhase ?? 'creating-vault', heldSymbol) : '✓ Confirm'}
            </Button>
          </div>
        </section>
      </Card>
    );
  }

  // ── View: Trigger-Plan — Erfolg ──────────────────────────────────────────────

  if (view === 'triggerSuccess' && newTriggerVaultAddress && triggerCoinChoice) {
    const isBuy = triggerDraft.direction === 'buy';
    const priceNum = parseStrictDecimal(triggerDraft.priceUsd) ?? 0;
    return (
      <Card>
        <section className="stack center">
          <div style={{ fontSize: '3.5rem' }}>✅</div>
          <h2 style={{ color: '#6ee7b7' }}>Plan Submitted!</h2>
          <p>
            <strong>{triggerDraft.amountHuman} {isBuy ? triggerDraft.stableSymbol : TOKEN_LABELS[triggerCoinChoice]}</strong>{' '}
            {isBuy
              ? <>triggers when {TOKEN_LABELS[triggerCoinChoice]} drops to ${priceNum.toLocaleString()}</>
              : <>triggers when the price rises to ${priceNum.toLocaleString()}</>}
          </p>
          <a
            href={`https://celoscan.io/address/${newTriggerVaultAddress}`}
            rel="noreferrer"
            className="muted"
          >
            View vault {newTriggerVaultAddress.slice(0, 6)}…{newTriggerVaultAddress.slice(-4)} on Celoscan ↗
          </a>
          <Button onClick={resetTriggerForm}>Back to My Plans</Button>
        </section>
      </Card>
    );
  }

  // ── View: Wizard (Schritte 1–6) ────────────────────────────────────────────

  return (
    <Card>

      {/* ── Schritt 1: Intervall ─────────────────────────────────────────── */}
      {formData.step === 1 && (
        <section className="stack center">
          <img src="./banner.jpg" alt="OSIRIS" className="banner" />
          <h1>OSIRIS</h1>
          <p className="eyebrow">OSnabrück Investment and Risk Management System</p>
          {vaultsError && <p className="error">Could not load your existing plans: {vaultsError}</p>}
          <p className="muted">Choose how often the plan should invest.</p>
          <div className="pill-toggle">
            <button
              type="button"
              className={formData.interval === 'hourly' ? 'active' : undefined}
              onClick={() => updateField('interval', 'hourly')}
            >
              ⚡ Hourly
            </button>
            <button
              type="button"
              className={formData.interval === 'daily' ? 'active' : undefined}
              onClick={() => updateField('interval', 'daily')}
            >
              📅 Daily
            </button>
            <button
              type="button"
              className={formData.interval === 'weekly' ? 'active' : undefined}
              onClick={() => updateField('interval', 'weekly')}
            >
              🗓 Weekly
            </button>
          </div>
          <Button onClick={nextPage} disabled={!formData.interval}>Next →</Button>
          {(visiblePlans.length > 0 || visibleTriggerPlans.length > 0) && (
            <Button variant="secondary" onClick={() => setView('vaultList')}>← Back to My Plans</Button>
          )}
          {visiblePlans.length === 0 && visibleTriggerPlans.length === 0 && historyEntries.length > 0 && (
            <Button variant="secondary" onClick={() => setView('history')}>🕘 History</Button>
          )}
          {existingVaults.length > 0 && (
            <Button variant="secondary" onClick={openPurchases}>💰 My Purchases</Button>
          )}
        </section>
      )}

      {/* ── Schritt 2: Betrag ────────────────────────────────────────────── */}
      {formData.step === 2 && (
        <section className="stack">
          <h2>💰 Total Amount</h2>
          <div className="amount-row">
            <InputField
              id="totalAmount"
              label="Total amount"
              type="text"
              value={formData.totalAmount}
              onChange={(value) => updateField('totalAmount', value)}
              placeholder="100.00"
              error={formData.totalAmount ? amountValidation.message : undefined}
            />
            <div className="field token-select">
              <label htmlFor="inputToken">Token</label>
              <select
                id="inputToken"
                value={formData.inputToken}
                onChange={(event) => updateField('inputToken', event.target.value as InputToken)}
              >
                {INPUT_TOKENS.map((token) => (
                  <option key={token} value={token}>{token}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="button-row">
            <Button variant="secondary" onClick={prevPage}>← Back</Button>
            <Button onClick={nextPage} disabled={!amountValidation.valid}>Next →</Button>
          </div>
        </section>
      )}

      {/* ── Schritt 3: Allokation ────────────────────────────────────────── */}
      {formData.step === 3 && (
        <section className="stack">
          <h2>📊 Token Allocation</h2>
          {TOKENS.map((token) => (
            <div key={token} className="slider-row">
              <div className="label-row">
                <label htmlFor={`allocation-${token}`} className="title-row"><TokenIcon token={token} size={18} /> {token}</label>
                <strong>{formData.percentages[token]}%</strong>
              </div>
              <input
                id={`allocation-${token}`}
                type="range"
                min="0"
                max="100"
                value={formData.percentages[token]}
                onChange={(event) => handleSliderChange(token, Number(event.target.value))}
                className={`slider-thumb-${token}`}
                style={{
                  background: `linear-gradient(to right, ${TOKEN_COLOR[token]} 0%, ${TOKEN_COLOR[token]} ${formData.percentages[token]}%, rgba(255,255,255,0.12) ${formData.percentages[token]}%, rgba(255,255,255,0.12) 100%)`,
                }}
              />
            </div>
          ))}
          <div className={totalAllocated === TOTAL_PERCENT ? 'status success' : 'status warning'}>
            {totalAllocated === TOTAL_PERCENT ? '✅ 100% allocated' : `${remainingBudget}% remaining`}
          </div>
          <div className="button-row">
            <Button variant="secondary" onClick={prevPage}>← Back</Button>
            <Button onClick={nextPage} disabled={totalAllocated !== TOTAL_PERCENT}>Next →</Button>
          </div>
        </section>
      )}

      {/* ── Schritt 4: Laufzeit ──────────────────────────────────────────── */}
      {formData.step === 4 && (
        <section className="stack">
          <h2>⏱ Set Duration</h2>
          <InputField
            id="duration"
            label={`Number of ${intervalUnit(formData.interval)}`}
            type="text"
            value={formData.duration}
            onChange={(value) => updateField('duration', value)}
            placeholder={formData.interval === 'hourly' ? '24' : formData.interval === 'daily' ? '10' : '4'}
            error={formData.duration ? durationValidation.message : undefined}
          />
          {duration > 0 && durationValidation.valid && (
            <div className="tranche">
              <span>Your tranche</span>
              <strong>
                {trancheAmount.toFixed(2)} {formData.inputToken} /{' '}
                {intervalUnit(formData.interval, false)}
              </strong>
            </div>
          )}
          <div className="button-row">
            <Button variant="secondary" onClick={prevPage}>← Back</Button>
            <Button onClick={nextPage} disabled={!durationValidation.valid}>Next →</Button>
          </div>
        </section>
      )}

      {/* ── Schritt 5: Zeitplan ──────────────────────────────────────────── */}
      {formData.step === 5 && (
        <section className="stack">
          <h2>📅 Set Schedule</h2>
          {formData.interval === 'weekly' && (
            <div className="field">
              <label htmlFor="executionDay">Day of week</label>
              <select
                id="executionDay"
                value={formData.executionDay}
                onChange={(event) => updateField('executionDay', event.target.value as Weekday)}
              >
                {WEEKDAYS.map((day) => (
                  <option key={day} value={day}>{day}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="executionTime">Local trigger hour</label>
            <select
              id="executionTime"
              value={formData.executionTime}
              onChange={(event) => updateField('executionTime', event.target.value)}
            >
              {EXECUTION_HOURS.map((hour) => (
                <option key={hour} value={hour}>{hour}</option>
              ))}
            </select>
          </div>
          <div className="status info">
            ⏰ Executes {formData.interval === 'weekly' ? `every ${formData.executionDay}` : 'daily'} around{' '}
            {formData.executionTime} local time (±1 hour accuracy).
            <br />
            ≈ {utcDisplay} UTC · Timezone: {formData.timezone}
          </div>
          <div className="button-row">
            <Button variant="secondary" onClick={prevPage}>← Back</Button>
            <Button onClick={nextPage}>Next →</Button>
          </div>
        </section>
      )}

      {/* ── Schritt 6: Zusammenfassung ───────────────────────────────────── */}
      {formData.step === 6 && (
        <section className="stack center">
          <h2>📋 Summary</h2>
          <div className="summary">
            <p>Plan amount: <strong>{formData.totalAmount} {formData.inputToken}</strong></p>
            <p>Duration: <strong>{formData.duration} {intervalUnit(formData.interval)}</strong></p>
            <p>Tranche: <strong>{trancheAmount.toFixed(2)} {formData.inputToken}</strong></p>
            <hr />
            {TOKENS.filter((token) => formData.percentages[token] > 0).map((token) => (
              <p key={token} className="title-row"><strong>{formData.percentages[token]}%</strong> → <TokenIcon token={token} size={16} /> {token}</p>
            ))}
            <hr />
            {formData.interval === 'hourly' ? (
              <p>Schedule: <strong>every hour</strong></p>
            ) : (
              <>
                <p>
                  Schedule:{' '}
                  <strong>
                    {formData.interval === 'weekly' ? `every ${formData.executionDay}` : 'daily'} at{' '}
                    {formData.executionTime}
                  </strong>
                </p>
                <p>UTC reference: <strong>{utcDisplay}</strong></p>
                <p>Timezone: <strong>{formData.timezone}</strong></p>
              </>
            )}
          </div>
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Confirming requires 3 wallet transactions: creating your vault, approving USDC, and starting the plan.
          </p>
          {submitError && (
            <>
              <p className="error">{submitError}</p>
              {/* Häufigste Ursache für einen fehlgeschlagenen Approve/Transfer ist zu
                  wenig Guthaben — MiniPay-Vorgabe: dafür den offiziellen Add-Cash-
                  Deeplink anbieten statt einer eigenen Lösung. */}
              <a href={getAddCashDeeplink()} rel="noreferrer" className="muted" style={{ fontSize: '0.85rem' }}>
                Need more funds? Add cash via MiniPay ↗
              </a>
            </>
          )}
          <div className="button-row">
            <Button variant="danger" onClick={resetForm} disabled={isSubmitting}>✗ Decline</Button>
            <Button variant="success" onClick={handleContractDeployment} disabled={isSubmitting}>
              {isSubmitting ? SUBMIT_PHASE_LABEL[submitPhase ?? 'creating-vault'] : '✓ Confirm'}
            </Button>
          </div>
        </section>
      )}

    </Card>
  );
}
