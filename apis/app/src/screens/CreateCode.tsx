import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection, useSignTypedData } from 'wagmi';

/// Access-Grant — siehe Gesamtplan §8/§20 (offene Frage "Signatur vs.
/// On-Chain-Registry", jetzt entschieden: Signatur). Kein Backend nötig, um
/// den Grant selbst gültig zu machen: der "Code" ist ein selbstständig
/// prüfbares Objekt (Nachricht + Signatur) — ein künftiger Apis-Verifier
/// (MCP-Server) kann die Signatur unabhängig gegen die behauptete Owner-
/// Adresse prüfen (ecrecover/verifyTypedData), ohne dass Apis vorher irgendwo
/// einen Datensatz angelegt haben müsste. Passt zu "Apis hält selbst keine
/// Token oder Berechtigungen".
///
/// Kein Verstoß gegen die MiniPay-Regel "kein Message-Signing zur Auth" —
/// die betrifft explizit den *Verbindungsaufbau* zur App selbst (siehe
/// wallet.ts, dort komplett ohne Signatur). Hier signiert der User eine
/// bewusste, separate Aktion (Drittanbieter-Freigabe), keine Anmeldung.

const DURATIONS = [
  { label: '1d',  seconds: 1 * 24 * 60 * 60 },
  { label: '5d',  seconds: 5 * 24 * 60 * 60 },
  { label: '14d', seconds: 14 * 24 * 60 * 60 },
  { label: '30d', seconds: 30 * 24 * 60 * 60 },
] as const;

const ACCESS_GRANT_TYPES = {
  AccessGrant: [
    { name: 'owner',     type: 'address' },
    { name: 'agent',     type: 'string' },
    { name: 'scope',     type: 'string' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'nonce',     type: 'uint256' },
  ],
} as const;

const ASSISTANTS = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude',  label: 'Claude'  },
  { id: 'gemini',  label: 'Gemini'  },
] as const;
type AssistantId = (typeof ASSISTANTS)[number]['id'];

function randomNonce(): bigint {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}

/// Kompakte, URL-sichere Kodierung von Nachricht + Signatur — kein Backend
/// nötig, um sie zu erzeugen; nötig ist eins erst, um sie später *anzuzeigen*
/// als hübschen Kurzcode (siehe Kommentar am Dateiende).
function encodeGrant(message: Record<string, string>, signature: `0x${string}`): string {
  const payload = JSON.stringify({ ...message, signature });
  return btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default function CreateCode() {
  const navigate = useNavigate();
  const { address } = useConnection();
  const { signTypedDataAsync, isPending } = useSignTypedData();

  const [assistant, setAssistant] = useState<AssistantId>('chatgpt');
  const [durationIndex, setDurationIndex] = useState(1); // Default 5d
  const [grantCode, setGrantCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const assistantLabel = ASSISTANTS.find((a) => a.id === assistant)!.label;

  const generateCode = async () => {
    if (!address) return;
    setError(null);
    setGrantCode(null);

    const duration  = DURATIONS[durationIndex];
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + duration.seconds);
    const nonce     = randomNonce();

    const message = {
      owner:     address,
      agent:     assistant,
      scope:     'read+propose',
      expiresAt,
      nonce,
    };

    try {
      const signature = await signTypedDataAsync({
        domain: { name: 'Apis', version: '1', chainId: 42220 },
        types:  ACCESS_GRANT_TYPES,
        primaryType: 'AccessGrant',
        message,
      });

      setGrantCode(encodeGrant(
        { ...message, expiresAt: expiresAt.toString(), nonce: nonce.toString() },
        signature,
      ));
    } catch {
      // Häufigster Fall: User hat in MiniPay abgelehnt — kein technischer Fehler.
      setError('Signing was cancelled. Tap "Generate" to try again.');
    }
  };

  const copyCode = async () => {
    if (!grantCode) return;
    await navigator.clipboard.writeText(grantCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">Create New Code</span>
        <span className="app-bar__spacer" />
      </div>

      <p className="createcode-sub">
        Grants <b>read + propose access only</b>, for a limited time you choose. Apis never holds your funds.
      </p>

      <div className="section-label">Choose assistant</div>
      <div className="assistant-row">
        {ASSISTANTS.map((a) => (
          <button
            key={a.id}
            type="button"
            className={a.id === assistant ? 'assistant assistant--active' : 'assistant'}
            onClick={() => setAssistant(a.id)}
          >
            {a.label}
          </button>
        ))}
      </div>

      <div className="section-label">Access window</div>
      <div className="segmented">
        {DURATIONS.map((duration, i) => (
          <button
            key={duration.label}
            type="button"
            className={i === durationIndex ? 'active' : undefined}
            onClick={() => setDurationIndex(i)}
          >
            {duration.label}
          </button>
        ))}
      </div>

      <div className="section-label">What {assistantLabel} can do</div>
      <ul className="perm-list">
        <li className="perm perm--ok">View wallet balances</li>
        <li className="perm perm--ok">View OSIRIS plan options</li>
        <li className="perm perm--ok">Propose a plan for you to approve</li>
        <li className="perm perm--no">Move funds or sign anything</li>
      </ul>

      {error && <p className="createcode-error">{error}</p>}

      <button type="button" className="btn-gold" onClick={generateCode} disabled={isPending || !address}>
        {isPending ? 'Confirm in MiniPay…' : 'Generate one-time code'}
      </button>

      {grantCode && (
        <div className="code-card">
          <div className="code-card__label">Your code</div>
          <div className="code-card__code">{grantCode}</div>
          <button type="button" className="code-card__copy" onClick={copyCode}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <div className="code-card__foot">
            Expires in {DURATIONS[durationIndex].label} · paste into {assistantLabel}
          </div>
        </div>
      )}
    </div>
  );
}
