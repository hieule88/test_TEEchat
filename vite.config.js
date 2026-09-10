import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server on 5173 — this is the origin the operator must allow via
// EDGE_CORS_ORIGINS (or `*`) on the Edge.
//
// COOP/COEP make the page cross-origin isolated: @miden-sdk/miden-sdk is a
// multi-threaded WASM build whose shared memory needs SharedArrayBuffer,
// which browsers only enable on isolated pages. Without these headers the
// SDK import fails and payTopup falls back to plain requestSend (payment
// still works, the memo just isn't attached to the note). Side effect of
// COEP: every cross-origin subresource needs CORS/CORP — our only
// cross-origin traffic is fetch() to the Edge/auth APIs, which is CORS-mode
// already. The SDK is also excluded from Vite's dep pre-bundling: esbuild's
// CJS-ification breaks its `new URL(..., import.meta.url)` WASM asset loads.
const coopCoep = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, headers: coopCoep },
  preview: { headers: coopCoep },
  optimizeDeps: { exclude: ['@miden-sdk/miden-sdk'] },
  // The SDK spawns its compute worker via `new Worker(new URL(...))`;
  // Vite's default IIFE worker bundling forbids code-splitting, which
  // the SDK's chunks need — ES-format workers lift that limit.
  worker: { format: 'es' },
  // The SDK's WASM chunk uses top-level await → needs es2022 (still
  // older than any browser that has SharedArrayBuffer + the wallet).
  build: { target: 'es2022' },
});
