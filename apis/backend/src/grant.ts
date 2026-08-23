// Access-Grant-Verifikation — Gegenstück zu apis/app/src/screens/CreateCode.tsx.
//
// Der Grant ist ein selbstständig prüfbares Objekt (EIP-712-Nachricht +
// Signatur), kein Datenbank-Lookup: dieser Worker muss dafür nichts
// gespeichert haben, er verifiziert nur, dass die Signatur zur behaupteten
// Owner-Adresse passt (siehe Gesamtplan §12 Punkt 6). Domain/Types müssen
// exakt mit CreateCode.tsx übereinstimmen, sonst schlägt jede Verifikation fehl.

import { recoverTypedDataAddress } from 'viem';

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
    throw new GrantError('Malformed grant code.');
  }

  const { owner, agent, scope, expiresAt, nonce, signature } = json;
  if (
    typeof owner !== 'string' || typeof agent !== 'string' || typeof scope !== 'string' ||
    typeof expiresAt !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string'
  ) {
    throw new GrantError('Malformed grant code.');
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
    throw new GrantError('Grant signature does not match its claimed owner.');
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (grant.expiresAt < nowSeconds) {
    throw new GrantError('Grant has expired. Ask the user to create a new one in Apis.');
  }

  if (!grant.scope.includes(requiredScope)) {
    throw new GrantError(`Grant does not include '${requiredScope}' access.`);
  }

  return grant;
}
