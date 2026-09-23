import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTEXT_BUDGET_BYTES, MAX_ENCODED_BYTES, MAX_PIXELS, MAX_SIDE_PX, dataUrlBytes, estimateEncryptedBytes,
  fitWithin, imageLabel, imageTurnContent, nextImageNumber, prepareImage, stripAllImages, toWire, trimImageContext,
} from '../src/vision.js';

const MB = 1024 * 1024;
// A fake data URL whose payload is `bytes` long (base64 of that many bytes).
const fakeDataUrl = (bytes, mime = 'image/jpeg') => `data:${mime};base64,${'A'.repeat(Math.ceil(bytes * 4 / 3))}`;
// A user turn exactly as App.jsx builds it: label → image → question.
const imgTurn = (n, name, bytes, text = 'look') => ({
  role: 'user', content: imageTurnContent({ n, name, dataUrl: fakeDataUrl(bytes), text }),
});
const reply = (t = 'ok') => ({ role: 'assistant', content: t });

// ── sizing ───────────────────────────────────────────────────────────────

test('fitWithin honours BOTH caps — long side and megapixels — keeping the ratio, never upscaling', () => {
  // 4:3 photo: the long-side cap alone would give 1568×1176 = 1.84 MP; the
  // megapixel cap wins and lands just under 1.2 MP.
  const [w, h] = fitWithin(4000, 3000);
  assert.ok(w * h <= MAX_PIXELS && w * h > 0.99 * MAX_PIXELS, `${w}×${h} = ${w * h}`);
  assert.ok(Math.abs(w / h - 4 / 3) < 0.005, 'ratio kept');
  assert.deepEqual(fitWithin(3000, 4000), [h, w]);
  // A square hits the megapixel cap before the side cap.
  const [s1, s2] = fitWithin(1568, 1568);
  assert.equal(s1, s2);
  assert.ok(s1 * s1 <= MAX_PIXELS && s1 < MAX_SIDE_PX);
  // A panorama hits the side cap only (few pixels).
  assert.deepEqual(fitWithin(6000, 200), [1568, 52]);
  // Already inside both caps: untouched.
  assert.deepEqual(fitWithin(800, 600), [800, 600]);
  assert.deepEqual(fitWithin(1568, 700), [1568, 700]);
});

test('dataUrlBytes recovers the payload size from base64', () => {
  assert.equal(dataUrlBytes('data:image/png;base64,' + Buffer.alloc(300).toString('base64')), 300);
  assert.equal(dataUrlBytes('data:image/png;base64,' + Buffer.alloc(299).toString('base64')), 299);
});

test('estimateEncryptedBytes counts hex doubling: a 6 MB image is ~16 MB on the wire', () => {
  const est = estimateEncryptedBytes([imgTurn(1, 'a.jpg', 6 * MB)]);
  assert.ok(est > 15.9 * MB && est < 16.2 * MB, `got ${(est / MB).toFixed(2)} MB`);
  // two such images blow the gateway's 32 MiB cap — the reviewer's scenario
  assert.ok(estimateEncryptedBytes([imgTurn(1, 'a', 6 * MB), reply(), imgTurn(2, 'b', 6 * MB)]) > 32 * MB);
});

// ── labels ───────────────────────────────────────────────────────────────

test('imageTurnContent puts a numbered label before the image and the question after it', () => {
  const c = imageTurnContent({ n: 3, name: 'receipt.png', dataUrl: 'data:image/png;base64,AAAA', text: 'total?' });
  assert.deepEqual(c.map((p) => p.type), ['text', 'image_url', 'text']);
  assert.equal(c[0].text, 'Image 3 (receipt.png):');
  assert.equal(c[1]._n, 3);
  assert.equal(c[1]._name, 'receipt.png');
  assert.equal(c[2].text, 'total?');
  assert.equal(imageTurnContent({ n: 1, name: 'x', dataUrl: 'd' })[2].text, 'Describe this image.');
  assert.equal(imageLabel(2, 'b.jpg'), 'Image 2 (b.jpg)');
});

test('nextImageNumber keeps counting across images already trimmed to placeholders', () => {
  assert.equal(nextImageNumber([]), 1);
  assert.equal(nextImageNumber([{ role: 'user', content: 'hi' }, reply()]), 1);
  const two = [imgTurn(1, 'a', 3 * MB), reply(), imgTurn(2, 'b', 3 * MB)];
  assert.equal(nextImageNumber(two), 3);
  const { messages } = trimImageContext(two, { budgetBytes: 7 * MB });   // drops image 1
  assert.equal(nextImageNumber(messages), 3, 'a retired image keeps its number');
});

// ── the budget ───────────────────────────────────────────────────────────

