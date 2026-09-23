import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTEXT_BUDGET_BYTES, MAX_ENCODED_BYTES, dataUrlBytes, estimateEncryptedBytes, fitWithin,
  prepareImage, stripAllImages, toWire, trimImageContext,
} from '../src/vision.js';

const MB = 1024 * 1024;
// A fake data URL whose payload is `bytes` long (base64 of that many bytes).
const fakeDataUrl = (bytes) => `data:image/jpeg;base64,${'A'.repeat(Math.ceil(bytes * 4 / 3))}`;
const imgTurn = (name, bytes, text = 'look') => ({ role: 'user', content: [
  { type: 'text', text },
  { type: 'image_url', image_url: { url: fakeDataUrl(bytes) }, _name: name },
] });
const reply = (t = 'ok') => ({ role: 'assistant', content: t });

// ── sizing ───────────────────────────────────────────────────────────────

test('fitWithin scales the long side to the cap and never upscales', () => {
  assert.deepEqual(fitWithin(4000, 3000), [1568, 1176]);
  assert.deepEqual(fitWithin(3000, 4000), [1176, 1568]);
  assert.deepEqual(fitWithin(800, 600), [800, 600]);
  assert.deepEqual(fitWithin(1568, 1568), [1568, 1568]);
});

test('dataUrlBytes recovers the payload size from base64', () => {
  assert.equal(dataUrlBytes('data:image/png;base64,' + Buffer.alloc(300).toString('base64')), 300);
  assert.equal(dataUrlBytes('data:image/png;base64,' + Buffer.alloc(299).toString('base64')), 299);
});

test('estimateEncryptedBytes counts hex doubling: a 6 MB image is ~16 MB on the wire', () => {
  const est = estimateEncryptedBytes([imgTurn('a.jpg', 6 * MB)]);
  assert.ok(est > 15.9 * MB && est < 16.2 * MB, `got ${(est / MB).toFixed(2)} MB`);
  // two such images blow the gateway's 32 MiB cap — the reviewer's scenario
  assert.ok(estimateEncryptedBytes([imgTurn('a', 6 * MB), reply(), imgTurn('b', 6 * MB)]) > 32 * MB);
});

// ── the budget ───────────────────────────────────────────────────────────

test('trimImageContext drops the OLDEST images first and always keeps the newest', () => {
  const msgs = [imgTurn('one.jpg', 2.5 * MB), reply(), imgTurn('two.jpg', 2.5 * MB), reply(), imgTurn('three.jpg', 2.5 * MB)];
  // 3 × ~6.7 MB ≈ 20 MB estimated → over the 8 MiB budget; one image fits
  const { messages, dropped } = trimImageContext(msgs);
  assert.deepEqual(dropped, ['one.jpg', 'two.jpg']);
  assert.deepEqual(messages[0].content[1], { type: 'text', text: '[image sent earlier: one.jpg]' });
  assert.deepEqual(messages[2].content[1], { type: 'text', text: '[image sent earlier: two.jpg]' });
  assert.equal(messages[4].content[1].type, 'image_url', 'the newest image survives');
  assert.ok(estimateEncryptedBytes(messages) <= CONTEXT_BUDGET_BYTES);
  // the input is untouched (pure)
  assert.equal(msgs[0].content[1].type, 'image_url');
});

test('trimImageContext keeps the newest image even when it alone exceeds the budget', () => {
  const { messages, dropped } = trimImageContext([imgTurn('only.jpg', 6 * MB)], { budgetBytes: 1 * MB });
  assert.deepEqual(dropped, []);
  assert.equal(messages[0].content[1].type, 'image_url');
});

test('trimImageContext leaves a text-only or under-budget conversation alone', () => {
  const text = [{ role: 'user', content: 'hi' }, reply(), imgTurn('small.png', 200 * 1024)];
  const { messages, dropped } = trimImageContext(text);
  assert.deepEqual(dropped, []);
  assert.deepEqual(messages, text);
});

