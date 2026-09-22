// Offline proof that the SDK's browser-side E2EE (Web Crypto + @noble x25519)
// speaks the same ACI §7 v2 dialect the gateway does — the gateway's side is
// reproduced here with node:crypto, byte-exact to the reference client that
// already passed against production (example_e2ee_vision.mjs).
//
// Drives the REAL `chat()` with a fake wallet session and a fake Edge:
//   1. the fake Edge must see NO plaintext — not the prompt, not the image;
//   2. decrypting each part with the field-path AAD yields the originals;
//   3. the reply, encrypted to the client's per-request key, is decrypted;
//   4. an Edge that fails to confirm decryption makes chat() refuse.
//
// Run: npm test   (node --test)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

import { LeviathanACI, AciError, jcs } from '../src/leviathan-aci.js';

// ── gateway-side primitives (node:crypto), same as example_e2ee_vision.mjs ──
const SUITE = 'x25519-aes-256-gcm-hkdf-sha256';
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const rawPub = (k) => k.export({ type: 'spki', format: 'der' }).subarray(-32);
const keyFromRaw = (raw) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
const kdf = (shared) => Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), 'aci.e2ee.v2.x25519', 32));

function gwOpen(servicePriv, blobHex, aad) {
  const b = Buffer.from(blobHex, 'hex');
  const key = kdf(diffieHellman({ privateKey: servicePriv, publicKey: keyFromRaw(b.subarray(0, 32)) }));
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(32, 44));
  d.setAAD(aad); d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(44, b.length - 16)), d.final()]).toString('utf8');
}
function gwSeal(clientPubHex, plaintext, aad) {
  const eph = generateKeyPairSync('x25519');
  const key = kdf(diffieHellman({ privateKey: eph.privateKey, publicKey: keyFromRaw(Buffer.from(clientPubHex, 'hex')) }));
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce); c.setAAD(aad);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([rawPub(eph.publicKey), nonce, ct, c.getAuthTag()]).toString('hex');
}
const aadOf = (o) => Buffer.from(jcs(o));

const PROMPT = 'What is in this picture? Be brief.';
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const REPLY = 'A single red pixel.';
const REASONING = 'The image is one red pixel; answer briefly.';

/** A fake Edge+gateway: records what it saw, decrypts, answers encrypted. */
function makeFakeEdge({ applied = true } = {}) {
  const service = generateKeyPairSync('x25519');
  const seen = { rawBody: null, decrypted: [], headers: null };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/v1/attestation/report') {
      return Response.json({ attestation: { workload_keyset: { e2ee_public_keys: [
        { key_id: 'k1', algo: SUITE, public_key: rawPub(service.publicKey).toString('hex') }] } } });
    }
    if (u.pathname === '/v1/chat/completions') {
      seen.rawBody = init.body; seen.headers = init.headers;
      const body = JSON.parse(init.body);
      const { model } = body; const nonce = init.headers['x-e2ee-nonce']; const ts = Number(init.headers['x-e2ee-timestamp']);
      const reqAad = (field) => aadOf({ purpose: 'aci.e2ee.request.v2', algo: SUITE, model, field, nonce, ts });
      body.messages.forEach((m, mi) => {
        if (typeof m.content === 'string') {
          seen.decrypted.push({ field: `messages.${mi}.content`, text: gwOpen(service.privateKey, m.content, reqAad(`messages.${mi}.content`)) });
        } else if (Array.isArray(m.content)) {
          m.content.forEach((p, ci) => {
            if (p.type === 'text') seen.decrypted.push({ field: `messages.${mi}.content.${ci}.text`, text: gwOpen(service.privateKey, p.text, reqAad(`messages.${mi}.content.${ci}.text`)) });
            if (p.type === 'image_url') seen.decrypted.push({ field: `messages.${mi}.content.${ci}.image_url.url`, text: gwOpen(service.privateKey, p.image_url.url, reqAad(`messages.${mi}.content.${ci}.image_url.url`)) });
          });
        }
      });
      const id = 'chatcmpl-test-1';
      const respAad = (field) => aadOf({ purpose: 'aci.e2ee.response.v2', algo: SUITE, model, id, field, nonce, ts });
      const clientPub = init.headers['x-client-pub-key'];
      const payload = { id, model, choices: [{ index: 0, message: {
        role: 'assistant',
        content: gwSeal(clientPub, REPLY, respAad('choices.0.message.content')),
        reasoning_content: gwSeal(clientPub, REASONING, respAad('choices.0.message.reasoning_content')),
      } }] };
      const headers = { 'content-type': 'application/json', 'x-receipt-id': 'rcpt-test' };
      if (applied) headers['x-e2ee-applied'] = 'true';
      return new Response(JSON.stringify(payload), { status: 200, headers });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetch, seen };
}

