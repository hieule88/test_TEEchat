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
    onchain-attach.js   ← Custom-tx builder: memo-as-NoteAttachment (see below)
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
   `aci.openSession({ maxSpend })`, then `aci.chat(...)`, plus balance
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

## On-chain top-up (pay with the wallet itself)

The Top up panel has two rails. **⛓ Wallet (on-chain)** pays straight
from the connected Leviathan wallet: the app asks the Edge for a quote,
then `payTopup()` submits one wallet Custom transaction — a public P2ID
note paying the EXACT quoted amount and carrying the **order memo as a
`NoteAttachment`** — waits for the on-chain commit, and `waitForTopup()`
polls until the operator's note-watcher credits the ledger. **💳 Card
(Stripe)** keeps the old hosted-checkout tab.

### The memo lives ON the note (required)

`src/onchain-attach.js` builds the payment: it creates the P2ID note
itself with `@miden-sdk/miden-sdk`, embeds the intent memo as a
`NoteAttachment` (scheme `0x4C565431` "LVT1" — codec kept in lockstep
with `note-watcher/src/core.mjs`), serializes the `TransactionRequest`,
and submits it through `wallet.requestTransaction({type: 'Custom'})` —
the wallet only signs and proves. The memo is the ONLY thing that
matches the payment to the order (amounts are plain prices and collide
across same-price orders), so there is **no plain-send fallback**: if
the SDK can't load, `payTopup` throws before any money moves.
Requirements:

- **Registry**: the SDK comes from the private Gitea npm registry
  (`.npmrc`), version-pinned to the exact build the wallet extension
  bundles (`0.15.0-node.5e72c326`). Export `GITEA_NPM_TOKEN` (may be
  empty if the registry allows anonymous read) before `npm install`.
- **Cross-origin isolation**: the SDK's multi-threaded WASM needs
  SharedArrayBuffer, so the page must send
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Wired for `npm run
  dev`/`preview` (vite.config.js) and `npm start` (public/serve.json);
  any other host must send the same two headers — without them the
  on-chain rail is unavailable (Stripe still works).

Config: `VITE_AUTH_ORIGIN` (see `.env.example`) — the auth-service base
URL the app talks to directly for two public endpoints: polling an
order's status after payment, and reopening an unpaid order
(`retryCheckout`). The Caddy in front of auth-service must therefore
send CORS on BOTH:

- `GET /v1/payment-intents/*` — a simple request, a plain
  `Access-Control-Allow-Origin` is enough;
- `POST /v1/payment-intents/*/checkout` — carries a JSON body, so the
  browser sends a **preflight `OPTIONS` first**. Caddy has to answer that
  itself (204 + `Allow-Methods`/`Allow-Headers`): auth-service mounts no
  CORS middleware, so the OPTIONS would hit a POST-only route and come
  back 405, and the browser would block the call.

The gateway repo's `Caddyfile` and `Caddyfile.test` carry both carve-outs.
Without the second one the app works on the first click and then fails
with "Failed to fetch" on every reuse.

`src/leviathan-aci.js` is a copy of
`leviathan-ai-gateway-verify/wallet-aci/dapp/leviathan-aci.js` with one
change: the vendored crypto import is swapped for the npm
`@noble/curves/ed25519` (bundler build). When the SDK changes upstream,
re-copy it and re-apply that one-line swap.
