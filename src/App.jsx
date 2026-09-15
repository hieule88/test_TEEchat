import React, { useState, useCallback, useRef } from 'react';
import { aci, AciError, MAX_SPEND } from './aci';
import { buildTopupCustomTx } from './onchain-attach';

// React escapes all interpolated text ({value}) by default, so server-provided
// strings (model ids, error messages, receipts) can never inject markup.

const short = (s) => (!s ? '—' : s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);

function explain(e) {
  if (e instanceof AciError) {
    const hints = {
      no_balance: 'Out of credits — top up on the right.',
      wallet_spend_cap: 'Session spend cap reached — log out and open a new session.',
      wallet_session_expired: 'Session expired — log out and reconnect.',
      wallet_session_revoked: 'Session was revoked — reconnect.',
      wallet_missing: 'Leviathan wallet extension not found — install it and reload.',
      wallet_invalid_statement: e.message, // origin-mismatch detail is useful
      web_search_disabled: 'Web search is not enabled on this gateway — turn the 🔍 toggle off, or ask the operator to set web_search_enabled.',
    };
    return hints[e.type] || `${e.message} (${e.type})`;
  }
  return e?.message ?? String(e);
}

export default function App() {
  // aci holds the real state; these mirror it so React re-renders.
  const [account, setAccount] = useState(null);
  const [session, setSession] = useState(null);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState([
    { role: 'ai', text: '👋 Connect your Leviathan wallet, open a session, then chat. Every message is signed by your wallet — no API key.' },
  ]);
  const [banner, setBanner] = useState(null); // { kind, msg }
  const [prompt, setPrompt] = useState('');
  const [credits, setCredits] = useState(300);
  const [busy, setBusy] = useState(false);
  // Top-up rail: 'onchain' pays straight from the connected wallet (one
  // send popup, then we wait for the credit); 'stripe' opens a hosted
  // checkout tab. On-chain is the default — the user is already here
  // with a wallet.
  const [payProvider, setPayProvider] = useState('onchain');
  // Progress line for the on-chain flow (it has real stages, unlike a
  // checkout tab): 'sign' → 'commit' → 'credit' → null when done/idle.
  const [topupStep, setTopupStep] = useState(null);
  // The last order we created and never saw paid:
  //   {wanted, provider, memo, credits, paidTx?}
  // `wanted` is the rail the user asked for (what a repeated click
  // repeats); `provider` is the rail the SERVER put it on, which can
  // differ when the operator routes every top-up onto one rail. Pending
  // orders are capped per rail and only an operator can cancel one, so
  // minting a fresh order on every click is how a user locks themselves
  // out of paying: we reuse this one instead.
  const [pendingOrder, setPendingOrder] = useState(null);
  // Per-request web search opt-in. When on, the query the model composes
  // LEAVES the TEE to reach the search service — the gateway discloses every
  // such query in the response (`web_searches`) and we show it on the reply.
  const [webSearch, setWebSearch] = useState(false);

  // The conversation sent to the model, in OpenAI format. LLMs are stateless —
  // to have memory we must send the WHOLE history every request. Kept across
  // logout so re-opening a session continues the same conversation (in tab
  // memory only; closing the tab clears it).
  const historyRef = useRef([]);

  const sync = useCallback(() => {
    setAccount(aci.account);
    setSession(aci.session);
  }, []);

  const notify = useCallback((kind, msg) => {
    setBanner({ kind, msg });
    if (kind === 'ok') setTimeout(() => setBanner(null), 4000);
  }, []);

  const loadModels = useCallback(async () => {
    let ids = [];
    try { ids = (await aci.models()).map((m) => m.id).filter(Boolean); } catch { /* ignore */ }
    if (!ids.length) ids = ['gpt-oss-120b'];
    setModels(ids);
    setModel(ids[0]);
  }, []);

  const onConnectOrOpen = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    try {
      if (!aci.connected) {
        const a = await aci.connect();
        notify('ok', `Wallet connected · ${short(a.address || a.publicKeyHex)}`);
      } else {
        const s = await aci.openSession({ maxSpend: MAX_SPEND });
        if (s.warning) notify('warn', s.warning);
        else notify('ok', `Session open · you authorized up to ${s.maxSpend} credits`);
        await loadModels();
        if (!s.balance) notify('warn', 'New account, balance 0 — top up on the right to chat.');
      }
    } catch (e) {
      notify('err', explain(e));
    } finally {
      sync();
      setBusy(false);
    }
  }, [notify, loadModels, sync]);

  const onSend = useCallback(async (e) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    setPrompt('');
    setMessages((m) => [...m, { role: 'user', text }, { role: 'ai', text: '…', pending: true }]);
    setBusy(true);
    // Send the WHOLE conversation so the model has context.
    const outgoing = [...historyRef.current, { role: 'user', content: text }];
    try {
      // Only include the flag when on: an older gateway would forward an
      // unknown top-level field to the upstream, which may reject it.
      const { content, receiptId, raw } = await aci.chat({
        model, messages: outgoing, ...(webSearch ? { web_search: true } : {}),
      });
      // Egress disclosure from the gateway: every query the model sent out of
      // the enclave to the search service, verbatim ({query} or {raw}).
      const webSearches = webSearch && Array.isArray(raw?.web_searches)
        ? raw.web_searches.map((s) => s?.query ?? s?.raw ?? JSON.stringify(s))
        : null;
      // Commit both turns to history only on success (a failed turn is dropped
      // so it doesn't poison later context).
      // Rare upstream quirk: on obscure topics the model can spend all its
      // server-side search rounds and get cut off before composing an answer
      // (empty content, queries disclosed). Tell the user what happened.
      const text = content
        || (webSearches?.length
          ? '⚠ Model dùng hết lượt web search mà chưa kịp tổng hợp câu trả lời. Hãy hỏi lại cụ thể hơn (ví dụ kèm tên miền/từ khóa chính xác) — các truy vấn đã search ở dưới.'
          : '(empty response)');
      historyRef.current = [...outgoing, { role: 'assistant', content: content ?? '' }];
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: 'ai', text, receiptId, webSearches };
        return copy;
      });
      aci.refreshBalance().then(sync).catch(() => {});
    } catch (err) {
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: 'ai', text: `⚠ ${explain(err)}`, error: true };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }, [prompt, model, webSearch, sync]);

  const onRefresh = useCallback(async () => {
    try { await aci.refreshBalance(); sync(); notify('ok', 'Balance refreshed'); }
    catch (e) { notify('err', explain(e)); }
  }, [notify, sync]);

  const onTopup = useCallback(async () => {
    const c = parseInt(credits, 10);
    if (!Number.isInteger(c) || c <= 0) return notify('err', 'Enter a positive credit amount');

    const wanted = payProvider === 'onchain' ? 'onchain' : 'stripe';
    // Keyed on what the USER asked for, because that is what a repeated
    // click repeats. Which rail the order actually landed on is a
    // separate fact, read back from the server below.
    const reusable = (pendingOrder?.wanted === wanted
                      && pendingOrder.credits === c) ? pendingOrder : null;

    // Reuse that order rather than minting another one. Abandoned orders
    // (tab closed, wallet popup declined, provider hiccup) hold a capped
    // slot until they expire and only an operator can cancel them, so a
    // fresh order per click is how a user locks themselves out of paying.
    const orderFor = async () => {
      if (reusable) {
        try {
          return await aci.retryCheckout({ memo: reusable.memo });
        } catch (e) {
          if (e instanceof AciError && e.type === 'topup_not_pending') {
            setPendingOrder(null);   // paid or expired — fall through to a new one
          } else {
            // Could not reach the server to reopen it. Creating a second
            // order here would quietly spend another slot — exactly what
            // reuse exists to prevent — so stop and say what to do.
            throw new AciError('topup_reuse_failed',
              `Could not reopen your unpaid order ${reusable.memo}: ${e.message}. `
              + 'Try again, or change the amount to start a new order.');
          }
        }
      }
      const fresh = await aci.createTopup({ credits: c, provider: wanted });
      if (fresh.memo) {
        setPendingOrder({ wanted, provider: fresh.provider ?? wanted,
                          memo: fresh.memo, credits: c });
      }
      return fresh;
    };

    const waitForCredit = async (memo) => {
      await aci.waitForTopup({
        memo,
        onStatus: (s) => { if (s !== 'paid') setTopupStep(`credit (${s})`); },
      });
      await aci.refreshBalance().catch(() => {});
      sync();
      setPendingOrder(null);   // settled — the next click is a new order
      notify('ok', `Credited ${c} credits ✓`);
    };

    setBusy(true);
    try {
      // An order we already PAID but never saw credited (the wait timed
      // out, the tab closed) must never be paid a second time: two notes
      // on one memo means the ledger credits the order once and flags a
      // duplicate the operator has to refund by hand. Resume the wait.
      if (reusable?.paidTx) {
        notify('ok', 'This order is already paid — waiting for the credit…');
        setTopupStep('credit');
        await waitForCredit(reusable.memo);
        return;
      }

      if (wanted === 'onchain') setTopupStep('sign');
      const order = await orderFor();

      // Branch on the rail the SERVER put this order on, never on the one
      // we asked for. The operator can route every top-up onto a single
      // rail (TOPUP_PROVIDER_OVERRIDE) and the order's rail is then fixed
      // for life, so a client that trusts its own request loops forever:
      // asking for on-chain, being handed a card order, calling that "no
      // payment instructions", and minting a fresh order on every click.
      const rail = order.provider ?? (order.onchain ? 'onchain' : 'stripe');
      if (rail !== wanted) {
        notify('warn', rail === 'stripe'
          ? 'The operator currently routes every top-up through card payment — opening the card checkout for this order.'
          : 'The operator currently routes every top-up through the on-chain rail — paying from your wallet instead.');
      }

      if (rail !== 'onchain') {
        // Hosted checkout: open the tab; the webhook credits us.
        setTopupStep(null);
        // The order exists but the provider was down. It is remembered
        // above, so the next click retries THIS order instead of leaving
        // it behind and creating a second one.
        if (order.checkoutError) notify('warn', `Order created but the checkout link failed: ${order.checkoutError} — try again in a moment.`);
        else if (order.invoiceUrl) { window.open(order.invoiceUrl, '_blank'); notify('ok', 'Checkout opened — pay, then Refresh.'); }
        else notify('warn', 'No checkout URL returned.');
        return;
      }

      // On-chain: the SDK builds a note that carries the order memo as a
      // NoteAttachment and pays the EXACT quoted amount — the user never
      // types a number, and the memo on the note is what identifies the
      // order. One wallet popup, then two waits: the note committing
      // on-chain, and the operator's watcher crediting the ledger.
      if (order.checkoutError || !order.onchain) {
        notify('err', `On-chain quote failed: ${order.checkoutError ?? 'no payment instructions'}`);
        return;
      }
      notify('ok', `Approve the payment in your wallet — sending the exact quoted amount.`);
      setTopupStep('commit');
      // buildCustomTx embeds the order memo IN the note (NoteAttachment) via a
      // wallet Custom transaction — the memo is the ONLY thing that credits
      // the order, so there is no fallback: if the WASM SDK can't load (page
      // not cross-origin-isolated), payTopup throws BEFORE any money moves.
      const paid = await aci.payTopup(order, { buildCustomTx: buildTopupCustomTx });
      // The money has left the wallet. Record that against the order so
      // a later click resumes the wait above instead of paying again.
      setPendingOrder({ wanted, provider: 'onchain', memo: order.memo,
                        credits: c, paidTx: paid.transactionId });
      setTopupStep('credit');
      notify('ok', 'Payment committed on-chain — waiting for the credit…');
      await waitForCredit(order.memo);
    } catch (e) {
      if (e instanceof AciError && e.type === 'topup_timeout') {
        // Paid on-chain, not credited yet. The order is kept WITH its
        // paidTx, so clicking again resumes the wait rather than paying
        // a second time.
        notify('warn', 'Payment sent but not credited yet — press Buy credits again to keep waiting (it will not pay twice).');
      } else {
        notify('err', explain(e));
      }
    } finally {
      setTopupStep(null);
      setBusy(false);
    }
  }, [credits, payProvider, pendingOrder, notify, sync]);

  const onLogout = useCallback(async () => {
    try { await aci.revoke(); } catch { /* best-effort */ }
    setMessages((m) => [...m, { role: 'ai', text: '— session ended —' }]);
    sync();
    notify('ok', 'Logged out');
  }, [notify, sync]);

  const onNewChat = useCallback(() => {
    historyRef.current = [];
    setMessages([{ role: 'ai', text: 'New conversation — previous context cleared.' }]);
  }, []);

  const verifyReceipt = useCallback(async (id) => {
    try {
      const r = await aci.getReceipt(id);
      notify('ok', `Receipt verified · TEE-signed · ${r.model ?? ''} · id ${short(id)}`);
    } catch (e) { notify('err', explain(e)); }
  }, [notify]);

  const inSession = !!session;
  const connected = !!account;

  return (
    <div className="app">
      <header>
        <div className="brand">⚡ Leviathan Chat <small>· wallet-bound</small></div>
        <div className="spacer" />
        <span className="pill">
          <span className={`dot ${inSession ? 'on' : ''}`} />
          {inSession ? 'session open' : connected ? 'connected' : 'disconnected'}
        </span>
        {!inSession && (
          <button onClick={onConnectOrOpen} disabled={busy}>
            {connected ? 'Open session' : 'Connect wallet'}
          </button>
        )}
        {inSession && <button className="ghost" onClick={onNewChat}>New chat</button>}
        {inSession && <button className="ghost" onClick={onLogout}>Log out</button>}
      </header>

      {banner && <div className={`banner ${banner.kind}`}>{banner.msg}</div>}

      <main>
        <section className="chat">
          <div className="messages">
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role === 'user' ? 'user' : 'ai'}`} style={m.error ? { color: 'var(--err)' } : undefined}>
                {m.text}
                {m.webSearches && (
                  <span className="meta egress">
                    {m.webSearches.length ? (
                      <>
                        🔍 Truy vấn đã RA NGOÀI TEE tới dịch vụ search ({m.webSearches.length}):
                        {m.webSearches.map((q, j) => (
                          <span key={j} className="mono egress-q">“{q}”</span>
                        ))}
                      </>
                    ) : (
                      '🔍 Web search bật nhưng model không search — không có gì rời TEE.'
                    )}
                  </span>
                )}
                {m.receiptId && (
                  <span className="meta">
                    receipt {short(m.receiptId)}{' '}
                    <button className="ghost tiny" onClick={() => verifyReceipt(m.receiptId)}>verify</button>
                  </span>
                )}
              </div>
            ))}
          </div>

          <form className="composer" onSubmit={onSend}>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!inSession} title="Model">
              {models.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <button
              type="button"
              className={`ghost toggle ${webSearch ? 'on' : ''}`}
              onClick={() => setWebSearch((v) => !v)}
              disabled={!inSession}
              aria-pressed={webSearch}
              title={webSearch
                ? 'Web search BẬT: truy vấn model tự soạn sẽ rời TEE tới dịch vụ search; mọi truy vấn được hiển thị lại và ghi vào receipt.'
                : 'Web search TẮT: không có gì rời TEE. Bật để model tra cứu thông tin mới.'}
            >
              🔍 Web search {webSearch ? 'ON' : 'OFF'}
            </button>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={inSession ? 'Type a message…' : 'Open a session to start…'}
              disabled={!inSession || busy}
              autoComplete="off"
            />
            <button type="submit" disabled={!inSession || busy}>Send</button>
          </form>
        </section>

        <aside>
          <div>
            <h3>Account</h3>
            <div className="card">
              <div className="kv"><span>Wallet</span><span className="mono">{short(account?.address || account?.publicKeyHex)}</span></div>
              <div className="kv"><span>Identity</span><span className="mono">{session?.identityId ?? '—'}</span></div>
              <div className="kv"><span>Session</span><span className="mono">{short(session?.sessionId)}</span></div>
            </div>
          </div>

          <div>
            <h3>Balance</h3>
            <div className="card">
              <div className="balance">{session?.balance ?? '—'} <span className="unit">credits</span></div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="ghost" onClick={onRefresh} disabled={!inSession}>↻ Refresh</button>
              </div>
            </div>
          </div>

          <div>
            <h3>Top up</h3>
            <div className="card">
              <div className="row">
                <select
                  value={payProvider}
                  onChange={(e) => setPayProvider(e.target.value)}
                  disabled={busy}
                  title="Payment method"
                >
                  <option value="onchain">⛓ Wallet (on-chain)</option>
                  <option value="stripe">💳 Card (Stripe)</option>
                </select>
                <input type="number" min="1" value={credits} onChange={(e) => setCredits(e.target.value)} style={{ width: 90 }} />
                <button onClick={onTopup} disabled={!inSession || busy}>Buy credits</button>
              </div>
              {topupStep && (
                <div className="hint">
                  {topupStep === 'sign' && '① Creating the quote — approve the send in your wallet…'}
                  {topupStep === 'commit' && '② Waiting for the payment to commit on-chain…'}
                  {String(topupStep).startsWith('credit') && `③ On-chain ✓ — waiting for the ledger to credit (${topupStep})…`}
                </div>
              )}
              {!topupStep && (
                <div className="hint">
                  {payProvider === 'onchain'
                    ? 'Pays the exact quoted amount straight from your connected wallet (one public P2ID note carrying your order id, built for you — nothing to type). Credits land automatically once the payment is seen on-chain.'
                    : 'Opens a hosted checkout in a new tab. Balance updates after payment — hit Refresh.'}
                </div>
              )}
            </div>
          </div>

          <div>
            <h3>Edge</h3>
            <div className="card hint">
              serviceOrigin: <span className="mono">{aci.serviceOrigin}</span><br />
              (set via VITE_EDGE_ORIGIN — must equal the Edge's WALLET_SERVICE_ORIGIN)<br />
              authOrigin: <span className="mono">{aci.authOrigin ?? '—'}</span><br />
              (set via VITE_AUTH_ORIGIN — status polling for on-chain top-ups)
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
