// Custom transaction: embed the intent memo in the note itself.
//
// The wallet's plain requestSend() cannot carry a NoteAttachment (its payload
// is fixed to 6 fields) — and the memo IS the payment's identity: amounts are
// plain prices that collide across same-price orders, so a memo-less note
// cannot be auto-credited at all. requestTransaction({type: 'Custom'})
// accepts a fully serialized TransactionRequest instead — the dApp bundles
// @miden-sdk/miden-sdk, builds the P2ID note itself (exact quoted amount +
// memo as a NoteAttachment), and hands the wallet only the signing+proving.
// The watcher reads the memo straight off the note; the exact amount is a
// second server-enforced check.
//
// Wire encoding (MUST stay in lockstep with note-watcher/src/core.mjs —
// encodeMemoAttachment/decodeMemoAttachment are the reference codec):
//   scheme  = 0x4C565431 ("LVT1", Leviathan Topup v1)
//   kind    = Array of Felts
//   felt[0] = memo byte length n (1..=64)
//   felt[i] = big-endian integer of memo bytes [7(i-1), min(7i, n)) — 7 bytes
//             per felt keeps every value < 2^56, far under the field modulus,
//             and the length prefix restores leading-zero bytes on decode.
//
// The SDK is imported LAZILY and only here: its multi-threaded WASM needs
// SharedArrayBuffer, i.e. a cross-origin-isolated page (COOP+COEP headers —
// see vite.config.js / public/serve.json). When the import or init fails the
// caller falls back to plain requestSend(): the payment still works and still
// matches, only the memo stays off the note.

export const TOPUP_ATTACHMENT_SCHEME = 0x4c565431; // "LVT1"

/** memo string → array of bigint felt values (length prefix + 7-byte chunks). */
export function encodeMemoToFelts(memo) {
  const bytes = new TextEncoder().encode(memo);
  if (bytes.length < 1 || bytes.length > 64) {
    throw new Error(`memo must encode to 1..64 bytes, got ${bytes.length}`);
  }
  const felts = [BigInt(bytes.length)];
  for (let off = 0; off < bytes.length; off += 7) {
    let v = 0n;
    for (const b of bytes.subarray(off, off + 7)) v = (v << 8n) | BigInt(b);
    felts.push(v);
  }
  return felts;
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Build the requestTransaction({type:'Custom'}) payload for an on-chain
 * top-up: a serialized one-output-note TransactionRequest whose P2ID note
 * pays the gateway the EXACT quoted amount and carries the intent memo as a
 * NoteAttachment. Mirrors the SDK's own transactions.send(returnNote) recipe
 * (Note.createP2IDNote + withOwnOutputNotes), with the attachment built at
 * the WASM level: the high-level createP2IDNote({attachment}) option is
 * silently dropped by SDK 0.15.0-node.* (its wrapper calls
 * `new NoteAttachment(felts)` — a zero-arg constructor that ignores felts).
 *
 * @param {object} args
 * @param {string} args.senderAddress  bech32 address of the paying account
 * @param {object} args.onchain       the intent's `onchain` payment block
 *                                    (pay_to_address, faucet_id, token_amount, memo)
 * @returns {Promise<{address, recipientAddress, transactionRequest}>}
 */
export async function buildTopupCustomTx({ senderAddress, onchain }) {
  const { memo, pay_to_address, faucet_id, token_amount } = onchain ?? {};
  if (!memo || !pay_to_address || !faucet_id || !token_amount) {
    throw new Error('onchain payment block is incomplete');
  }
  // Dynamic import: nothing outside this call ever loads the WASM.
  const { getWasmOrThrow } = await import('@miden-sdk/miden-sdk');
  const wasm = await getWasmOrThrow();

  const sender = wasm.AccountId.fromBech32(senderAddress);
  const target = wasm.AccountId.fromBech32(pay_to_address);
  const faucet = wasm.AccountId.fromBech32(faucet_id);

  const attachment = wasm.NoteAttachment.newArray(
    new wasm.NoteAttachmentScheme(TOPUP_ATTACHMENT_SCHEME),
    new wasm.FeltArray(encodeMemoToFelts(memo).map((v) => new wasm.Felt(v))),
  );
  // Public on purpose: the watcher can only observe public notes.
  const note = wasm.Note.createP2IDNote(
    sender,
    target,
    new wasm.NoteAssets([new wasm.FungibleAsset(faucet, BigInt(token_amount))]),
    wasm.NoteType.Public,
    attachment,
  );
  const request = new wasm.TransactionRequestBuilder()
    .withOwnOutputNotes(new wasm.OutputNoteArray([wasm.OutputNote.full(note)]))
    .build();

  return {
    // `address` is the executor the wallet validates the payload on;
    // `recipientAddress` only feeds the confirmation-popup preview.
    address: senderAddress,
    recipientAddress: pay_to_address,
    transactionRequest: toBase64(request.serialize()),
  };
}
