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
  maxSpendMc: 100_000,   // millicredits the session may spend before re-auth
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
  constructor({ serviceOrigin, wallet = globalThis.leviathan, fetch = globalThis.fetch } = {}) {
    if (!serviceOrigin) throw new AciError('config', 'serviceOrigin is required');
    this.serviceOrigin = serviceOrigin.replace(/\/+$/, '');
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
      scope: s.scope, maxSpendMc: s.max_spend_mc, balanceMc: s.balance_mc ?? null,
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
   * @param {number}   [grant.maxSpendMc] default 100000 — the spend cap the USER signs
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
      scope: g.scope, max_spend_mc: Math.max(1, Math.floor(g.maxSpendMc)),
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
   * @returns {Promise<{content: string, receiptId: string|null, raw: object}>}
   */
  async chat({ model, messages, stream = false, ...rest }) {
    const res = await this.signedFetch('/v1/chat/completions',
      { body: JSON.stringify({ model, messages, stream, ...rest }) });
    if (!res.ok) throw await toError(res);
    const raw = await res.json();
    return {
      content: raw.choices?.[0]?.message?.content ?? null,
      receiptId: res.headers.get('x-receipt-id'),
      raw,
    };
  }

  /**
   * Self-serve top-up: create a payment intent for THIS wallet and get a
   * hosted checkout URL (NOWPayments). Open `invoiceUrl` for the user; on
   * payment their balance is credited automatically. Server sets the price
   * from `credits` — the caller never picks the amount.
   * @param {object} opts
   * @param {number} opts.credits   how many credits to buy (positive integer)
   * @param {string} [opts.provider] default 'nowpayments'
   * @returns {Promise<{invoiceUrl: string|null, memo: string, amountCents: number|null, checkoutError: string|null, raw: object}>}
   */
  async createTopup({ credits, provider = 'nowpayments' } = {}) {
    if (!Number.isInteger(credits) || credits <= 0) {
      throw new AciError('config', 'credits must be a positive integer');
    }
    const res = await this.signedFetch('/v1/wallet/payment-intents',
      { body: JSON.stringify({ credits, provider }) });
    if (!res.ok) throw await toError(res);
    const r = await res.json();
    return {
      invoiceUrl: r.invoice_url ?? null,
      memo: r.memo,
      amountCents: r.amount_cents ?? null,
      checkoutError: r.checkout_error ?? null,
      raw: r,
    };
  }

  /**
   * Refresh the credit balance for the current session — one signed GET, no
   * Falcon popup, no re-bind. Updates `.session.balanceMc` and returns it.
   * Call this after a top-up instead of reloading the page.
   * @returns {Promise<number>} current balance in millicredits
   */
  async refreshBalance() {
    const res = await this.signedFetch('/v1/wallet/balance', { method: 'GET' });
    if (!res.ok) throw await toError(res);
    const j = await res.json();
    if (this._session) this._session.balance_mc = j.balance_mc; // keep .session in sync
    return j.balance_mc;
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
