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
import { compilePlan, type PlanDraft, type SellTriggerDraft } from './planCompiler';
import { getPlansForOwner } from './plans';
import { getBalancesForOwner } from './balances';
import { publicClient } from './client';
import { OPENAPI_SPEC } from './openapi';

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

const REST_PATHS = new Set(['/openapi.json', '/capabilities', '/balances', '/plans', '/propose']);

// Gibt null zurück, wenn der Pfad keine REST-Route ist — worker.ts reicht
// die Anfrage dann unverändert an den MCP-Transport weiter.
export async function handleRest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
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

  return json({ error: 'Not found.' }, 404);
}
