import React, { useState, useCallback, useRef } from 'react';
import { aci, AciError, MAX_SPEND } from './aci';

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
      const { content, receiptId } = await aci.chat({ model, messages: outgoing });
      // Commit both turns to history only on success (a failed turn is dropped
      // so it doesn't poison later context).
      historyRef.current = [...outgoing, { role: 'assistant', content: content ?? '' }];
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: 'ai', text: content ?? '(empty response)', receiptId };
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
  }, [prompt, model, sync]);

  const onRefresh = useCallback(async () => {
    try { await aci.refreshBalance(); sync(); notify('ok', 'Balance refreshed'); }
    catch (e) { notify('err', explain(e)); }
  }, [notify, sync]);

  const onTopup = useCallback(async () => {
    const c = parseInt(credits, 10);
    if (!Number.isInteger(c) || c <= 0) return notify('err', 'Enter a positive credit amount');
    try {
      const { invoiceUrl, checkoutError } = await aci.createTopup({ credits: c });
      if (checkoutError) notify('warn', `Intent created but checkout link failed: ${checkoutError}`);
      else if (invoiceUrl) { window.open(invoiceUrl, '_blank'); notify('ok', 'Checkout opened — pay, then Refresh.'); }
      else notify('warn', 'No checkout URL returned.');
    } catch (e) { notify('err', explain(e)); }
  }, [credits, notify]);

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
            <h3>Top up (NOWPayments)</h3>
            <div className="card">
              <div className="row">
                <input type="number" min="1" value={credits} onChange={(e) => setCredits(e.target.value)} style={{ width: 90 }} />
                <button onClick={onTopup} disabled={!inSession}>Buy credits</button>
              </div>
              <div className="hint">Opens a hosted checkout in a new tab. Balance updates after payment — hit Refresh.</div>
            </div>
          </div>

          <div>
            <h3>Edge</h3>
            <div className="card hint">
              serviceOrigin: <span className="mono">{aci.serviceOrigin}</span><br />
              (set via VITE_EDGE_ORIGIN — must equal the Edge's WALLET_SERVICE_ORIGIN)
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
