// REST/OpenAPI-Schicht für Plattformen ohne MCP-Unterstützung (ChatGPT
// Custom-GPT-Actions, Gemini Gems/Extensions, Grok Function-Calling) —
// additiv neben dem bestehenden MCP-Server (server.ts/worker.ts), reine
// HTTP+JSON-Wrapper um dieselben Kernfunktionen (buildCapabilities/
// getBalancesForOwner/getPlansForOwner/compilePlan), die auch die MCP-Tools
// nutzen. Claude bleibt komplett beim MCP-Pfad, unverändert — worker.ts
// versucht diesen Router nur für die hier bekannten Pfade, alles andere
// fällt unverändert an server.ts/den MCP-Transport durch.

import { verifyGrant, GrantError } from './grant';
import { buildCapabilities } from './capabilities';
import {
  compilePlan, compileSendPlan, compileDirectSend, encodePlanCode, ADDRESS_RE,
  type PlanDraft, type SellTriggerDraft, type SendPlanDraft, type DirectSendDraft,
} from './planCompiler';
import { getPlansForOwner } from './plans';
import { getBalancesForOwner } from './balances';
import { getSquidTokenPrices } from './squidPrices';
import { getAddressBook, saveEntry, removeEntry } from './addressBook';
import { verifySaveContact, verifyRemoveContact, ContactSignatureError } from './contactSignature';
import { publicClient } from './client';
import { OPENAPI_SPEC } from './openapi';
import type { Env } from './worker';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function grantErrorMessage(err: unknown): string {
  return err instanceof GrantError ? err.message : 'Could not verify the access grant.';
}