test('trimImageContext is idempotent on its own output (dropped images stay dropped)', () => {
  const first = trimImageContext([imgTurn('a', 3 * MB), reply(), imgTurn('b', 3 * MB), reply(), imgTurn('c', 3 * MB)]);
  const second = trimImageContext(first.messages);
  assert.deepEqual(second.dropped, []);
  assert.deepEqual(second.messages, first.messages);
});

test('stripAllImages replaces every image, newest included, preserving positions and roles', () => {
  const { messages, dropped } = stripAllImages([imgTurn('a', MB), reply('r'), imgTurn('b', MB)]);
  assert.deepEqual(dropped, ['a', 'b']);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].content, 'r');
  for (const i of [0, 2]) {
    assert.equal(messages[i].role, 'user');
    assert.equal(messages[i].content[0].type, 'text');       // the prompt part is still first
    assert.match(messages[i].content[1].text, /^\[image sent earlier: /);
  }
});

test('toWire strips app-only underscore fields at every level and nothing else', () => {
  const wire = toWire([imgTurn('a.jpg', 10), { role: 'assistant', content: 'x', _seen: true }]);
  assert.equal(wire[0].content[1]._name, undefined);
  assert.equal(wire[0].content[1].type, 'image_url');
  assert.ok(wire[0].content[1].image_url.url.startsWith('data:image/jpeg'));
  assert.equal(wire[1]._seen, undefined);
  assert.equal(wire[1].content, 'x');
});

// ── prepareImage with a fake browser ─────────────────────────────────────

function fakeEnv({ width, height, encodedBytes }) {
  const calls = { encode: [], read: 0 };
  return {
    calls,
    async decode() { return { width, height, source: 'bmp', close() {} }; },
    encode(_src, w, h, mime, q) { calls.encode.push({ w, h, mime, q }); return fakeDataUrl(encodedBytes); },
    async readDataUrl() { calls.read++; return fakeDataUrl(4096); },
  };
}
const file = (name, size, type = 'image/jpeg') => ({ name, size, type });

test('a small image is sent as-is (no re-encode, PNG alpha survives)', async () => {
  const env = fakeEnv({ width: 800, height: 600, encodedBytes: 0 });
  const out = await prepareImage(file('icon.png', 300 * 1024, 'image/png'), {}, env);
  assert.equal(out.resized, false);
  assert.equal(env.calls.read, 1);
  assert.deepEqual(env.calls.encode, []);
  assert.deepEqual([out.width, out.height], [800, 600]);
});

test('a big photo is resized to the cap and exported as JPEG 0.85', async () => {
  const env = fakeEnv({ width: 4000, height: 3000, encodedBytes: 450 * 1024 });
  const out = await prepareImage(file('photo.jpg', 5.8 * MB), {}, env);
  assert.equal(out.resized, true);
  assert.deepEqual(env.calls.encode, [{ w: 1568, h: 1176, mime: 'image/jpeg', q: 0.85 }]);
  assert.deepEqual([out.width, out.height], [1568, 1176]);
  assert.ok(out.bytes < 500 * 1024);
  assert.equal(out.originalBytes, 5.8 * MB);
});

test('a small file that is nonetheless huge in pixels is still resized', async () => {
  const env = fakeEnv({ width: 6000, height: 200, encodedBytes: 100 * 1024 });
  const out = await prepareImage(file('pano.png', 500 * 1024, 'image/png'), {}, env);
  assert.equal(out.resized, true);
  assert.equal(env.calls.encode[0].w, 1568);
});

test('an image still over the encoded cap after resizing is refused with a reason', async () => {
  const env = fakeEnv({ width: 4000, height: 4000, encodedBytes: MAX_ENCODED_BYTES + 1 });
  await assert.rejects(prepareImage(file('weird.jpg', 3 * MB), {}, env), /still .* after resizing/);
});
