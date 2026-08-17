import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server on 5173 — this is the origin the operator must allow via
// EDGE_CORS_ORIGINS (or `*`) on the Edge.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