function sdkWithSession(fetch) {
  const aci = new LeviathanACI({ serviceOrigin: 'https://edge.test', wallet: {}, fetch });
  aci._account = { address: 'mtst1test', publicKeyHex: '00' };
  aci._keys = aci._generateSessionKeys();
  aci._session = { session_id: 'lev_s_test' };
  return aci;
}

test('chat() encrypts text AND image parts per field path; the Edge sees no plaintext; reply is decrypted', async () => {
  const edge = makeFakeEdge();
  const aci = sdkWithSession(edge.fetch);
  const out = await aci.chat({ model: 'glm-5.3-flash', messages: [
    { role: 'user', content: 'earlier turn' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: [
      { type: 'text', text: PROMPT },
      { type: 'image_url', image_url: { url: IMAGE, detail: 'low' } },
    ] },
  ] });

  // 1. nothing readable reached the Edge
  for (const marker of [PROMPT, 'earlier turn', 'earlier answer', 'data:image', 'iVBORw0KGgo']) {
    assert.ok(!edge.seen.rawBody.includes(marker), `plaintext leaked: ${marker}`);
  }
  assert.equal(edge.seen.headers['x-e2ee-version'], '2');
  assert.match(edge.seen.headers['x-client-pub-key'], /^[0-9a-f]{64}$/);
  assert.match(edge.seen.headers['x-e2ee-nonce'], /^[0-9a-f]{64}$/);

  // 2. the enclave side recovers every field at its own path
  const byField = Object.fromEntries(edge.seen.decrypted.map((d) => [d.field, d.text]));
  assert.equal(byField['messages.0.content'], 'earlier turn');
  assert.equal(byField['messages.1.content'], 'earlier answer');
  assert.equal(byField['messages.2.content.0.text'], PROMPT);
  assert.equal(byField['messages.2.content.1.image_url.url'], IMAGE);
  // non-content part fields travel in the clear, unchanged
  assert.ok(edge.seen.rawBody.includes('"detail":"low"'));

  // 3. the reply came back only to us
  assert.equal(out.e2ee, true);
  assert.equal(out.content, REPLY);
  assert.equal(out.reasoningContent, REASONING);
  assert.equal(out.receiptId, 'rcpt-test');
  assert.equal(out.raw.choices[0].message.content, REPLY, 'raw is decrypted in place');
});

test('a part type the gateway cannot decrypt in place falls back to whole-content encryption', async () => {
  const edge = makeFakeEdge();
  const aci = sdkWithSession(edge.fetch);
  const content = [{ type: 'text', text: 'hi' }, { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }];
  await aci.chat({ model: 'm', messages: [{ role: 'user', content }] });
  const whole = edge.seen.decrypted.find((d) => d.field === 'messages.0.content');
  assert.ok(whole, 'whole-content ciphertext at messages.0.content');
  assert.deepEqual(JSON.parse(whole.text), content);
  assert.ok(!edge.seen.rawBody.includes('"hi"'));
});

test('chat() refuses a reply the gateway did not confirm as decrypted', async () => {
  const edge = makeFakeEdge({ applied: false });
  const aci = sdkWithSession(edge.fetch);
  await assert.rejects(
    aci.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    (e) => e instanceof AciError && e.type === 'e2ee_not_applied');
});

test('e2ee:false sends plaintext and skips the confirmation check (debug path)', async () => {
  let saw = null;
  const fetch = async (url, init = {}) => {
    saw = init.body;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'plain' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const aci = sdkWithSession(fetch);
  const out = await aci.chat({ model: 'm', messages: [{ role: 'user', content: 'hello' }], e2ee: false });
  assert.ok(saw.includes('"hello"'));
  assert.equal(out.content, 'plain');
  assert.equal(out.e2ee, false);
});

test('the service key is fetched once and cached across calls', async () => {
  let reports = 0;
  const edge = makeFakeEdge();
  const counting = async (url, init) => { if (String(url).includes('/v1/attestation/report')) reports++; return edge.fetch(url, init); };
  const aci = sdkWithSession(counting);
  await aci.chat({ model: 'm', messages: [{ role: 'user', content: 'a' }] });
  await aci.chat({ model: 'm', messages: [{ role: 'user', content: 'b' }] });
  assert.equal(reports, 1);
});
