import { useMemo, useState, type ReactNode } from 'react';
import { formatUnits } from 'viem';
import {
  connectWallet, submitDcaPlan, cancelDcaPlan, getUserVaults, readPlanStatus, getUserPurchases,
  type SubmitDcaPlanPhase, type PurchaseEvent,
} from './minipayWallet';
import { TARGET_TOKENS } from './config';
import {
  TOKENS,
  WEEKDAYS,
  type TokenType,
  type Weekday,
  type InputToken,
  type DcaPlanState,
  type Interval,
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

interface VaultSummary {
  address: `0x${string}`;
  status:  VaultStatus;
  // Abschluss- bzw. Cancel-Zeitpunkt (Unix-Sekunden) für complete/cancelled —
  // null bei active/pending oder wenn der Zeitpunkt nicht ermittelbar ist
  // (z.B. ein außerhalb dieser App gecancelter Plan, siehe getCancelledAt()).
  // Wird nur für die Anzeige auf der History-Seite gebraucht.
  eventTimestamp: number | null;
}

type View = 'connect' | 'vaultList' | 'wizard' | 'success' | 'history' | 'purchases';

const SUBMIT_PHASE_LABEL: Record<SubmitDcaPlanPhase, string> = {
  'creating-vault':   '⏳ Creating vault...',
  'approving':        '⏳ Approving USDC...',
  'setting-up-plan':  '⏳ Setting up plan...',
};

const VAULT_STATUS_LABEL: Record<VaultStatus, string> = {
  pending:   '⚠ Setup incomplete',
  active:    '🟢 Active',
  cancelled: '⨯ Cancelled',
  complete:  '✓ Complete',
};

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
  const [purchasesError, setPurchasesError]     = useState<string | null>(null);
  const [selectedToken, setSelectedToken]       = useState<TokenType | null>(null);

  const [formData, setFormData]       = useState<DcaPlanState>(() => createInitialFormState());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<SubmitDcaPlanPhase | null>(null);
  const [newVaultAddress, setNewVaultAddress] = useState<`0x${string}` | null>(null);

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

  const loadVaults = async (address: `0x${string}`) => {
    setVaultsLoading(true);
    setVaultsError(null);
    try {
      const vaultAddresses = await getUserVaults(address);
      const summaries = await Promise.all(
        vaultAddresses.map(async (vaultAddress): Promise<VaultSummary> => {
          const status = await readPlanStatus(vaultAddress);
          const vaultStatus = computeVaultStatus(status);
          const eventTimestamp =
            vaultStatus === 'complete'  ? completedEventTimestamp(status) :
            vaultStatus === 'cancelled' ? getCancelledAt(vaultAddress) :
            null;
          return { address: vaultAddress, status: vaultStatus, eventTimestamp };
        }),
      );
      setExistingVaults(summaries);
      const visibleCount = summaries.filter((s) => s.status === 'active' || s.status === 'pending').length;
      setView(visibleCount > 0 ? 'vaultList' : 'wizard');
    } catch (error) {
      console.error('Loading existing vaults failed', error);
      setVaultsError(error instanceof Error ? error.message : 'Could not load your vaults.');
      setView('wizard'); // Nutzer trotzdem nicht blockieren
    } finally {
      setVaultsLoading(false);
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
    setPurchasesLoading(true);
    try {
      const vaultAddresses = existingVaults.map((v) => v.address);
      const events = await getUserPurchases(vaultAddresses);
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
      await loadVaults(walletAddress);
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
      await loadVaults(address);
    } catch (error) {
      console.error('Wallet connection failed', error);
      setVaultsError(error instanceof Error ? error.message : 'Wallet connection failed.');
    }
  };

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
      void loadVaults(walletAddress);
    } else {
      setView('connect');
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
          <img src="./banner.jpg" alt="OSIRIS" className="banner" />
          <h1>OSIRIS</h1>
          <p className="eyebrow">OSnabrück Investment and Risk Management System</p>
          <p className="muted">Connect your wallet to view your plans or start a new one.</p>
          {vaultsError && <p className="error">{vaultsError}</p>}
          <Button onClick={handleConnect} disabled={vaultsLoading}>
            {vaultsLoading ? '⏳ Connecting...' : '👛 Connect Wallet'}
          </Button>
        </section>
      </Card>
    );
  }

  // ── View: Liste bestehender Vaults ────────────────────────────────────────

  if (view === 'vaultList') {
    return (
      <Card>
        <section className="stack">
          <h2>📂 Your Plans</h2>
          {visiblePlans.map((v) => (
            <div key={v.address} className="summary">
              <p>
                <span className="muted">Vault:</span>{' '}
                <a
                  href={`https://celoscan.io/address/${v.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {v.address.slice(0, 6)}…{v.address.slice(-4)} ↗
                </a>
              </p>
              <p>Status: <strong>{VAULT_STATUS_LABEL[v.status]}</strong></p>
              {v.status === 'active' && (
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
              )}
            </div>
          ))}
          {cancelError && <p className="error">{cancelError}</p>}
          <div className="button-row">
            <Button variant="secondary" onClick={() => setView('connect')}>← Disconnect</Button>
            <Button variant="secondary" onClick={() => setView('history')}>🕘 History</Button>
            <Button variant="secondary" onClick={openPurchases}>💰 My Purchases</Button>
            <Button onClick={startNewPlan}>+ New Plan</Button>
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
          {historyEntries.map((v) => (
            <div key={v.address} className="summary">
              <p>
                <span className="muted">Vault:</span>{' '}
                <a
                  href={`https://celoscan.io/address/${v.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {v.address.slice(0, 6)}…{v.address.slice(-4)} ↗
                </a>
              </p>
              <p>Status: <strong>{VAULT_STATUS_LABEL[v.status]}</strong></p>
              <p className="muted" style={{ fontSize: '0.8rem' }}>{formatHistoryTimestamp(v.eventTimestamp)}</p>
            </div>
          ))}
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
            <h2>{TOKEN_ICONS[selectedToken]} {TOKEN_LABELS[selectedToken]} Purchases</h2>
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
                  target="_blank"
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
          {purchasesLoading && <p className="muted">⏳ Loading your purchase history...</p>}
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
                    <span className="tile-symbol">{TOKEN_ICONS[token]} {TOKEN_LABELS[token]}</span>
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
            target="_blank"
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

  // ── View: Wizard (Schritte 1–6) ────────────────────────────────────────────

  return (
    <Card>

      {/* ── Schritt 1: Intervall ─────────────────────────────────────────── */}
      {formData.step === 1 && (
        <section className="stack center">
          <img src="./banner.jpg" alt="OSIRIS" className="banner" />
          <h1>OSIRIS</h1>
          <p className="eyebrow">OSnabrück Investment and Risk Management System</p>
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
          {visiblePlans.length > 0 && (
            <Button variant="secondary" onClick={() => setView('vaultList')}>← Back to My Plans</Button>
          )}
          {visiblePlans.length === 0 && historyEntries.length > 0 && (
            <Button variant="secondary" onClick={() => setView('history')}>🕘 History</Button>
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
                <label htmlFor={`allocation-${token}`}>{TOKEN_ICONS[token]} {token}</label>
                <strong>{formData.percentages[token]}%</strong>
              </div>
              <input
                id={`allocation-${token}`}
                type="range"
                min="0"
                max="100"
                value={formData.percentages[token]}
                onChange={(event) => handleSliderChange(token, Number(event.target.value))}
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
              <p key={token}><strong>{formData.percentages[token]}%</strong> → {TOKEN_ICONS[token]} {token}</p>
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
          {submitError && <p className="error">{submitError}</p>}
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
