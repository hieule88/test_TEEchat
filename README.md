# Leviathan Wallet Chat — Vite + React

A wallet-bound chat app built **as a frontend dev would**, following the
handover's `README-FRONTEND.md`: a Vite/React app that uses the
`leviathan-aci.js` SDK. No API key — every request is signed by the user's
Leviathan wallet.

It doubles as the **reference implementation** for the on-chain top-up rail
(handover package: `leviathan-ai-gateway-verify/wallet-aci/dapp/`). It is
deliberately a plain Vite app: **no Miden SDK, no WASM, no private npm
registry, no special HTTP headers** — the server prepares the on-chain
transaction and this page only hands it to the wallet.

```
test_frontend/
  index.html            ← Vite entry
  vite.config.js        ← stock Vite + React
  package.json
  .env                  ← VITE_EDGE_ORIGIN + VITE_AUTH_ORIGIN
  src/
    main.jsx
    App.jsx             ← the chat UI + two-rail top-up (React)
    aci.js              ← the single LeviathanACI instance (README §2)
    leviathan-aci.js    ← SDK, import swapped to '@noble/curves/ed25519' (README §1)
    styles.css
```

## Run

```bash
cd test_frontend
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
   `import { ed25519, x25519 } from '@noble/curves/ed25519';`.
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
   **Refresh**. The on-chain rail is on the Miden **testnet**; the test token
   is the wallet's built-in USDT test faucet (free mint from the wallet).

Note: React escapes interpolated text by default, so server-provided strings
(model ids, error messages) can't inject markup.

## On-chain top-up (pay with the wallet itself)

The Top up panel has two rails. **⛓ Wallet (on-chain)** — the default — pays
straight from the connected Leviathan wallet, walking ① quote/sign →
② commit → ③ credit. **💳 Card (Stripe)** keeps the old hosted-checkout tab.

### The server builds the transaction

`createTopup({ provider: 'onchain' })` sends the connected account's
address; the **server** builds the exact transaction — a public P2ID note
paying the quoted amount and carrying the **order memo as a
`NoteAttachment`** — and returns it as `onchain.custom_tx`. `payTopup(order)`
hands it to `wallet.requestTransaction({type: 'Custom'})`; the wallet only
signs and publishes. The status line shows the wallet's transaction id once
the note is committed; there is no other way to pay — the SDK has no
client-side builder.

Why the memo lives on the note: it is the ONLY thing that matches a payment
to an order (amounts are plain prices and collide across same-price
orders). Why the server builds it: the wallet's plain send has no slot for
an attachment, someone has to produce the serialized transaction, and doing
it server-side keeps the memo codec in one place (next to the watcher that
decodes it) and keeps every Miden dependency out of the frontend.

The payload is **bound to the account that created the order** — a Miden
note names its sender and the wallet signs only for its own account. If the
user switches wallet accounts in between, `payTopup` throws
`sender_mismatch` before anything moves; the next click's `retryCheckout`
prepares the order for the current account. If the server returns no
payload at all (builder not configured), `payTopup` throws `config` —
fail closed, nothing is spent.

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
   `retryCheckout({memo})` — which returns the **same** stored transaction,
   so retrying never creates a second payable note; `topup_not_pending`
   means it is paid or expired and a new order is right. Any other failure
   **stops** — falling through to `createTopup` would spend a slot behind
   the user's back.
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
