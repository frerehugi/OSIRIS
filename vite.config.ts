import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base:    './', // relative Asset-Pfade — läuft egal unter welchem Unterpfad (z.B. GitHub Pages /OSIRIS/app/)
  plugins: [react()],
  server: { port: 5173 },
  build:  { outDir: 'dist', sourcemap: true },
});
