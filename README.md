# Leviathan Wallet Chat — Vite + React

A wallet-bound chat app built **as a frontend dev would**, following the
handover's `README-FRONTEND.md`: a Vite/React app that uses the
`leviathan-aci.js` SDK. No API key — every request is signed by the user's
Leviathan wallet.

```
test_frontend/
  index.html            ← Vite entry
  vite.config.js
  package.json
  .env                  ← VITE_EDGE_ORIGIN (the Edge base URL)
  src/
    main.jsx
    App.jsx             ← the chat UI (React)
    aci.js              ← the single LeviathanACI instance (README §2)
    leviathan-aci.js    ← SDK, import swapped to '@noble/curves/ed25519' (README §1)
```

## Run

```bash
cd test_frontend
npm install
npm run dev            # http://localhost:5173
```

## What was done (the README-FRONTEND.md steps)

1. **Get the SDK** — `npm i @noble/curves`, copied `leviathan-aci.js` into
   `src/`, and changed its top import to
   `import { ed25519, x25519 } from '@noble/curves/ed25519';`.
2. **One SDK instance** — `src/aci.js`:
   ```js
   import { LeviathanACI, AciError } from './leviathan-aci';
   export const aci = new LeviathanACI({
     serviceOrigin: import.meta.env.VITE_EDGE_ORIGIN, // = Edge WALLET_SERVICE_ORIGIN
   });
   ```
3. **Wallet login + chat** — `src/App.jsx` calls `aci.connect()`,
   `aci.openSession({ maxSpendMc })`, then `aci.chat(...)`, plus balance
   refresh, NOWPayments top-up, receipt verify, and logout.

## Prerequisites (from the operator)

1. **Edge URL with wallet enabled** as `VITE_EDGE_ORIGIN` — must equal the
   Edge's `WALLET_SERVICE_ORIGIN` exactly (default: the test Edge
   `https://leviathan-edge-test.duckdns.org:8443`).
2. **CORS**: the Edge must allow `http://localhost:5173` (operator sets
   `EDGE_CORS_ORIGINS=*` for test, or an explicit list).
3. **Leviathan wallet extension** installed, with a wallet created; its version
   must match the deployed `wallet-verifier` crypto.
4. **Credits**: a new wallet starts at 0 — use **Buy credits** (NOWPayments
   sandbox), then **Refresh**.

Note: React escapes interpolated text by default, so server-provided strings
(model ids, error messages) can't inject markup.
