import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// MiniPay-Referenz Abschnitt "Local testing": ngrok-Hosts müssen für den
// Dev-Server erlaubt sein, sonst weist Vite lokale Testaufrufe aus MiniPays
// "Load test page" mit "Blocked request" ab.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174, // eigener Port, kollidiert nicht mit OSIRIS' Dev-Server (5173)
    allowedHosts: ['.ngrok.app', '.ngrok-free.dev', '.ngrok-free.app'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // MiniPay-Referenz Abschnitt 14: empfohlen, kein Error-Reporting-Tool im Einsatz
  },
});
