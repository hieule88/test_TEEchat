import React, { useState, useCallback, useEffect, useRef } from 'react';
import { aci, AciError, MAX_SPEND } from './aci';
import {
  MAX_SOURCE_BYTES, imageTurnContent, nextImageNumber, outgoingFor, prepareImage, stripHistoryImages, toWire,
  trimImageContext,
} from './vision';

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
      // The order's transaction was prepared for a different wallet account
      // than the one now connected. The order is kept, so the next click's
      // retryCheckout prepares it for the current account.
      sender_mismatch: 'Your wallet account changed since this order was created — press Buy credits again to pay from the current account.',
      // E2EE: the gateway must confirm it decrypted our fields; otherwise the
      // message may have travelled in plaintext somewhere and we say so.
      e2ee_not_applied: 'The gateway did not confirm end-to-end encryption — message not sent as confidential. Tell the operator.',
      e2ee_no_key: 'The attestation report has no E2EE key — cannot encrypt to the enclave. Tell the operator.',
      // No prepared transaction on the order yet; the order is kept and the
      // next click's retryCheckout has the server prepare it.
      payload_missing: 'Preparing your on-chain payment — press Buy credits again.',
      // The whole conversation is resent each turn and E2EE doubles it as hex;
      // the gateway refuses bodies over 32 MB. The credit for a 413 is refunded.
      // Reached only after the automatic retry without images also failed.
      http_413: 'This conversation is too large to send even without images — start a New chat (the credit was refunded).',
    };
    return hints[e.type] || `${e.message} (${e.type})`;
  }
  return e?.message ?? String(e);
}

