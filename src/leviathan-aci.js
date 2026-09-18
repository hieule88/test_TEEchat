/**
 * Leviathan wallet-bound ACI — browser client SDK.
 * =================================================================
 *
 * Drop-in client for talking to the Leviathan AI Edge with a Leviathan wallet
 * instead of an API key. It hides the whole protocol (Falcon bind statement,
 * the 3.1 Word mapping, per-request Ed25519 signing, replay nonces) behind a
 * few high-level methods, so a frontend only has to build UI.
 *
 * You provide UI; this SDK provides:
 *   connect()        → ask the wallet extension to connect
 *   openSession()    → one Falcon signature (wallet popup) opens a session
 *   chat()/models()  → normal calls, each silently Ed25519-signed
 *   getReceipt()     → fetch the TEE-signed receipt of a call
 *   createTopup()    → payment intent; 'onchain' returns wallet pay instructions
 *   payTopup()       → pay an 'onchain' intent from the wallet (one popup)
 *   waitForTopup()   → poll until the ledger credits the intent
 *   revoke()/revokeAll()
 *
 * Requirements
 * ------------
 *  - The Leviathan wallet extension must be installed (it injects
 *    `window.leviathan`). The SDK waits for it.
 *  - The Edge must have wallet auth enabled and must allow your page's origin
 *    via CORS (operator sets EDGE_CORS_ORIGINS). See README-FRONTEND.md.
 *  - `serviceOrigin` you pass MUST equal the Edge's WALLET_SERVICE_ORIGIN
 *    exactly (scheme + host + port), or binds are refused "different service".
 *
 * Crypto notes
 * ------------
 *  - Ed25519/X25519 come from @noble/curves (vendored, works on every browser;
 *    native WebCrypto only shipped these in Chrome 137+). SHA-256/512 use
 *    WebCrypto. Ed25519 signatures verify under the Edge's Python `cryptography`
 *    (same RFC 8032).
 *  - The session keys live only in this object (tab memory). Nothing is
 *    persisted; closing the tab drops them — re-open a session with one click.
 *  - The wallet's Falcon key never leaves the extension; it signs the bind
 *    statement inside the wallet after the user approves the popup.
 *
 * Bundler apps (Vite/webpack): replace the import below with
 *   import { ed25519, x25519 } from '@noble/curves/ed25519';
 * and `npm i @noble/curves`. For plain <script type=module> serving, keep the
 * relative import and ship ./vendor/noble-ed25519.js alongside this file.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519'; // README-FRONTEND.md §1: bundler swap

// ─── Protocol constants (docs/wallet-bound-aci.md) ───────────────────────────
const BIND_PURPOSE = 'leviathan.wallet.bind.v1';
const REQUEST_PURPOSE = 'leviathan.wallet.request.v1';
const GOLDILOCKS_P = (1n << 64n) - (1n << 32n) + 1n; // Leviathan field prime

const DEFAULTS = Object.freeze({
  scope: ['inference', 'receipts', 'models'],
  maxSpend: 100,         // credits the session may spend before re-auth (1 credit = 1 request)
  ttlSec: 12 * 60 * 60,  // session lifetime; the Edge caps this (≤24h)
});

// ─── Small helpers ────────────────────────────────────────────────────────────
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const utf8 = s => new TextEncoder().encode(s);
const sha256 = async b => hex(await crypto.subtle.digest('SHA-256', b));
const randPriv = c => (c.utils.randomSecretKey ?? c.utils.randomPrivateKey)();

/** JCS (RFC 8785) over integer-only objects — same subset the Edge uses.
 *  Exported so a frontend can canonicalize/verify a statement if it wants. */
export function jcs(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('only integer numbers are allowed');
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;
}

/** 3.1: statement → the 32-byte Leviathan Word the wallet's Falcon key signs.
 *  Exported for verification/testing; the Edge computes the identical bytes. */