function contactSignatureErrorMessage(err: unknown): string {
  return err instanceof ContactSignatureError ? err.message : 'Could not verify the signature.';
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function validateProposeShape(draft: Record<string, unknown>, sellTrigger: unknown): string | null {
  if (typeof draft.inputToken !== 'string')  return "'inputToken' (string) is required.";
  if (typeof draft.totalAmount !== 'string') return "'totalAmount' (string) is required.";
  if (typeof draft.interval !== 'string')    return "'interval' (string) is required.";
  if (typeof draft.duration !== 'number')    return "'duration' (number) is required.";
  if (!Array.isArray(draft.targets))         return "'targets' (array) is required.";
  if (sellTrigger !== undefined && (typeof sellTrigger !== 'object' || sellTrigger === null)) {
    return "'sellTrigger', if present, must be an object.";
  }
  return null;
}

const REST_PATHS = new Set([
  '/openapi.json', '/capabilities', '/token-prices', '/balances', '/plans', '/propose',
  '/propose-send', '/direct-send',
  '/address-book', '/address-book/propose', '/address-book/save', '/address-book/remove',
  '/address-book/for-owner',
]);

// Gibt null zurück, wenn der Pfad keine REST-Route ist — worker.ts reicht
// die Anfrage dann unverändert an den MCP-Transport weiter.
export async function handleRest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // "/" ist der eigentliche MCP-Endpoint (siehe APIS_BACKEND_URL) -- ein
  // echter MCP-Client spricht ihn per POST an, oder per GET MIT
  // "text/event-stream" im Accept-Header (Server-initiierter Stream, Teil
  // des Streamable-HTTP-Handshakes). So einen Request NIEMALS abfangen,
  // sonst bricht das echte Protokoll. Nur ein reiner GET ohne diesen Header
  // (Browser/curl/Crawler-Default, würde am MCP-Transport spec-konform mit
  // 406 scheitern -- führte zu einem "unreachable" in einem externen
  // AskBots-Review) bekommt hier eine kurze, hilfreiche Antwort statt eines
  // nackten 406 ohne jeden Hinweis.
  if (url.pathname === '/' && request.method === 'GET' && !(request.headers.get('accept') ?? '').includes('text/event-stream')) {
    return json({
      name: 'apis-backend',
      description: 'OSIRIS/APIS MCP server + REST API for AI assistants. Not a browsable web page.',
      mcp: 'This same URL also speaks MCP (Streamable HTTP) for MCP-capable clients (e.g. Claude).',
      rest: { openapi: '/openapi.json', capabilities: '/capabilities' },
    });
  }

  if (!REST_PATHS.has(url.pathname)) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (url.pathname === '/openapi.json') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    return json(OPENAPI_SPEC);
  }

  if (url.pathname === '/capabilities') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    return json(buildCapabilities());
  }

  if (url.pathname === '/token-prices') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    return json(await getSquidTokenPrices());
  }

  if (url.pathname === '/balances') {
    if (request.method !== 'POST') return json({ error: 'Use POST with a JSON body.' }, 405);
    const body = await readJsonBody(request);
    if (!body || typeof body.grantCode !== 'string') return json({ error: "'grantCode' (string) is required." }, 400);

    let grant;
    try {
      grant = await verifyGrant(body.grantCode, 'read');
    } catch (err) {
      return json({ error: grantErrorMessage(err) }, 400);
    }

    const result = await getBalancesForOwner(publicClient, grant.owner);
    return json(result);
  }

  if (url.pathname === '/plans') {
    if (request.method !== 'POST') return json({ error: 'Use POST with a JSON body.' }, 405);
    const body = await readJsonBody(request);
    if (!body || typeof body.grantCode !== 'string') return json({ error: "'grantCode' (string) is required." }, 400);

    let grant;
    try {
      grant = await verifyGrant(body.grantCode, 'read');
    } catch (err) {
      return json({ error: grantErrorMessage(err) }, 400);
    }

    try {
      const result = await getPlansForOwner(publicClient, grant.owner);
      return json(result);
    } catch {
      return json({ error: 'Could not read plans right now. Please try again.' }, 502);
    }
  }

  if (url.pathname === '/propose') {
    if (request.method !== 'POST') return json({ error: 'Use POST with a JSON body.' }, 405);
    const body = await readJsonBody(request);
    if (!body || typeof body.grantCode !== 'string') return json({ error: "'grantCode' (string) is required." }, 400);

    let grant;
    try {
      grant = await verifyGrant(body.grantCode, 'propose');
    } catch (err) {
      return json({ error: grantErrorMessage(err) }, 400);
    }

    const { grantCode: _grantCode, sellTrigger, ...draftFields } = body;
    const shapeError = validateProposeShape(draftFields, sellTrigger);
    if (shapeError) return json({ error: shapeError }, 400);

    const planDraft: PlanDraft = { owner: grant.owner, ...draftFields } as unknown as PlanDraft;
    const result = compilePlan(planDraft, sellTrigger as SellTriggerDraft | undefined);
    if (!result.valid) return json({ valid: false, errors: result.errors }, 400);
    return json(result);
  }

  if (url.pathname === '/propose-send') {
    if (request.method !== 'POST') return json({ error: 'Use POST with a JSON body.' }, 405);
    const body = await readJsonBody(request);
    if (!body || typeof body.grantCode !== 'string') return json({ error: "'grantCode' (string) is required." }, 400);

    let grant;
    try {
      grant = await verifyGrant(body.grantCode, 'propose');
    } catch (err) {
      return json({ error: grantErrorMessage(err) }, 400);
    }

    const { grantCode: _grantCode, ...draftFields } = body;
    if (typeof draftFields.token !== 'string')     return json({ error: "'token' (string) is required." }, 400);
    if (!Array.isArray(draftFields.recipients))    return json({ error: "'recipients' (array) is required." }, 400);
    if (typeof draftFields.interval !== 'string')  return json({ error: "'interval' (string) is required." }, 400);
    if (typeof draftFields.duration !== 'number')  return json({ error: "'duration' (number) is required." }, 400);

    const planDraft: SendPlanDraft = { owner: grant.owner, ...draftFields } as unknown as SendPlanDraft;
    const result = compileSendPlan(planDraft);
    if (!result.valid) return json({ valid: false, errors: result.errors }, 400);
    return json(result);
  }

  if (url.pathname === '/direct-send') {
    if (request.method !== 'POST') return json({ error: 'Use POST with a JSON body.' }, 405);
    const body = await readJsonBody(request);
    if (!body || typeof body.grantCode !== 'string') return json({ error: "'grantCode' (string) is required." }, 400);

    try {
      await verifyGrant(body.grantCode, 'propose');
    } catch (err) {
      return json({ error: grantErrorMessage(err) }, 400);
    }

    if (typeof body.token !== 'string')  return json({ error: "'token' (string) is required." }, 400);
    if (typeof body.to !== 'string')     return json({ error: "'to' (string) is required." }, 400);
    if (typeof body.amount !== 'string') return json({ error: "'amount' (string) is required." }, 400);

    const result = compileDirectSend({ token: body.token, to: body.to, amount: body.amount } as DirectSendDraft);
    if (!result.valid) return json({ valid: false, errors: result.errors }, 400);
    return json(result);
  }

  // Von der APIS-APP SELBST genutzt (AddressBook.tsx-Screen), nicht von der
  // KI — bewusst OHNE Grant/Signatur, anders als /address-book (Grant) und
  // /address-book/save|remove (Signatur). Ein Adressbuch-Eintrag ist Name +
  // Adresse, kein Fund-relevantes Geheimnis (dasselbe Bedrohungsmodell wie
  // ein Blockexplorer, der ohnehin jede Wallet-Aktivität öffentlich zeigt) —
  // die eigentliche Schutzmaßnahme bleibt, dass NUR signierte Save/Remove-
  // Aufrufe etwas verändern können. `owner` kommt hier aus dem verbundenen
  // Wallet der aufrufenden App-Instanz, nicht aus einer vom Aufrufer frei
  // wählbaren Grant-Adresse.
  if (url.pathname === '/address-book/for-owner') {
    if (request.method !== 'GET') return json({ error: 'Use GET with an ?owner= query param.' }, 405);
    const owner = url.searchParams.get('owner');
    if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
      return json({ error: "A valid '?owner=0x...' query param is required." }, 400);
    }
    const entries = await getAddressBook(env.ADDRESS_BOOK, owner as `0x${string}`);
    return json({ owner, contacts: entries });
  }

  if (url.pathname === '/address-book') {
    if (request.method !== 'POST') return json({ error: 'Use POST with a JSON body.' }, 405);
    const body = await readJsonBody(request);
    if (!body || typeof body.grantCode !== 'string') return json({ error: "'grantCode' (string) is required." }, 400);

    let grant;
    try {
      grant = await verifyGrant(body.grantCode, 'read');
    } catch (err) {
      return json({ error: grantErrorMessage(err) }, 400);
    }

    const entries = await getAddressBook(env.ADDRESS_BOOK, grant.owner);
    return json({ owner: grant.owner, contacts: entries });
  }

  if (url.pathname === '/address-book/propose') {
    if (request.method !== 'POST') return json({ error: 'Use POST with a JSON body.' }, 405);
    const body = await readJsonBody(request);
    if (!body || typeof body.grantCode !== 'string') return json({ error: "'grantCode' (string) is required." }, 400);

    try {
      await verifyGrant(body.grantCode, 'propose');
    } catch (err) {
      return json({ error: grantErrorMessage(err) }, 400);
    }

    if (typeof body.name !== 'string' || typeof body.address !== 'string') {
      return json({ error: "'name' (string) and 'address' (string) are required." }, 400);
    }
    if (!ADDRESS_RE.test(body.address)) {
      return json({ valid: false, errors: [`'${body.address}' is not a valid wallet address (0x + 40 hex chars).`] }, 400);
    }
    const compiled = { valid: true as const, name: body.name, address: body.address };
    return json({ ...compiled, contactCode: encodePlanCode(compiled) });
  }

  // ── Adressbuch schreiben — NICHT von der KI aufrufbar (kein Grant-Feld,
  // kein MCP-Tool dafür): braucht eine vom Wallet-Owner selbst signierte
  // Nachricht (siehe contactSignature.ts), ausschließlich von der APIS-App
  // nach expliziter Nutzerbestätigung aufgerufen.
  if (url.pathname === '/address-book/save') {
    if (request.method !== 'POST') return json({ error: 'Use POST with a JSON body.' }, 405);
    const body = await readJsonBody(request);
    if (!body) return json({ error: 'JSON body required.' }, 400);
    const { owner, name, address, nonce, signature } = body as Record<string, unknown>;
    if (
      typeof owner !== 'string' || typeof name !== 'string' || typeof address !== 'string' ||
      typeof nonce !== 'string' || typeof signature !== 'string'
    ) {
      return json({ error: "'owner', 'name', 'address' (strings), 'nonce' (string) and 'signature' (string) are required." }, 400);
    }
    if (!ADDRESS_RE.test(address)) {
      return json({ error: `'${address}' is not a valid wallet address.` }, 400);
    }

    try {
      await verifySaveContact({
        owner: owner as `0x${string}`, name, address: address as `0x${string}`,
        nonce: BigInt(nonce), signature: signature as `0x${string}`,
      });
    } catch (err) {
      return json({ error: contactSignatureErrorMessage(err) }, 400);
    }

    const entries = await saveEntry(env.ADDRESS_BOOK, owner as `0x${string}`, {
      name, address: address as `0x${string}`, savedAt: Math.floor(Date.now() / 1000),
    });
    return json({ owner, contacts: entries });
  }

  if (url.pathname === '/address-book/remove') {
    if (request.method !== 'POST') return json({ error: 'Use POST with a JSON body.' }, 405);
    const body = await readJsonBody(request);
    if (!body) return json({ error: 'JSON body required.' }, 400);
    const { owner, address, nonce, signature } = body as Record<string, unknown>;
    if (
      typeof owner !== 'string' || typeof address !== 'string' ||
      typeof nonce !== 'string' || typeof signature !== 'string'
    ) {
      return json({ error: "'owner', 'address' (strings), 'nonce' (string) and 'signature' (string) are required." }, 400);
    }

    try {
      await verifyRemoveContact({
        owner: owner as `0x${string}`, address: address as `0x${string}`,
        nonce: BigInt(nonce), signature: signature as `0x${string}`,
      });
    } catch (err) {
      return json({ error: contactSignatureErrorMessage(err) }, 400);
    }

    const entries = await removeEntry(env.ADDRESS_BOOK, owner as `0x${string}`, address as `0x${string}`);
    return json({ owner, contacts: entries });
  }

  return json({ error: 'Not found.' }, 404);
}
