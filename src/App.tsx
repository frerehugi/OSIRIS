import { useMemo, useState, type ReactNode } from 'react';
import { connectWallet, submitDcaPlan, cancelDcaPlan, getUserVaults, readPlanStatus, type SubmitDcaPlanPhase } from './minipayWallet';
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
}

type View = 'connect' | 'vaultList' | 'wizard' | 'success';

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

// Abgeschlossene Pläne werden 24h nach der letzten Ausführung ausgeblendet, statt
// dauerhaft in der Liste zu bleiben. Der Contract speichert keinen expliziten
// "abgeschlossen am"-Zeitstempel — nach dem letzten executeStep() wurde
// nextExecutionTimestamp aber bereits um ein weiteres `interval` erhöht, daher
// ist (nextExecutionTimestamp - interval) die beste verfügbare Näherung für den
// Zeitpunkt der letzten Ausführung.
const HIDE_COMPLETED_AFTER_SECONDS = 24 * 60 * 60;

function isStaleCompletedVault(status: Awaited<ReturnType<typeof readPlanStatus>>): boolean {
  const lastExecutionTs = Number(status.nextExecutionTimestamp - status.interval);
  const ageSeconds = Date.now() / 1000 - lastExecutionTs;
  return ageSeconds > HIDE_COMPLETED_AFTER_SECONDS;
}

const TOKEN_ICONS: Record<TokenType, string> = { wBTC: '₿', wETH: 'Ξ', CELO: 'C', XAUoT: '🥇' };

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
      const rawSummaries = await Promise.all(
        vaultAddresses.map(async (vaultAddress): Promise<VaultSummary | null> => {
          const status = await readPlanStatus(vaultAddress);
          const vaultStatus = computeVaultStatus(status);
          if (vaultStatus === 'complete' && isStaleCompletedVault(status)) return null;
          return { address: vaultAddress, status: vaultStatus };
        }),
      );
      const summaries = rawSummaries.filter((s): s is VaultSummary => s !== null);
      setExistingVaults(summaries);
      setView(summaries.length > 0 ? 'vaultList' : 'wizard');
    } catch (error) {
      console.error('Loading existing vaults failed', error);
      setVaultsError(error instanceof Error ? error.message : 'Could not load your vaults.');
      setView('wizard'); // Nutzer trotzdem nicht blockieren
    } finally {
      setVaultsLoading(false);
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
          {existingVaults.map((v) => (
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
            <Button onClick={startNewPlan}>+ New Plan</Button>
          </div>
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
          <div className="button-column">
            <Button variant="secondary" onClick={() => { updateField('interval', 'hourly'); nextPage(); }}>⚡ Hourly</Button>
            <Button onClick={() => { updateField('interval', 'daily'); nextPage(); }}>📅 Daily</Button>
            <Button variant="secondary" onClick={() => { updateField('interval', 'weekly'); nextPage(); }}>🗓 Weekly</Button>
          </div>
          {existingVaults.length > 0 && (
            <Button variant="secondary" onClick={() => setView('vaultList')}>← Back to My Plans</Button>
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
