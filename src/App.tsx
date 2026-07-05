import { useMemo, useState, type ReactNode } from 'react';
import { connectWallet, submitDcaPlan } from './minipayWallet';
import {
  TOKENS,
  WEEKDAYS,
  type TokenType,
  type Weekday,
  type InputToken,
  type DcaPlanState,
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

function getUtcTimeDisplay(localTime: string): string {
  const [hours, minutes] = localTime.split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return 'Invalid time';
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString().slice(11, 16);
}

const TOKEN_ICONS: Record<TokenType, string> = { wBTC: '₿', wETH: 'Ξ', CELO: 'C', XAUoT: '🥇' };

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
  const [formData, setFormData]     = useState<DcaPlanState>(() => createInitialFormState());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [txHash, setTxHash]           = useState<string | null>(null);

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

  const nextPage  = () => setFormData((p) => ({ ...p, step: Math.min(p.step + 1, MAX_STEP) }));
  const prevPage  = () => setFormData((p) => ({ ...p, step: Math.max(p.step - 1, 1) }));
  const resetForm = () => {
    setSubmitError(null);
    setIsSubmitting(false);
    setTxHash(null);
    setFormData(createInitialFormState());
  };

  const handleSliderChange = (token: TokenType, value: number) => {
    const safeValue   = Math.max(0, Math.min(TOTAL_PERCENT, value));
    const otherSum    = TOKENS.filter((t) => t !== token).reduce((sum, t) => sum + formData.percentages[t], 0);
    const maxAllowed  = TOTAL_PERCENT - otherSum;
    updateField('percentages', { ...formData.percentages, [token]: Math.min(safeValue, maxAllowed) });
  };

  const handleContractDeployment = async () => {
    const validation = validateFullPlan(formData);
    if (!validation.valid) { setSubmitError(validation.message ?? 'Please check your plan.'); return; }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const ownerAddress = await connectWallet();
      const receipt = await submitDcaPlan(formData, ownerAddress);
      setTxHash(receipt.transactionHash);
    } catch (error) {
      console.error('DCA plan submission failed', error);
      setSubmitError(error instanceof Error ? error.message : 'The wallet action failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (txHash) {
    return (
      <Card>
        <section className="stack center">
          <div style={{ fontSize: '3.5rem' }}>✅</div>
          <h2 style={{ color: '#6ee7b7' }}>Plan Submitted!</h2>
          <p>
            <strong>{formData.totalAmount} {formData.inputToken}</strong> over{' '}
            {formData.duration} {formData.interval === 'daily' ? 'days' : 'weeks'}
          </p>
          <a
            href={`https://celoscan.io/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="muted"
          >
            View transaction on Celoscan ↗
          </a>
          <Button onClick={resetForm}>Start Over</Button>
        </section>
      </Card>
    );
  }

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
            <Button onClick={() => { updateField('interval', 'daily'); nextPage(); }}>📅 Daily</Button>
            <Button variant="secondary" onClick={() => { updateField('interval', 'weekly'); nextPage(); }}>🗓 Weekly</Button>
          </div>
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
            label={`Number of ${formData.interval === 'daily' ? 'days' : 'weeks'}`}
            type="text"
            value={formData.duration}
            onChange={(value) => updateField('duration', value)}
            placeholder={formData.interval === 'daily' ? '10' : '4'}
            error={formData.duration ? durationValidation.message : undefined}
          />
          {duration > 0 && durationValidation.valid && (
            <div className="tranche">
              <span>Your tranche</span>
              <strong>
                {trancheAmount.toFixed(2)} {formData.inputToken} /{' '}
                {formData.interval === 'daily' ? 'day' : 'week'}
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
            <label htmlFor="executionTime">Local trigger time</label>
            <input
              id="executionTime"
              type="time"
              value={formData.executionTime}
              onChange={(event) => updateField('executionTime', event.target.value)}
            />
          </div>
          <div className="status info">
            ⏰ Executes {formData.interval === 'weekly' ? `every ${formData.executionDay}` : 'daily'} at{' '}
            {formData.executionTime} local time, currently {utcDisplay} UTC.
            <br />
            Timezone: {formData.timezone}
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
            <p>Duration: <strong>{formData.duration} {formData.interval === 'daily' ? 'days' : 'weeks'}</strong></p>
            <p>Tranche: <strong>{trancheAmount.toFixed(2)} {formData.inputToken}</strong></p>
            <hr />
            {TOKENS.filter((token) => formData.percentages[token] > 0).map((token) => (
              <p key={token}><strong>{formData.percentages[token]}%</strong> → {TOKEN_ICONS[token]} {token}</p>
            ))}
            <hr />
            <p>
              Schedule:{' '}
              <strong>
                {formData.interval === 'weekly' ? `every ${formData.executionDay}` : 'daily'} at{' '}
                {formData.executionTime}
              </strong>
            </p>
            <p>UTC reference: <strong>{utcDisplay}</strong></p>
            <p>Timezone: <strong>{formData.timezone}</strong></p>
          </div>
          {submitError && <p className="error">{submitError}</p>}
          <div className="button-row">
            <Button variant="danger" onClick={resetForm} disabled={isSubmitting}>✗ Decline</Button>
            <Button variant="success" onClick={handleContractDeployment} disabled={isSubmitting}>
              {isSubmitting ? '⏳ Preparing...' : '✓ Confirm'}
            </Button>
          </div>
        </section>
      )}

    </Card>
  );
}
