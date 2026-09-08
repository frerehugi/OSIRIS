// Access-Grant-Verifikation — Gegenstück zu apis/app/src/screens/CreateCode.tsx.
//
// Der Grant ist ein selbstständig prüfbares Objekt (EIP-712-Nachricht +
// Signatur), kein Datenbank-Lookup: dieser Worker muss dafür nichts
// gespeichert haben, er verifiziert nur, dass die Signatur zur behaupteten
// Owner-Adresse passt (siehe Gesamtplan §12 Punkt 6). Domain/Types müssen
// exakt mit CreateCode.tsx übereinstimmen, sonst schlägt jede Verifikation fehl.

import { recoverTypedDataAddress } from 'viem';

// Bewusst 'Apis' (nicht 'APIS') — EIP-712-Domain-String, muss exakt mit
// CreateCode.tsx übereinstimmen, sonst schlägt jede Signaturprüfung fehl.
// Eine Änderung würde alle bereits ausgestellten Grant-Codes ungültig
// machen — keine reine Schreibweisen-Frage mehr, sobald einmal signiert.
const ACCESS_GRANT_DOMAIN = { name: 'Apis', version: '1', chainId: 42220 } as const;

const ACCESS_GRANT_TYPES = {
  AccessGrant: [
    { name: 'owner',     type: 'address' },
    { name: 'agent',     type: 'string' },
    { name: 'scope',     type: 'string' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'nonce',     type: 'uint256' },
  ],
} as const;

export interface AccessGrant {
  owner:     `0x${string}`;
  agent:     string;
  scope:     string;
  expiresAt: bigint;
  nonce:     bigint;
  signature: `0x${string}`;
}

export class GrantError extends Error {}

function decodeGrantCode(code: string): AccessGrant {
  let base64 = code.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(atob(base64));
  } catch {
    throw new GrantError(
      "Malformed grant code — this string isn't a valid APIS access code at all (wrong format or corrupted " +
      "in transit). This is NOT a plan/proposal validation problem, and retrying with different plan values " +
      "will not help. Ask the user to copy the exact code from APIS' \"Create New Code for Agent\" screen again.",
    );
  }

  const { owner, agent, scope, expiresAt, nonce, signature } = json;
  if (
    typeof owner !== 'string' || typeof agent !== 'string' || typeof scope !== 'string' ||
    typeof expiresAt !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string'
  ) {
    throw new GrantError(
      "Malformed grant code — this string isn't a valid APIS access code at all (missing or wrong-typed " +
      "fields). This is NOT a plan/proposal validation problem, and retrying with different plan values " +
      "will not help. Ask the user to copy the exact code from APIS' \"Create New Code for Agent\" screen again.",
    );
  }

  return {
    owner: owner as `0x${string}`,
    agent,
    scope,
    expiresAt: BigInt(expiresAt),
    nonce: BigInt(nonce),
    signature: signature as `0x${string}`,
  };
}

/// Prüft Signatur, Ablaufzeit und die geforderte Scope-Teilzeichenkette
/// (Scopes sind aktuell fest "read+propose" — includes() statt exakter
/// Gleichheit, falls das Format später um weitere Scopes wächst).
export async function verifyGrant(code: string, requiredScope: 'read' | 'propose'): Promise<AccessGrant> {
  const grant = decodeGrantCode(code);

  const recovered = await recoverTypedDataAddress({
    domain: ACCESS_GRANT_DOMAIN,
    types: ACCESS_GRANT_TYPES,
    primaryType: 'AccessGrant',
    message: {
      owner: grant.owner,
      agent: grant.agent,
      scope: grant.scope,
      expiresAt: grant.expiresAt,
      nonce: grant.nonce,
    },
    signature: grant.signature,
  });

  if (recovered.toLowerCase() !== grant.owner.toLowerCase()) {
    throw new GrantError(
      'Grant signature does not match its claimed owner — the code is corrupted or was tampered with. This ' +
      'is NOT a plan/proposal validation problem, and retrying with different plan values will not help. Ask ' +
      'the user to generate a fresh access code in APIS.',
    );
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (grant.expiresAt < nowSeconds) {
    throw new GrantError(
      'Grant has expired. This is NOT a bug in plan validation, and this call will keep failing identically ' +
      'no matter what plan values (amount, price, token, etc.) you send — the grant itself needs to be replaced ' +
      "before anything else can succeed. Ask the user to open APIS, generate a fresh access code (\"Create New " +
      'Code for Agent"), and retry with that new code.',
    );
  }

  if (!grant.scope.includes(requiredScope)) {
    throw new GrantError(
      `Grant does not include '${requiredScope}' access — the user's code was generated with a narrower scope. ` +
      'This is NOT a plan/proposal validation problem, and retrying with different plan values will not help. ' +
      `Ask the user to generate a new access code in APIS with '${requiredScope}' (or broader) access.`,
    );
  }

  return grant;
}