export async function statementWordBytes(statement) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', utf8(jcs(statement))));
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) {
    let limb = 0n;
    for (let b = 7; b >= 0; b--) limb = (limb << 8n) | BigInt(digest[i * 8 + b]);
    view.setBigUint64(i * 8, limb % GOLDILOCKS_P, true); // little-endian, reduced mod p
  }
  return out;
}

/** A typed error carrying the Edge's machine-readable `type` and HTTP status. */
export class AciError extends Error {
  constructor(type, message, status) {
    super(message);
    this.name = 'AciError';
    this.type = type;
    this.status = status;
  }
}

async function toError(res) {
  let type = `http_${res.status}`;
  let message = res.statusText || 'request failed';
  try {
    const body = await res.json();
    type = body?.error?.type ?? type;
    message = body?.error?.message ?? message;
  } catch { /* non-JSON error body */ }
  return new AciError(type, message, res.status);
}

// ─── The SDK ──────────────────────────────────────────────────────────────────

export class LeviathanACI {
  /**
   * @param {object}   opts
   * @param {string}   opts.serviceOrigin  Edge base URL (no trailing slash), e.g.
   *                                        'https://leviathan-edge.duckdns.org'.
   *                                        MUST equal the Edge's WALLET_SERVICE_ORIGIN.
   * @param {object}  [opts.wallet]        Wallet provider; defaults to window.leviathan.
   * @param {typeof fetch} [opts.fetch]    Custom fetch (tests/SSR); defaults to window.fetch.
   */
  constructor({ serviceOrigin, authOrigin = null, wallet = globalThis.leviathan, fetch = globalThis.fetch } = {}) {
    if (!serviceOrigin) throw new AciError('config', 'serviceOrigin is required');
    this.serviceOrigin = serviceOrigin.replace(/\/+$/, '');
    // auth-service base URL (e.g. 'https://leviathan-auth.duckdns.org') — only
    // needed by waitForTopup(), which polls the PUBLIC intent-status endpoint
    // there. Optional; can also be passed per call.
    this.authOrigin = authOrigin ? authOrigin.replace(/\/+$/, '') : null;
    this._wallet = wallet;
    this._fetch = fetch.bind(globalThis);
    this._account = null;   // { address, publicKeyHex }
    this._keys = null;      // { signPriv, signPubHex, e2eePubHex }
    this._session = null;   // bind response
  }

