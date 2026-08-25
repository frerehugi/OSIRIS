import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from './server';
import { handleRest } from './rest';

// Stateless: neuer Server + Transport pro Request. Kein Session-State, keine
// In-Memory-Zustände zwischen Aufrufen nötig — jedes Tool ist für sich
// vollständig (Grant-Code wird pro Aufruf mitgegeben und geprüft), passend
// zum Cloudflare-Workers-Ausführungsmodell (jeder Request potenziell auf
// einer anderen Instanz).
//
// REST-Anfragen (ChatGPT/Gemini/Grok, siehe rest.ts) werden zuerst geprüft —
// handleRest() gibt null zurück, wenn der Pfad keine bekannte REST-Route
// ist, und die Anfrage läuft unverändert in den MCP-Transport (Claude),
// exakt wie vor der REST-Schicht.
export default {
  async fetch(request: Request): Promise<Response> {
    const restResponse = await handleRest(request);
    if (restResponse) return restResponse;

    const server = buildServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
