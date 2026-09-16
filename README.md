# Leviathan Wallet Chat — Vite + React

A wallet-bound chat app built **as a frontend dev would**, following the
handover's `README-FRONTEND.md`: a Vite/React app that uses the
`leviathan-aci.js` SDK. No API key — every request is signed by the user's
Leviathan wallet.

It doubles as the **reference implementation** for the on-chain top-up rail:
the handover package (`leviathan-ai-gateway-verify/wallet-aci/dapp/`) ships
`onchain-attach.js` and `topup-flow.example.jsx` lifted from here.

```
test_frontend/
  index.html            ← Vite entry
  vite.config.js        ← COOP/COEP + the three settings the WASM SDK needs
  package.json
  .npmrc                ← private Gitea registry for @miden-sdk/miden-sdk
  .env                  ← VITE_EDGE_ORIGIN + VITE_AUTH_ORIGIN
  public/
    serve.json          ← COOP/COEP for `npm start` (copied into dist/ by Vite)
  src/
    main.jsx
    App.jsx             ← the chat UI + two-rail top-up (React)
    aci.js              ← the single LeviathanACI instance (README §2)
    leviathan-aci.js    ← SDK, import swapped to '@noble/curves/ed25519' (README §1)
    onchain-attach.js   ← Custom-tx builder: memo-as-NoteAttachment (see below)
    styles.css
```

## Run

```bash
cd test_frontend
export GITEA_NPM_TOKEN=…     # required — see "Registry" below
npm install
npm run dev                  # http://localhost:5173
```

`npm run build` → `npm start` serves `dist/` on `$PORT` (how it runs on
Railway). Vite's build takes `VITE_*` from the **process environment** first,
so a Railway variable silently wins over the committed `.env` — check the
**Edge** panel in the running app to see which origins it actually got.

## What was done (the README-FRONTEND.md steps)

1. **Get the SDK** — `npm i @noble/curves`, copied `leviathan-aci.js` into
   `src/`, and changed its top import to
   `import { ed25519, x25519 } from '@noble/curves/ed25519';`. The on-chain
   rail adds `@miden-sdk/miden-sdk` (pinned, private registry).
2. **One SDK instance** — `src/aci.js`:
   ```js
   import { LeviathanACI, AciError } from './leviathan-aci';
   export const aci = new LeviathanACI({
     serviceOrigin: import.meta.env.VITE_EDGE_ORIGIN, // = Edge WALLET_SERVICE_ORIGIN
     authOrigin:    import.meta.env.VITE_AUTH_ORIGIN, // auth-service, for top-up status
   });
   ```
3. **Wallet login + chat** — `src/App.jsx` calls `aci.connect()`,
   `aci.openSession({ maxSpend })`, then `aci.chat(...)`, plus balance
   refresh, the two-rail top-up (on-chain / Stripe), receipt verify, and
   logout.

## Prerequisites (from the operator)

1. **Edge URL with wallet enabled** as `VITE_EDGE_ORIGIN` — must equal the
   Edge's `WALLET_SERVICE_ORIGIN` exactly (currently the production Edge,
   `https://leviathan-edge.duckdns.org`; the Edge announces its own value in
   `/v1/wallet/challenge` → `service`).
2. **CORS**: the Edge must allow the origin this app is served from —
   `http://localhost:5173` for `npm run dev`, plus the deployed origin
   (operator sets `EDGE_CORS_ORIGINS`).
3. **Leviathan wallet extension** installed, with a wallet created; its version
   must match the deployed `wallet-verifier` crypto.
4. **Credits**: a new wallet starts at 0 — use **Buy credits**, then
   **Refresh**. The on-chain rail is on the Miden **testnet**, so that wallet
   also needs test tokens of the operator's faucet.

Note: React escapes interpolated text by default, so server-provided strings
(model ids, error messages) can't inject markup.

## On-chain top-up (pay with the wallet itself)

The Top up panel has two rails. **⛓ Wallet (on-chain)** — the default — pays
straight from the connected Leviathan wallet: the app asks the Edge for a
quote, then `payTopup()` submits one wallet Custom transaction — a public
P2ID note paying the EXACT quoted amount and carrying the **order memo as a
`NoteAttachment`** — waits for the on-chain commit, and `waitForTopup()`
polls until the operator's note-watcher credits the ledger. The panel walks
① quote/sign → ② commit → ③ credit. **💳 Card (Stripe)** keeps the old
hosted-checkout tab.

### The memo lives ON the note (required)

`src/onchain-attach.js` builds the payment: it creates the P2ID note
itself with `@miden-sdk/miden-sdk`, embeds the intent memo as a
`NoteAttachment` (scheme `0x4C565431` "LVT1" — codec kept in lockstep
with `note-watcher/src/core.mjs`), serializes the `TransactionRequest`,
and submits it through `wallet.requestTransaction({type: 'Custom'})` —
the wallet only signs and proves. The memo is the ONLY thing that
matches the payment to the order (amounts are plain prices and collide
across same-price orders), so there is **no plain-send fallback**: if
the SDK can't load, `payTopup` throws `attachment_unavailable` before any
money moves. Requirements:

- **Registry**: the SDK comes from the private Gitea npm registry
  (`.npmrc`), version-pinned to the exact build the wallet extension
  bundles (`0.15.0-node.5e72c326`) — a different build produces notes the
  wallet refuses to sign. The registry **refuses anonymous reads** (`401`),
  so `GITEA_NPM_TOKEN` must hold a Gitea PAT with the `read:package` scope,
  exported before `npm install` and set as a build variable wherever this
  is built. It is a build-time credential only; it never reaches the bundle.
- **Cross-origin isolation**: the SDK's multi-threaded WASM needs
  SharedArrayBuffer, so the page must send
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Wired for `npm run
  dev`/`preview` (vite.config.js) and `npm start` (public/serve.json —
  Vite copies it to `dist/serve.json`, where `serve` picks it up); any
  other host must send the same two headers. `crossOriginIsolated` must be
  `true` in the deployed tab, or the on-chain rail is unavailable (Stripe
  still works).

### The three guards in `onTopup`

Most of the top-up code in `App.jsx` is not the happy path — it is these,
and each one exists because its absence costs real money or locks the user
out of paying:

1. **Never pay one order twice.** `payTopup` returning means the money has
   left the wallet, so the order is remembered with its `paidTx`. If the
   credit wait times out and the user clicks again, the app **resumes the
   wait** instead of paying — two notes on one memo credit once and leave a
   duplicate for the operator to refund by hand.
2. **Reuse an unpaid order, don't mint another.** A closed tab or a declined
   popup leaves a pending order holding a capped slot (8 on-chain / 24h, 16
   card / 30 days) that only an operator can cancel. The next click calls
   `retryCheckout({memo})`; `topup_not_pending` means it is paid or expired
   and a new order is right. Any other failure **stops** — falling through to
   `createTopup` would spend a slot behind the user's back.
3. **Branch on the rail the server chose**, `order.provider`, never the one
   requested. The operator can route every top-up onto one rail and an
   order's rail is fixed for life, so a client that trusts its own request
   loops forever: asks for on-chain, gets a card order, calls that "no
   payment instructions", and creates a fresh order on every click.

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
