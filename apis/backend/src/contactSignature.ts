// Signatur-Verifikation für Adressbuch-Schreiboperationen — Gegenstück zu
// apis/app/src/screens/ConfirmContact.tsx (Save) und AddressBook.tsx
// (Remove). Gleiches Prinzip wie grant.ts: eine vom Wallet-Owner selbst per
// signTypedData signierte, selbstständig prüfbare Nachricht statt eines
// Datenbank-Lookups oder gar keiner Prüfung.
//
// Ohne diese Signaturprüfung wäre saveEntry()/removeEntry() in
// addressBook.ts ein offener Schreibzugriff: irgendjemand könnte per
// direktem POST an /address-book/save eine beliebige owner-Adresse
// vortäuschen und ihr einen Kontakt unterschieben — genau der Angriff, den
// Sterntalers addressBook.ts-Kommentar für ein GETEILTES Verzeichnis
// beschreibt, hier aber auf die Schreib-API selbst übertragen. Die Signatur
// beweist, dass wirklich der Owner selbst (in MiniPay) diese exakte
// Save/Remove-Aktion bestätigt hat.

import { recoverTypedDataAddress } from 'viem';

// Dieselbe Domain wie grant.ts (bewusst 'Apis', nicht 'APIS') — beide Typen
// leben unter derselben EIP-712-Domain, unterscheiden sich aber im
// primaryType, sodass eine Grant-Signatur nie versehentlich als
// Contact-Signatur akzeptiert würde (und umgekehrt).
const CONTACT_DOMAIN = { name: 'Apis', version: '1', chainId: 42220 } as const;

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

export class ContactSignatureError extends Error {}

export interface SaveContactPayload {
  owner:     `0x${string}`;
  name:      string;
  address:   `0x${string}`;
  nonce:     bigint;
  signature: `0x${string}`;
}

export interface RemoveContactPayload {
  owner:     `0x${string}`;
  address:   `0x${string}`;
  nonce:     bigint;
  signature: `0x${string}`;
}

export async function verifySaveContact(payload: SaveContactPayload): Promise<void> {
  const recovered = await recoverTypedDataAddress({
    domain: CONTACT_DOMAIN,
    types: SAVE_CONTACT_TYPES,
    primaryType: 'SaveContact',
    message: { owner: payload.owner, name: payload.name, address: payload.address, nonce: payload.nonce },
    signature: payload.signature,
  });
  if (recovered.toLowerCase() !== payload.owner.toLowerCase()) {
    throw new ContactSignatureError('Signature does not match the claimed owner.');
  }
}

export async function verifyRemoveContact(payload: RemoveContactPayload): Promise<void> {
  const recovered = await recoverTypedDataAddress({
    domain: CONTACT_DOMAIN,
    types: REMOVE_CONTACT_TYPES,
    primaryType: 'RemoveContact',
    message: { owner: payload.owner, address: payload.address, nonce: payload.nonce },
    signature: payload.signature,
  });
  if (recovered.toLowerCase() !== payload.owner.toLowerCase()) {
    throw new ContactSignatureError('Signature does not match the claimed owner.');
  }
}
