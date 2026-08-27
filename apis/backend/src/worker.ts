import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from './server';
import { handleRest } from './rest';
import type { AddressBookKV } from './addressBook';

// ADDRESS_BOOK: einziger Cloudflare-KV-Namespace dieses Workers — gebunden in
// wrangler.toml. Kein Fund-relevanter State (siehe addressBook.ts), aber der
// erste Server-State überhaupt in diesem bisher komplett zustandslosen
// Worker (siehe wrangler.toml-Kommentar dort).
export interface Env {
  ADDRESS_BOOK: AddressBookKV;
}

// Stateless (bis auf ADDRESS_BOOK): neuer Server + Transport pro Request.
// Kein In-Memory-Zustand zwischen Aufrufen nötig — jedes Tool ist für sich
// vollständig (Grant-Code wird pro Aufruf mitgegeben und geprüft), passend
// zum Cloudflare-Workers-Ausführungsmodell (jeder Request potenziell auf
// einer anderen Instanz).
//
// REST-Anfragen (ChatGPT/Gemini/Grok, siehe rest.ts) werden zuerst geprüft —
// handleRest() gibt null zurück, wenn der Pfad keine bekannte REST-Route
// ist, und die Anfrage läuft unverändert in den MCP-Transport (Claude),
// exakt wie vor der REST-Schicht.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const restResponse = await handleRest(request, env);
    if (restResponse) return restResponse;

    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
