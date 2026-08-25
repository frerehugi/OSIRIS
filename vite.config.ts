import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base:    './', // relative Asset-Pfade — läuft egal unter welchem Unterpfad (z.B. GitHub Pages /OSIRIS/app/)
  plugins: [react()],
  server: { port: 5173 },
  // sourcemap:false für den Produktions-Build (MiniPay-Listing-Vorgabe) — kein
  // Error-Reporting-Tool (Sentry o.ä.) im Einsatz, das Sourcemaps bräuchte.
  build:  { outDir: 'dist', sourcemap: false },
});
