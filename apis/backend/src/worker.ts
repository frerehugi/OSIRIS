import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from './server';

// Stateless: neuer Server + Transport pro Request. Kein Session-State, keine
// In-Memory-Zustände zwischen Aufrufen nötig — jedes Tool ist für sich
// vollständig (Grant-Code wird pro Aufruf mitgegeben und geprüft), passend
// zum Cloudflare-Workers-Ausführungsmodell (jeder Request potenziell auf
// einer anderen Instanz).
export default {
  async fetch(request: Request): Promise<Response> {
    const server = buildServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
