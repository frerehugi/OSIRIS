import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection, useSignTypedData } from 'wagmi';
import { APIS_BACKEND_URL } from '../config';

/// Address Book — Gegenstück zu propose_address_book_entry/get_address_book
/// (apis/backend/src/server.ts) und zu Sterntalers src/addressBook.ts, aber
/// server-seitig (Cloudflare KV) statt localStorage, weil die KI über
/// get_address_book mitlesen können soll (siehe Chat: "APIS braucht ein
/// Adressbuch was vom Chat aus gelesen und bearbeitet werden kann").
///
/// Der entscheidende Sicherheits-Constraint bleibt trotzdem erhalten (siehe
/// Sterntalers addressBook.ts-Kommentar zum Angriffsszenario eines von außen
/// beschreibbaren Verzeichnisses): der Chat kann über propose_address_book_
/// entry nur einen "contact code" ausgeben, der HIER erst nach Ansicht der
/// vollen Adresse bestätigt wird — und selbst dieser Bestätigungsklick
/// schreibt nicht direkt, sondern lässt den Nutzer eine SaveContact-Nachricht
/// in MiniPay signieren (siehe contactSignature.ts auf Backend-Seite), die
/// der Server vor dem eigentlichen Schreiben verifiziert. Dasselbe für das
/// Entfernen eines Kontakts (RemoveContact).

interface Contact {
  name:    string;
  address: `0x${string}`;
  savedAt: number;
}

const SAVE_CONTACT_TYPES = {
  SaveContact: [
    { name: 'owner',   type: 'address' },
    { name: 'name',    type: 'string'  },
    { name: 'address', type: 'address' },
    { name: 'nonce',   type: 'uint256' },
  ],
} as const;

const REMOVE_CONTACT_TYPES = {
  RemoveContact: [
    { name: 'owner',   type: 'address' },
    { name: 'address', type: 'address' },
    { name: 'nonce',   type: 'uint256' },
  ],
} as const;

// Bewusst 'Apis' (nicht 'APIS') — muss exakt mit dem Backend
// (contactSignature.ts / grant.ts) übereinstimmen, sonst schlägt jede
// Signaturprüfung fehl.
const CONTACT_DOMAIN = { name: 'Apis', version: '1', chainId: 42220 } as const;

function randomNonce(): bigint {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}

