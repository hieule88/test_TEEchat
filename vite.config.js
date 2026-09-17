import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Plain Vite + React. Nothing special is needed for the on-chain rail:
// the SERVER builds the wallet transaction (onchain.custom_tx) and the
// page only hands it to the wallet extension — no Miden SDK, no WASM, no
// cross-origin-isolation headers, no private registry.
//
// Dev server on 5173 — this is the origin the operator must allow via
// EDGE_CORS_ORIGINS on the Edge.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