  /** Wait for the wallet extension to inject `window.leviathan`. */
  static async detectWallet({ timeoutMs = 3000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (globalThis.leviathan) return globalThis.leviathan;
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  get connected() { return !!this._account; }
  get account() { return this._account; }
  /** Public session info (safe to show); the private keys are NOT here. */
  get session() {
    const s = this._session;
    return s && {
      sessionId: s.session_id, identityId: s.identity_id, expiresAt: s.expires_at,
      scope: s.scope, maxSpend: s.max_spend, balance: s.balance ?? null,
      warning: s.warning ?? null,
    };
  }

  /**
   * Ask the wallet to connect (extension popup). Must be called first.
   * @returns {Promise<{address: string, publicKeyHex: string}>}
   */
  async connect() {
    if (!this._wallet) throw new AciError('wallet_missing', 'Leviathan wallet extension not found');
    await this._wallet.connect();
    this._account = { address: this._wallet.address ?? null, publicKeyHex: hex(this._wallet.publicKey) };
    return this._account;
  }

  /**
   * Open a session: fetch a challenge, build + Falcon-sign the bind statement
   * (ONE wallet popup), and register it with the Edge. After this, calls are
   * signed silently. Idempotent-ish: re-opening replaces the session.
   *
   * @param {object} [grant]
   * @param {string[]} [grant.scope]      default ['inference','receipts','models']
   * @param {number}   [grant.maxSpend]   default 100 — the spend cap (credits) the USER signs
   * @param {number}   [grant.ttlSec]     default 12h (Edge caps ≤24h)
   * @param {string|null} [grant.accountId] optional bech32 Leviathan address label (unverified)
   * @returns {Promise<object>} the public session info (see `.session`)
   */
  async openSession(grant = {}) {
    if (!this.connected) throw new AciError('not_connected', 'call connect() first');
    const g = { ...DEFAULTS, ...grant };

    // 1. single-use challenge
    const ch = await this._json('POST', '/v1/wallet/challenge',
      { wallet_pub_key: this._account.publicKeyHex });
    if (ch.service !== this.serviceOrigin) {
      throw new AciError('wallet_invalid_statement',
        `Edge serves ${ch.service}, but serviceOrigin is ${this.serviceOrigin}`);
    }

    // 2. fresh session keys (Ed25519 to sign requests, X25519 for ACI E2EE)
    this._keys = this._generateSessionKeys();

    // 3. the bind statement — issued_at derived from the Edge clock (challenge),
    //    so a skewed local clock does not produce a "stale" statement.
    const issuedAt = Number(ch.expires_at) - 300;
    const statement = {
      purpose: BIND_PURPOSE, service: this.serviceOrigin, nonce: ch.nonce,
      issued_at: issuedAt, expires_at: issuedAt + g.ttlSec,
      wallet_pub_key: this._account.publicKeyHex,
      account_id: grant.accountId ?? null,
      session_pub_key: this._keys.signPubHex, e2ee_pub_key: this._keys.e2eePubHex,
      scope: g.scope, max_spend: Math.max(1, Math.floor(g.maxSpend)),
    };

    // 4. Falcon-sign inside the wallet (user approves the popup)
    const word = await statementWordBytes(statement);
    const { signature } = await this._wallet.signBytes(word, 'word');

    // 5. bind
    this._session = await this._json('POST', '/v1/wallet/bind',
      { statement, signature: b64(signature) });
    return this.session;
  }

  /**
   * Low-level: make an authenticated call. Every request is Ed25519-signed over
   * (method, path, sha256(body), timestamp, nonce). Use this for any Edge path.
   * @param {string} path  e.g. '/v1/chat/completions'
   * @param {{method?:string, body?:string, headers?:object}} [init]
   * @returns {Promise<Response>}
   */
  async signedFetch(path, { method = 'POST', body, headers = {} } = {}) {
    if (!this._session) throw new AciError('no_session', 'call openSession() first');
    const m = method.toUpperCase();
    const ts = Math.floor(Date.now() / 1000);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const bodyHash = await sha256(utf8(body ?? ''));
    const payload = jcs({ purpose: REQUEST_PURPOSE, session: this._session.session_id,
      method: m, path, body_sha256: bodyHash, ts, nonce });
    const sig = ed25519.sign(utf8(payload), this._keys.signPriv);

    const h = {
      ...headers,
      authorization: `Wallet ${this._session.session_id}`,
      'x-wallet-timestamp': String(ts), 'x-wallet-nonce': nonce, 'x-wallet-signature': b64(sig),
    };
    if (body !== undefined) h['content-type'] = 'application/json';
    return this._fetch(`${this.serviceOrigin}${path}`, { method: m, headers: h,
      ...(body !== undefined ? { body } : {}) });
  }

  /**
   * Convenience chat call (OpenAI-compatible, non-streaming).
   *
   * Streaming is NOT supported here: this method reads the reply as one JSON
   * document, which is incompatible with SSE. Passing `stream: true` throws
   * up front (a typed, self-explanatory error) instead of letting res.json()
   * die on the SSE bytes. If you need streaming, call signedFetch() yourself
   * and parse the `data:` chunks.
   * @returns {Promise<{content: string, receiptId: string|null, raw: object}>}
   */
  async chat({ model, messages, stream, ...rest }) {
    if (stream) {
      throw new AciError('config',
        'streaming is not supported by chat() — use signedFetch() and parse the SSE yourself');
    }
    const res = await this.signedFetch('/v1/chat/completions',
      { body: JSON.stringify({ model, messages, ...rest }) });
    if (!res.ok) throw await toError(res);
    const raw = await res.json();
    return {
      content: raw.choices?.[0]?.message?.content ?? null,
      receiptId: res.headers.get('x-receipt-id'),
      raw,
    };
  }

  /**
   * Self-serve top-up: create a payment intent for THIS wallet. Server sets
   * the price from `credits` — the caller never picks the amount.
   *
   * provider 'stripe' → hosted checkout: open `invoiceUrl`
   * for the user; on payment their balance is credited automatically.
   * provider 'onchain' → no checkout page: `onchain` carries the payment
   * instructions (gateway address, faucet id, exact token amount, memo) —
   * pass the whole result to payTopup() to pay from the connected wallet,
   * then waitForTopup() until the operator's note-watcher credits it.
   * @param {object} opts
   * @param {number} opts.credits   how many credits to buy (positive integer)
   * @param {string} [opts.provider] 'stripe' (default) or 'onchain'
   * @returns {Promise<{invoiceUrl: string|null, memo: string, amountCents: number|null, onchain: object|null, checkoutError: string|null, raw: object}>}
   */
  /**
   * Create a top-up order. `senderAddress` (default: the connected
   * account) is sent on EVERY rail — see the note inside: the server may
   * put the order on-chain regardless of `provider`.
   */
  async createTopup({ credits, provider = 'stripe',
                      senderAddress = this._account?.address ?? null } = {}) {
    if (!Number.isInteger(credits) || credits <= 0) {
      throw new AciError('config', 'credits must be a positive integer');
    }
    // Always name the paying account when connected — NOT only when we
    // asked for on-chain. The operator can route every top-up onto one
    // rail (TOPUP_PROVIDER_OVERRIDE), so an order we asked to put on
    // Stripe may land on-chain; without the sender the server cannot
    // build its wallet payload and the first payTopup fails. The server
    // ignores the field on the Stripe rail. The address lets the server
    // build the payload (onchain.custom_tx) so the page needs no Miden
    // SDK; a Miden note names its sender and the wallet signs only for
    // its own account, so this is the connected account by default.
    const body = { credits, provider };
    if (senderAddress) body.sender_address = senderAddress;
    const res = await this.signedFetch('/v1/wallet/payment-intents',
      { body: JSON.stringify(body) });
    if (!res.ok) throw await toError(res);
    const r = await res.json();
    return {
      invoiceUrl: r.invoice_url ?? null,
      memo: r.memo,
      // The rail the SERVER put this order on. Branch on THIS, never on
      // the provider you asked for: the operator's TOPUP_PROVIDER_OVERRIDE
      // can route every top-up onto one rail, and the order's rail is
      // then fixed for life.
      provider: r.provider ?? null,
      amountCents: r.amount_cents ?? null,
      onchain: r.onchain ?? null,
      checkoutError: r.checkout_error ?? null,
      raw: r,
    };
  }

  /**
   * Rebuild the payment instructions for an order you already created,
   * instead of creating another one.
   *
   * Reach for this whenever a top-up was created but not paid — the
   * provider was down, the user closed the tab, the wallet popup was
   * declined. Pending orders are capped per rail and only an operator
   * can cancel one, so every abandoned order costs the user a slot until
   * it expires (30 days on the card rail). Minting a fresh order per
   * click is how a user locks themselves out of paying at all.
   *
   * With an open session this goes through the Edge, signed: that is
   * what lets the server (re)prepare the on-chain wallet payload for the
   * connected account — a write the ledger only performs for the order
   * owner. Without a session it falls back to auth-service's public,
   * READ-ONLY route (like waitForTopup): holding the memo only ever lets
   * you re-read stored instructions, and paying them credits the order's
   * original owner. The order's RAIL is fixed at creation — this rebuilds
   * that rail's instructions and cannot move it to another.
   *
   * @param {object} opts
   * @param {string} opts.memo          memo from the original createTopup()
   * @param {string} [opts.authOrigin]  default: constructor's authOrigin
   * @returns {Promise<{invoiceUrl: string|null, memo: string, amountCents: number|null, onchain: object|null, raw: object}>}
   * @throws {AciError} 'topup_not_pending' when the order can no longer
   *   be paid (already paid, expired, cancelled) — create a new one.
   */
  async retryCheckout({ memo, authOrigin = this.authOrigin,
                        senderAddress = this._account?.address ?? null } = {}) {
    if (!memo) throw new AciError('config', 'memo is required');
    let res;
    if (this._session) {
      // With a session: through the Edge, SIGNED. The Edge vouches for the
      // order owner, which is what lets the server (re)prepare the wallet
      // payload for the connected account — the public route is read-only
      // for that (anyone holding a memo could otherwise drive the builder,
      // since memos are public on-chain once a note commits).
      // No provider: "this order's own rail".
      const body = senderAddress ? { sender_address: senderAddress } : {};
      res = await this.signedFetch(`/v1/wallet/payment-intents/${memo}/checkout`,
        { body: JSON.stringify(body) });
    } else {
      // No session: the public, read-only route on auth-service. It hands
      // back whatever instructions are stored; it will not prepare a
      // payload for a new account (that needs the session path above).
      if (!authOrigin) {
        throw new AciError('config',
          "authOrigin is required (auth-service base URL, e.g. 'https://leviathan-auth.duckdns.org')");
      }
      const base = authOrigin.replace(/\/+$/, '');
      res = await this._fetch(`${base}/v1/payment-intents/${memo}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    }
    if (res.status === 404 || res.status === 409) {
      throw new AciError('topup_not_pending',
        `order ${memo} can no longer be paid — create a new top-up`, res.status);
    }
    if (!res.ok) throw await toError(res);
    const r = await res.json();
    return {
      invoiceUrl: r.invoice_url ?? null,
      memo: r.memo,
      provider: r.provider ?? null,   // the order's rail — see createTopup
      amountCents: r.amount_cents ?? null,
      onchain: r.onchain ?? null,
      raw: r,
    };
  }

  /**
   * Pay an 'onchain' top-up straight from the connected Leviathan wallet
   * (ONE wallet popup — the user approves the transaction).
   *
   * The payment MUST carry the intent memo on the note itself: matching
   * is memo-only (amounts are plain prices and collide across same-price
   * orders), so `buildCustomTx` is REQUIRED — an app-provided async
   * builder (see onchain-attach.js) that bundles @miden-sdk and returns
   * the payload for wallet.requestTransaction({type:'Custom'}): a
   * serialized P2ID transaction paying the exact quoted amount with the
   * memo as a NoteAttachment. The builder stays app-side so this SDK
   * remains zero-dependency.
   *
   * There is deliberately NO fallback to the wallet's plain
   * requestSend(): a memo-less payment cannot be auto-credited — the
   * money would arrive and park as an ops case. If the builder fails
   * (the WASM SDK won't load — e.g. the page is not cross-origin
   * isolated), payTopup throws 'attachment_unavailable' BEFORE any
   * money moves; fix the deployment rather than paying blind.
   *
   * @param {object} topup  the createTopup() result (or any object with `.onchain`)
   * @param {object} [opts]
   * @param {boolean} [opts.waitForCommit=true]   also wait for the tx to commit on-chain
   * @param {(args: {senderAddress: string, onchain: object}) => Promise<object>} [opts.buildCustomTx]
   *        Fallback builder for orders WITHOUT a server-built payload (see below).
   * @returns {Promise<{transactionId: string, memo: string, commit: object|null, viaAttachment: true, source: 'server'|'client'}>}
   *          `source` says who built the payload: 'server' (onchain.custom_tx,
   *          the normal case) or 'client' (the buildCustomTx fallback).
   *          `commit` is the wallet's waitForTransaction output (txHash, outputNotes)
   *          when waitForCommit, else null. On-chain commit ≠ credited: follow with
   *          waitForTopup() for the ledger side.
   */
  async payTopup(topup, { waitForCommit = true, buildCustomTx = null } = {}) {
    const oc = topup?.onchain ?? topup?.raw?.onchain ?? null;
    if (!oc) {
      throw new AciError('config',
        "not an onchain top-up — create it with createTopup({provider: 'onchain'})");
    }
    if (!this._wallet) throw new AciError('wallet_missing', 'Leviathan wallet extension not found');
    if (!this.connected) throw new AciError('not_connected', 'call connect() first');
    let payload;
    let source;
    const served = oc.custom_tx;
    if (served?.transactionRequest && served?.address) {
      // The SERVER built the payload (the order was created with this
      // account as sender). It is bound to that account: a Miden note
      // names its sender and the wallet signs only for its own account,
      // so paying from another account cannot work — say so instead of
      // letting the wallet fail opaquely, and point at the fix.
      if (this._account.address && served.address !== this._account.address) {
        throw new AciError('sender_mismatch',
          `this order's payment was prepared for account ${served.address}, but the `
          + `connected account is ${this._account.address} — call retryCheckout({memo}) `
          + 'to prepare it for the connected account, then pay again');
      }
      payload = {
        address: served.address,
        recipientAddress: served.recipientAddress ?? oc.pay_to_address,
        transactionRequest: served.transactionRequest,
      };
      source = 'server';
    } else if (typeof buildCustomTx === 'function') {
      // Legacy/fallback: the page bundles the Miden SDK and builds the
      // note itself (see onchain-attach.js). Needs a cross-origin-isolated
      // page for the SDK's WASM.
      try {
        payload = await buildCustomTx({ senderAddress: this._account.address, onchain: oc });
      } catch (e) {
        throw new AciError('attachment_unavailable',
          'cannot build the memo-carrying transaction (is the page '
          + `cross-origin-isolated and @miden-sdk installed?): ${e?.message ?? e}`);
      }
      source = 'client';
    } else {
      // An on-chain order with no prepared payload: created by an older
      // client, or before the wallet was connected. Recoverable —
      // retryCheckout({memo}) sends the connected account and the server
      // prepares the payload — so say that, not "misconfigured".
      throw new AciError('payload_missing',
        'this order has no prepared wallet payload yet — call '
        + 'retryCheckout({memo}) to have the server prepare it for the '
        + 'connected account, then pay again');
    }
    const r = await this._wallet.requestTransaction({ type: 'Custom', payload });
    const transactionId = r?.transactionId;
    if (!transactionId) {
      throw new AciError('wallet_rejected', 'wallet did not return a transaction id');
    }
    const viaAttachment = true;

    let commit = null;
    if (waitForCommit && typeof this._wallet.waitForTransaction === 'function') {
      commit = await this._wallet.waitForTransaction(transactionId);
      if (commit?.errorMessage) {
        throw new AciError('onchain_tx_failed', commit.errorMessage);
      }
    }
    return { transactionId, memo: oc.memo ?? topup.memo, commit, viaAttachment, source };
  }

  /**
   * Poll the intent until the ledger credits it (status 'paid') — the on-chain
   * analogue of waiting for a checkout webhook. Polls auth-service's PUBLIC
   * status endpoint (safe: the memo is opaque and paying it can only ever
   * credit the intent's own identity), so it needs the auth origin — pass it
   * here or in the constructor. Resolves with the intent; throws AciError
   * 'topup_expired' / 'topup_cancelled' / 'topup_timeout'. After it resolves,
   * call refreshBalance() to update `.session.balance`.
   *
   * @param {object} opts
   * @param {string} opts.memo            intent memo from createTopup()
   * @param {string} [opts.authOrigin]    default: constructor's authOrigin
   * @param {number} [opts.timeoutMs=900000]
   * @param {number} [opts.intervalMs=5000]
   * @param {(status: string, intent: object) => void} [opts.onStatus] status-change callback
   * @returns {Promise<object>} the paid intent
   */
  async waitForTopup({ memo, authOrigin = this.authOrigin,
                       timeoutMs = 900_000, intervalMs = 5_000, onStatus } = {}) {
    if (!memo) throw new AciError('config', 'memo is required');
    if (!authOrigin) {
      throw new AciError('config',
        "authOrigin is required (auth-service base URL, e.g. 'https://leviathan-auth.duckdns.org')");
    }
    const base = authOrigin.replace(/\/+$/, '');
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        const res = await this._fetch(`${base}/v1/payment-intents/${memo}`);
        if (res.ok) {
          const intent = await res.json();
          if (intent.status !== last) { last = intent.status; onStatus?.(intent.status, intent); }
          if (intent.status === 'paid') return intent;
          if (intent.status === 'expired' || intent.status === 'cancelled') {
            throw new AciError(`topup_${intent.status}`, `intent ended as '${intent.status}' without payment`);
          }
        }
      } catch (e) {
        if (e instanceof AciError) throw e;
        // network blip — keep polling until the deadline
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new AciError('topup_timeout',
      `intent ${memo} not paid after ${Math.round(timeoutMs / 1000)}s — the order stays valid, keep checking`);
  }

  /**
   * Refresh the credit balance for the current session — one signed GET, no
   * Falcon popup, no re-bind. Updates `.session.balance` and returns it.
   * Call this after a top-up instead of reloading the page.
   * @returns {Promise<number>} current balance in credits
   */
  async refreshBalance() {
    const res = await this.signedFetch('/v1/wallet/balance', { method: 'GET' });
    if (!res.ok) throw await toError(res);
    const j = await res.json();
    if (this._session) this._session.balance = j.balance; // keep .session in sync
    return j.balance;
  }

  /** List models (no debit). */
  async models() {
    const res = await this.signedFetch('/v1/models', { method: 'GET' });
    if (!res.ok) throw await toError(res);
    return (await res.json()).data ?? [];
  }

  /** Fetch a TEE-signed receipt by id (only this wallet can read its own). */
  async getReceipt(receiptId) {
    const res = await this.signedFetch(`/v1/aci/receipts/${receiptId}`, { method: 'GET' });
    if (!res.ok) throw await toError(res);
    return await res.json();
  }

  /** End this session (call on wallet lock / disconnect). Best-effort. */
  async revoke() {
    try {
      const res = await this.signedFetch('/v1/wallet/session/revoke', { body: '' });
      return res.ok;
    } catch { return false; }
    finally { this._session = null; this._keys = null; }
  }

  /** Kill every session of this wallet across devices (lost-device button). */
  async revokeAll() {
    const res = await this.signedFetch('/v1/wallet/sessions/revoke-all', { body: '' });
    if (!res.ok) throw await toError(res);
    return (await res.json()).revoked ?? 0;
  }

  // ── internals ──────────────────────────────────────────────────────────────
  _generateSessionKeys() {
    const signPriv = randPriv(ed25519);
    const e2eePriv = randPriv(x25519); // its private half is unused here; only the
    return {                           // public key goes into the bind statement
      signPriv,
      signPubHex: hex(ed25519.getPublicKey(signPriv)),
      e2eePubHex: hex(x25519.getPublicKey(e2eePriv)),
    };
  }

  async _json(method, path, body) {
    const res = await this._fetch(`${this.serviceOrigin}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw await toError(res);
    return await res.json();
  }
}

export default LeviathanACI;