export default function App() {
  // aci holds the real state; these mirror it so React re-renders.
  const [account, setAccount] = useState(null);
  const [session, setSession] = useState(null);
  // Model objects from /v1/models — the Edge decorates each with
  // `input_modalities`, which is what gates the image-attach button.
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  // A pending image for the next message: { name, dataUrl, bytes, width,
  // height, resized }. Kept as a data URL on purpose — a remote URL would make
  // the upstream fetch it, and that host would learn someone is asking an AI
  // about this picture. Shrunk before it is ever encrypted (vision.js): E2EE
  // writes hex, so every byte costs two on the wire.
  const [attachment, setAttachment] = useState(null);
  const fileRef = useRef(null);
  // The text-only model we last warned about (images in history withheld
  // from it) — so the notice shows once per switch, not on every turn.
  const textOnlyNoticeRef = useRef(null);
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
    let list = [];
    try {
      list = (await aci.models())
        .filter((m) => m && typeof m.id === 'string')
        .map((m) => ({ id: m.id, input_modalities: Array.isArray(m.input_modalities) ? m.input_modalities : ['text'] }));
    } catch { /* ignore */ }
    if (!list.length) list = [{ id: 'glm-5.3-flash', input_modalities: ['text', 'image'] }];
    setModels(list);
    setModel(list[0].id);
  }, []);

  const modelInfo = models.find((m) => m.id === model);
  const canAttach = (modelInfo?.input_modalities ?? ['text']).includes('image');

  // Switching to a text-only model while an image is staged: drop it and say so,
  // rather than sending a request the model cannot serve.
  useEffect(() => {
    if (attachment && !canAttach) {
      setAttachment(null);
      notify('warn', `${model} does not accept images — attachment removed.`);
    }
  }, [attachment, canAttach, model, notify]);

  const onPickImage = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return notify('err', 'Only image files can be attached.');
    if (file.size > MAX_SOURCE_BYTES) {
      return notify('err', `Image too large (${(file.size / 1e6).toFixed(1)} MB) — limit ${MAX_SOURCE_BYTES / 1e6} MB.`);
    }
    try {
      const img = await prepareImage(file);
      setAttachment(img);
      if (img.resized) {
        const fmt = img.mime === 'image/png' ? 'PNG (kept lossless)' : 'JPEG';
        notify('ok', `Resized ${file.name} to ${img.width}×${img.height} — `
          + `${(img.originalBytes / 1e6).toFixed(1)} MB → ${(img.bytes / 1e3).toFixed(0)} KB ${fmt} before encryption.`);
      }
    } catch (err) {
      notify('err', `Could not attach ${file.name}: ${err?.message ?? err}`);
    }
  }, [notify]);

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
    const image = attachment;
    if (!text && !image) return;
    setPrompt('');
    setAttachment(null);
    setMessages((m) => [...m, { role: 'user', text, image: image?.dataUrl ?? null }, { role: 'ai', text: '…', pending: true }]);
    setBusy(true);
    // Send the WHOLE conversation so the model has context. With an image the
    // turn is OpenAI content parts — a numbered label ("Image 2 (x.png):"),
    // the image, then the question — so the model can be asked about "image
    // 2" later and the placeholder that replaces a trimmed image carries the
    // same name. The SDK encrypts each part (text AND the image data URL) to
    // the enclave key before anything leaves this page; the `_`-fields are
    // app-only and stripped by toWire.
    const userContent = image
      ? imageTurnContent({ n: nextImageNumber(historyRef.current), name: image.name, dataUrl: image.dataUrl, text })
      : text;
    const full = [...historyRef.current, { role: 'user', content: userContent }];
    // Images in context are paid for again on every turn (the whole
    // conversation is resent, and E2EE doubles it as hex). Keep them within a
    // byte budget, oldest out first; the newest image always stays so a
    // follow-up question about it still works.
    let { messages: outgoing, dropped } = trimImageContext(full);
    if (dropped.length) {
      notify('warn', `Older image${dropped.length > 1 ? 's' : ''} left the conversation context to keep it sendable: ${dropped.join(', ')}.`);
    }
    // `outgoing` is what we KEEP. What we SEND may have less: a model whose
    // input_modalities lack "image" (the user switched mid-conversation) gets
    // every image replaced by its placeholder for this request only — sending
    // them would fail on every turn until New chat — while the kept history
    // still has them, so switching back to a vision model restores them.
    let toSend = outgoing;
    if (canAttach) {
      textOnlyNoticeRef.current = null;
    } else {
      const withheld = outgoingFor(outgoing, { imagesAllowed: false });
      toSend = withheld.messages;
      if (withheld.dropped.length && textOnlyNoticeRef.current !== model) {
        textOnlyNoticeRef.current = model;
        notify('warn', `${model} does not take images — ${withheld.dropped.length} image${withheld.dropped.length > 1 ? 's' : ''} in this conversation `
          + `replaced by a placeholder for it (${withheld.dropped.join(', ')}). Pick a model marked 👁 to ask about them again.`);
      }
    }
    try {
      // Only include the flag when on: an older gateway would forward an
      // unknown top-level field to the upstream, which may reject it.
      const send = (msgs) => aci.chat({
        model, messages: toWire(msgs), ...(webSearch ? { web_search: true } : {}),
      });
      let result;
      try {
        result = await send(toSend);
      } catch (err) {
        // 413: the body still exceeded the gateway's cap. The Edge refunded
        // that credit. Drop the OLDER images (history only — the turn being
        // sent keeps its picture, or the model would answer about an image
        // it never received) and try once more. Nothing older to drop means
        // this turn's image or the text is the cause: no retry, the outer
        // catch gives the image back.
        const isTooLarge = err instanceof AciError && err.status === 413;
        const stripped = isTooLarge ? stripHistoryImages(toSend) : null;
        if (!stripped || !stripped.dropped.length) throw err;
        notify('warn', `The request was too large — retrying without the ${stripped.dropped.length} image${stripped.dropped.length > 1 ? 's' : ''} in context.`);
        outgoing = toSend = stripped.messages;
        result = await send(toSend);
      }
      const { content, receiptId, raw } = result;
      // Egress disclosure from the gateway: every query the model sent out of
      // the enclave to the search service, verbatim ({query} or {raw}).
      const webSearches = webSearch && Array.isArray(raw?.web_searches)
        ? raw.web_searches.map((s) => s?.query ?? s?.raw ?? JSON.stringify(s))
        : null;
      // Commit both turns to history only on success (a failed turn is dropped
      // so it doesn't poison later context). `outgoing` — not `full` — so
      // images trimmed out of context stay out instead of being re-trimmed
      // (and re-announced) on every later turn.
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
      if (image) setAttachment(image);   // a failed turn is dropped; give the image back
      // 413 with an image in THIS turn: older images (if any) were already
      // dropped, so the picture itself is what does not fit — say that
      // instead of the generic "start a New chat".
      const tooLargeWithImage = image && err instanceof AciError && err.status === 413;
      const why = tooLargeWithImage
        ? 'The request is too large with this image even after older images were dropped — it is back in the attach box; try it in a New chat or attach a smaller one (the credit was refunded).'
        : explain(err);
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: 'ai', text: `⚠ ${why}`, error: true };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }, [prompt, attachment, model, canAttach, webSearch, sync]);

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

      // On-chain: the SERVER built the transaction (order.onchain.custom_tx)
      // — a public note that pays the EXACT quoted amount and carries the
      // order memo as a NoteAttachment; the user never types a number, and
      // the memo on the note is what identifies the order. This page holds
      // no Miden SDK: it hands the payload to the wallet, which signs and
      // publishes it. One wallet popup, then two waits: the note committing
      // on-chain, and the operator's watcher crediting the ledger.
      if (order.checkoutError || !order.onchain) {
        notify('err', `On-chain quote failed: ${order.checkoutError ?? 'no payment instructions'}`);
        return;
      }
      notify('ok', `Approve the payment in your wallet — sending the exact quoted amount.`);
      setTopupStep('commit');
      // The payload is bound to the account that created the order (a Miden
      // note names its sender; the wallet signs only for its own account):
      // if the wallet's active account changed meanwhile, payTopup throws
      // 'sender_mismatch' BEFORE any money moves and the next click's
      // retryCheckout prepares the order for the current account. If the
      // server sent no payload at all, it throws 'config' — fail closed.
      const paid = await aci.payTopup(order);
      // The money has left the wallet. Record that against the order so
      // a later click resumes the wait above instead of paying again.
      setPendingOrder({ wanted, provider: 'onchain', memo: order.memo,
                        credits: c, paidTx: paid.transactionId });
      setTopupStep('credit');
      notify('ok', `Payment committed on-chain (tx ${short(paid.transactionId)}) — waiting for the credit…`);
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
                {m.image && <img className="thumb" src={m.image} alt="attached image" />}
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
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.input_modalities.includes('image') ? ' 👁' : ''}
                </option>
              ))}
            </select>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickImage} />
            <button
              type="button"
              className={`ghost ${attachment ? 'on' : ''}`}
              onClick={() => fileRef.current?.click()}
              disabled={!inSession || busy || !canAttach}
              title={canAttach
                ? 'Attach an image. It is sent as a data URL and encrypted end-to-end to the enclave — the Edge never sees it, and no third-party host is asked to serve it.'
                : `${model} accepts text only — pick a model marked 👁 to attach an image.`}
            >
              📎 {attachment ? attachment.name.slice(0, 18) : 'Image'}
            </button>
            {attachment && (
              <button type="button" className="ghost tiny" onClick={() => setAttachment(null)} title="Remove image">✕</button>
            )}
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