test('trimImageContext drops the OLDEST images first and always keeps the newest', () => {
  const msgs = [imgTurn(1, 'one.jpg', 2.5 * MB), reply(), imgTurn(2, 'two.jpg', 2.5 * MB), reply(), imgTurn(3, 'three.jpg', 2.5 * MB)];
  // 3 × ~6.7 MB ≈ 20 MB estimated → over the 8 MiB budget; one image fits
  const { messages, dropped } = trimImageContext(msgs);
  assert.deepEqual(dropped, ['Image 1 (one.jpg)', 'Image 2 (two.jpg)']);
  // the label part is gone and the image part became a same-named placeholder; the question stays
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: '[Image 1 (one.jpg) sent earlier]', _placeholderFor: 1 },
    { type: 'text', text: 'look' },
  ]);
  assert.equal(messages[2].content[0].text, '[Image 2 (two.jpg) sent earlier]');
  assert.equal(messages[4].content[1].type, 'image_url', 'the newest image survives');
  assert.equal(messages[4].content[0].text, 'Image 3 (three.jpg):', 'its label survives with it');
  assert.ok(estimateEncryptedBytes(messages) <= CONTEXT_BUDGET_BYTES);
  // the input is untouched (pure)
  assert.equal(msgs[0].content[1].type, 'image_url');
  assert.equal(msgs[0].content.length, 3);
});

test('trimImageContext keeps the newest image even when it alone exceeds the budget', () => {
  const { messages, dropped } = trimImageContext([imgTurn(1, 'only.jpg', 6 * MB)], { budgetBytes: 1 * MB });
  assert.deepEqual(dropped, []);
  assert.equal(messages[0].content[1].type, 'image_url');
});

test('trimImageContext leaves a text-only or under-budget conversation alone', () => {
  const text = [{ role: 'user', content: 'hi' }, reply(), imgTurn(1, 'small.png', 200 * 1024)];
  const { messages, dropped } = trimImageContext(text);
  assert.deepEqual(dropped, []);
  assert.deepEqual(messages, text);
});

test('trimImageContext is idempotent on its own output (dropped images stay dropped)', () => {
  const first = trimImageContext([imgTurn(1, 'a', 3 * MB), reply(), imgTurn(2, 'b', 3 * MB), reply(), imgTurn(3, 'c', 3 * MB)]);
  const second = trimImageContext(first.messages);
  assert.deepEqual(second.dropped, []);
  assert.deepEqual(second.messages, first.messages);
});

test('trimImageContext still handles an unlabelled image part (no _n)', () => {
  const legacy = { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image_url', image_url: { url: fakeDataUrl(3 * MB) }, _name: 'old.jpg' }] };
  const { messages, dropped } = trimImageContext([legacy, reply(), imgTurn(1, 'new.jpg', 3 * MB)], { budgetBytes: 7 * MB });
  assert.deepEqual(dropped, ['image old.jpg']);
  assert.deepEqual(messages[0].content[1], { type: 'text', text: '[image old.jpg sent earlier]' });
});

test('stripAllImages replaces every image, newest included, preserving positions and roles', () => {
  const { messages, dropped } = stripAllImages([imgTurn(1, 'a', MB), reply('r'), imgTurn(2, 'b', MB)]);
  assert.deepEqual(dropped, ['Image 1 (a)', 'Image 2 (b)']);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].content, 'r');
  for (const [i, n] of [[0, 1], [2, 2]]) {
    assert.equal(messages[i].role, 'user');
    assert.deepEqual(messages[i].content.map((p) => p.type), ['text', 'text']);
    assert.equal(messages[i].content[0]._placeholderFor, n);
    assert.equal(messages[i].content[1].text, 'look');        // the question part is still there
  }
});

test('toWire strips app-only underscore fields at every level and nothing else', () => {
  const wire = toWire([imgTurn(1, 'a.jpg', 10), { role: 'assistant', content: 'x', _seen: true }]);
  assert.deepEqual(wire[0].content[0], { type: 'text', text: 'Image 1 (a.jpg):' });
  assert.equal(wire[0].content[1]._name, undefined);
  assert.equal(wire[0].content[1]._n, undefined);
  assert.equal(wire[0].content[1].type, 'image_url');
  assert.ok(wire[0].content[1].image_url.url.startsWith('data:image/jpeg'));
  assert.equal(wire[1]._seen, undefined);
  assert.equal(wire[1].content, 'x');
});

// ── prepareImage with a fake browser ─────────────────────────────────────

// `encodedBytes`: a number (any mime) or { 'image/png': n, 'image/jpeg': m }.
function fakeEnv({ width, height, encodedBytes }) {
  const calls = { encode: [], read: 0 };
  const sizeFor = (mime) => (typeof encodedBytes === 'number' ? encodedBytes : encodedBytes[mime]);
  return {
    calls,
    async decode() { return { width, height, source: 'bmp', close() {} }; },
    encode(_src, w, h, mime, q) { calls.encode.push({ w, h, mime, q }); return fakeDataUrl(sizeFor(mime), mime); },
    async readDataUrl() { calls.read++; return fakeDataUrl(4096); },
  };
}
const file = (name, size, type = 'image/jpeg') => ({ name, size, type });