function decodeContactCode(code: string): { name: string; address: string } {
  const normalized = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  const parsed = JSON.parse(atob(normalized));
  if (!parsed?.valid || typeof parsed.name !== 'string' || typeof parsed.address !== 'string') {
    // Missing `valid` but the name/address fields are otherwise present —
    // most likely an AI assistant reconstructed the code by hand instead of
    // relaying the backend's `contactCode` field verbatim (see
    // ConfirmPlan.tsx's looksLikeFlattenedPayload() for the same class of
    // issue with plan codes).
    if (typeof parsed?.name === 'string' && typeof parsed?.address === 'string') {
      throw new Error(
        "This code is missing its outer wrapper — it looks like only part of the contact was copied. " +
        "Ask your AI assistant to give you its `contactCode` field's value again, copied exactly as returned."
      );
    }
    throw new Error('This code does not look like a contact code.');
  }
  return { name: parsed.name, address: parsed.address };
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function AddressBook() {
  const navigate = useNavigate();
  const { address } = useConnection();
  const { signTypedDataAsync } = useSignTypedData();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removingAddress, setRemovingAddress] = useState<string | null>(null);

  const [codeInput, setCodeInput] = useState('');
  const [pending, setPending] = useState<{ name: string; address: string } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    if (!address) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`${APIS_BACKEND_URL}/address-book/for-owner?owner=${address}`);
      if (!res.ok) throw new Error('Request failed');
      const data = await res.json() as { contacts: Contact[] };
      setContacts(data.contacts ?? []);
    } catch {
      setLoadError('Could not load your address book right now. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const loadCode = () => {
    setCodeError(null);
    setPending(null);
    try {
      setPending(decodeContactCode(codeInput));
    } catch (err) {
      setCodeError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not read this code. Copy it exactly as it was given to you in the chat.'
      );
    }
  };

  const cancelPending = () => {
    setPending(null);
    setCodeInput('');
  };

  const saveContact = async () => {
    if (!address || !pending) return;
    setSaving(true);
    setCodeError(null);
    try {
      const nonce = randomNonce();
      const signature = await signTypedDataAsync({
        domain: CONTACT_DOMAIN,
        types: SAVE_CONTACT_TYPES,
        primaryType: 'SaveContact',
        message: { owner: address, name: pending.name, address: pending.address as `0x${string}`, nonce },
      });

      const res = await fetch(`${APIS_BACKEND_URL}/address-book/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: address, name: pending.name, address: pending.address, nonce: nonce.toString(), signature }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? 'Could not save this contact.');
      }
      const data = await res.json() as { contacts: Contact[] };
      setContacts(data.contacts ?? []);
      setPending(null);
      setCodeInput('');
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : 'Signing was cancelled. Tap "Load Contact" to try again.');
    } finally {
      setSaving(false);
    }
  };

  const removeContact = async (contactAddress: `0x${string}`) => {
    if (!address) return;
    setRemovingAddress(contactAddress);
    try {
      const nonce = randomNonce();
      const signature = await signTypedDataAsync({
        domain: CONTACT_DOMAIN,
        types: REMOVE_CONTACT_TYPES,
        primaryType: 'RemoveContact',
        message: { owner: address, address: contactAddress, nonce },
      });
      const res = await fetch(`${APIS_BACKEND_URL}/address-book/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: address, address: contactAddress, nonce: nonce.toString(), signature }),
      });
      if (res.ok) {
        const data = await res.json() as { contacts: Contact[] };
        setContacts(data.contacts ?? []);
      }
    } catch {
      // Häufigster Fall: Nutzer hat in MiniPay abgelehnt — kein Fehlertext nötig,
      // die Zeile bleibt einfach stehen.
    } finally {
      setRemovingAddress(null);
    }
  };

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">Address Book</span>
        <span className="app-bar__spacer" />
      </div>
      <p className="createcode-sub">
        Contacts your AI assistant can reference by name when proposing a send. Nothing is saved without your confirmation here.
      </p>

      <div className="section-label">Saved contacts ({contacts.length})</div>
      {loading && <p className="empty-note">Loading…</p>}
      {loadError && <p className="createcode-error">{loadError}</p>}
      {!loading && !loadError && contacts.length === 0 && <p className="empty-note">No saved contacts yet.</p>}
      {!loading && contacts.length > 0 && (
        <div className="contact-list">
          {contacts.map((c) => (
            <div className="contact-row" key={c.address}>
              <span className="contact-avatar">{c.name.charAt(0).toUpperCase()}</span>
              <span className="contact-row__name">
                <span className="contact-row__title">{c.name}</span>
                <span className="contact-row__addr">{shortAddress(c.address)}</span>
              </span>
              <button
                type="button"
                className="contact-row__remove"
                onClick={() => removeContact(c.address)}
                disabled={removingAddress === c.address}
                aria-label={`Remove ${c.name}`}
              >
                {removingAddress === c.address ? '…' : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="divider" />
      <div className="section-label">Add from chat</div>
      <p className="createcode-sub" style={{ paddingTop: 0 }}>
        Ask your AI assistant to save a contact, then paste the code it gives you here.
      </p>

      {!pending && (
        <>
          <div className="sell-card">
            <textarea
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="Paste contact code here"
              rows={3}
              style={{
                width: '100%', minHeight: 60, background: 'transparent', border: 'none', color: 'var(--text)',
                fontSize: 13, fontFamily: "'SF Mono','JetBrains Mono',ui-monospace,monospace", resize: 'vertical', outline: 'none',
              }}
            />
          </div>
          {codeError && <p className="createcode-error">{codeError}</p>}
          <button type="button" className="btn-gold" onClick={loadCode} disabled={codeInput.trim() === ''}>
            Load Contact
          </button>
        </>
      )}

      {pending && (
        <>
          <div className="sell-card">
            <span className="confirm-name">{pending.name}</span>
            <span className="confirm-addr">{pending.address}</span>
          </div>
          <p className="fee-note">This is the full address that will be saved. Check it carefully before confirming.</p>
          {codeError && <p className="createcode-error">{codeError}</p>}
          <div className="btn-row">
            <button type="button" className="btn-ghost" onClick={cancelPending} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn-gold" onClick={saveContact} disabled={saving || !address}>
              {saving ? 'Confirm in MiniPay…' : 'Save Contact'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