test('a small image is sent as-is (no re-encode, PNG alpha survives)', async () => {
  const env = fakeEnv({ width: 800, height: 600, encodedBytes: 0 });
  const out = await prepareImage(file('icon.png', 300 * 1024, 'image/png'), {}, env);
  assert.equal(out.resized, false);
  assert.equal(out.mime, 'image/png');
  assert.equal(env.calls.read, 1);
  assert.deepEqual(env.calls.encode, []);
  assert.deepEqual([out.width, out.height], [800, 600]);
});

test('a big photo is resized under both caps and exported as JPEG 0.85', async () => {
  const env = fakeEnv({ width: 4000, height: 3000, encodedBytes: 450 * 1024 });
  const out = await prepareImage(file('photo.jpg', 5.8 * MB), {}, env);
  assert.equal(out.resized, true);
  assert.equal(out.mime, 'image/jpeg');
  assert.equal(env.calls.encode.length, 1, 'a lossy source goes straight to JPEG');
  const [w, h] = fitWithin(4000, 3000);
  assert.deepEqual(env.calls.encode, [{ w, h, mime: 'image/jpeg', q: 0.85 }]);
  assert.ok(w * h <= MAX_PIXELS);
  assert.deepEqual([out.width, out.height], [w, h]);
  assert.ok(out.bytes < 500 * 1024);
  assert.equal(out.originalBytes, 5.8 * MB);
});

test('a resized PNG stays PNG when it fits the encoded cap (text stays legible)', async () => {
  const env = fakeEnv({ width: 2560, height: 1440, encodedBytes: { 'image/png': 900 * 1024, 'image/jpeg': 200 * 1024 } });
  const out = await prepareImage(file('screenshot.png', 3 * MB, 'image/png'), {}, env);
  assert.equal(out.resized, true);
  assert.equal(out.mime, 'image/png');
  assert.equal(env.calls.encode.length, 1, 'no JPEG attempt when PNG fits');
  assert.equal(env.calls.encode[0].mime, 'image/png');
  assert.equal(env.calls.encode[0].q, undefined, 'PNG takes no quality');
  assert.ok(env.calls.encode[0].w * env.calls.encode[0].h <= MAX_PIXELS);
  assert.equal(out.bytes, 900 * 1024);
});

test('a resized PNG falls back to JPEG only when PNG is still over the encoded cap', async () => {
  const env = fakeEnv({ width: 4000, height: 3000, encodedBytes: { 'image/png': MAX_ENCODED_BYTES + 1, 'image/jpeg': 400 * 1024 } });
  const out = await prepareImage(file('poster.png', 5 * MB, 'image/png'), {}, env);
  assert.deepEqual(env.calls.encode.map((c) => c.mime), ['image/png', 'image/jpeg']);
  assert.equal(out.mime, 'image/jpeg');
  assert.equal(out.bytes, 400 * 1024);
});

test('a PNG already inside the pixel caps is sent as-is up to the encoded cap, else re-encoded as JPEG', async () => {
  // 1.5 MB PNG at 1000×800: above the 1 MB lossy keep-cap, but PNG is kept as-is up to 2 MB
  const kept = fakeEnv({ width: 1000, height: 800, encodedBytes: 0 });
  const a = await prepareImage(file('diagram.png', 1.5 * MB, 'image/png'), {}, kept);
  assert.equal(a.resized, false);
  assert.deepEqual(kept.calls.encode, []);
  // 3 MB PNG at the same size: a same-size PNG re-encode can't shrink it → straight to JPEG
  const big = fakeEnv({ width: 1000, height: 800, encodedBytes: 300 * 1024 });
  const b = await prepareImage(file('diagram.png', 3 * MB, 'image/png'), {}, big);
  assert.equal(b.resized, true);
  assert.deepEqual(big.calls.encode.map((c) => c.mime), ['image/jpeg']);
  assert.equal(b.mime, 'image/jpeg');
});

test('a small file that is nonetheless huge in pixels is still resized', async () => {
  const env = fakeEnv({ width: 6000, height: 200, encodedBytes: 100 * 1024 });
  const out = await prepareImage(file('pano.png', 500 * 1024, 'image/png'), {}, env);
  assert.equal(out.resized, true);
  assert.equal(env.calls.encode[0].w, 1568);
  assert.equal(out.mime, 'image/png');
});

test('an image still over the encoded cap after resizing is refused with a reason', async () => {
  const env = fakeEnv({ width: 4000, height: 4000, encodedBytes: MAX_ENCODED_BYTES + 1 });
  await assert.rejects(prepareImage(file('weird.jpg', 3 * MB), {}, env), /still .* after resizing/);
});
