// Image handling for vision turns — the parts that decide, kept free of React
// and (where possible) of the browser so `npm test` can pin them.
//
// Two facts drive everything here:
//   * E2EE writes every encrypted field as HEX, so a data URL costs 2× its
//     length on the wire (a 6 MB photo → 8 MB base64 → 16 MB hex). The
//     gateway caps a request body at 32 MiB.
//   * Every turn resends the whole conversation, so an image in history is
//     paid for again on every later message — forever, unless trimmed.
//
// Hence: shrink before encrypting (to what the models actually look at), and
// keep images in context only within a byte budget, oldest out first, the
// latest always kept so follow-up questions about it still work.
//
// The industry-standard fix for the second fact is a server-side file store
// (upload once, resend a `file_id`). This gateway is a stateless E2EE relay —
// the picture may exist in clear only inside the enclave while a request is
// being served — so there is nothing to reference and the client must resend.
// Trimming old images out of the resent history is the stateless equivalent
// of "don't resend files" in other chat UIs.

// Resize caps: BOTH must hold. The long-side cap is what vision APIs document;
// the megapixel cap is what they actually keep — Anthropic's standard tier is
// 1568 px on the long edge AND ~1.15 MP (1568 image tokens), Qwen3-VL's
// recommended max_pixels is ~1.3 MP. A 1568×1176 photo (1.84 MP) would be
// downscaled again server-side; fitting both caps up front saves ~30% of the
// image tokens and the bytes we encrypt and resend.
export const MAX_SIDE_PX = 1568;          // longest side after resize
export const MAX_PIXELS = 1_200_000;      // width × height after resize
export const JPEG_QUALITY = 0.85;
export const MAX_SOURCE_BYTES = 6 * 1024 * 1024;   // what we accept from the picker (camera photos)
export const MAX_ENCODED_BYTES = 2 * 1024 * 1024;  // what we accept AFTER resizing — more is abnormal
export const KEEP_ORIGINAL_MAX_BYTES = 1024 * 1024; // lossy source small enough: send as-is
export const CONTEXT_BUDGET_BYTES = 8 * 1024 * 1024; // estimated ENCRYPTED size of all images in context

// Lossless sources (screenshots, diagrams, UI captures — anything with text)
// stay lossless after the resize as long as they fit MAX_ENCODED_BYTES: JPEG
// artefacts are exactly what makes small text unreadable to a vision model.
// Only PNG: it is the one lossless type a canvas can export.
const LOSSLESS_TYPES = new Set(['image/png']);

/** Fit (w, h) under BOTH caps — long side ≤ maxSide and area ≤ maxPixels — keeping the ratio, never upscaling. */
export function fitWithin(width, height, maxSide = MAX_SIDE_PX, maxPixels = MAX_PIXELS) {
  let k = 1;
  const longest = Math.max(width, height);
  if (longest > maxSide) k = maxSide / longest;
  const area = width * height * k * k;
  if (area > maxPixels) k *= Math.sqrt(maxPixels / area);
  if (k >= 1) return [width, height];
  let w = Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
  if (w * h > maxPixels || Math.max(w, h) > maxSide) {   // rounding pushed it over: round down instead
    w = Math.max(1, Math.floor(width * k)); h = Math.max(1, Math.floor(height * k));
  }
  return [w, h];
}

/** Decoded byte size of a data: URL's payload (base64 → bytes). */
export function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor(b64.length * 3 / 4) - padding;
}

/** Browser implementation of the two things resizing needs. Injectable for tests. */
export const browserImageEnv = {
  async decode(file) {
    const bmp = await createImageBitmap(file);
    return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close?.() };
  },
  encode(source, width, height, mime, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); } // alpha → white, not black
    ctx.drawImage(source, 0, 0, width, height);
    return canvas.toDataURL(mime, quality);
  },
  readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('could not read the image'));
      r.readAsDataURL(file);
    });
  },
};

/**
 * Turn a picked File into the attachment the app sends.
 *
 *  - Already within both pixel caps and small enough → sent as-is, no
 *    re-encode ("small enough" is KEEP_ORIGINAL_MAX_BYTES for lossy sources,
 *    MAX_ENCODED_BYTES for PNG — re-encoding a PNG at the same size gains
 *    nothing and would only cost its text legibility).
 *  - Otherwise drawn on a canvas at the fitted size. A PNG source is exported
 *    as PNG first and falls back to JPEG only if that is still over
 *    MAX_ENCODED_BYTES; a lossy source goes straight to JPEG `quality`.
 *  - The result must fit MAX_ENCODED_BYTES or the picture is refused.
 *
 * @returns {Promise<{name, dataUrl, mime, bytes, width, height, resized, originalBytes}>}
 */
export async function prepareImage(file, {
  maxSide = MAX_SIDE_PX, maxPixels = MAX_PIXELS, quality = JPEG_QUALITY,
  keepOriginalMaxBytes = KEEP_ORIGINAL_MAX_BYTES, maxEncodedBytes = MAX_ENCODED_BYTES,
} = {}, env = browserImageEnv) {
  const img = await env.decode(file);
  try {
    const [width, height] = fitWithin(img.width, img.height, maxSide, maxPixels);
    const needsResize = width !== img.width || height !== img.height;
    const lossless = LOSSLESS_TYPES.has(file.type);
    const asIsCap = lossless ? maxEncodedBytes : keepOriginalMaxBytes;
    let dataUrl, mime, resized = false;
    if (!needsResize && file.size <= asIsCap) {
      dataUrl = await env.readDataUrl(file);
      mime = file.type;
    } else {
      resized = true;
      if (lossless && needsResize) {           // same-size PNG re-encode can't shrink: skip straight to JPEG
        dataUrl = env.encode(img.source, width, height, 'image/png');
        mime = 'image/png';
      }
      if (!dataUrl || dataUrlBytes(dataUrl) > maxEncodedBytes) {
        dataUrl = env.encode(img.source, width, height, 'image/jpeg', quality);
        mime = 'image/jpeg';
      }
    }
    const bytes = dataUrlBytes(dataUrl);
    if (bytes > maxEncodedBytes) {
      throw new Error(`image is still ${(bytes / 1e6).toFixed(1)} MB after resizing — limit ${(maxEncodedBytes / 1e6).toFixed(0)} MB`);
    }
    return { name: file.name, dataUrl, mime, bytes, width, height, resized, originalBytes: file.size };
  } finally {
    img.close?.();
  }
}

// ─── labelling ───────────────────────────────────────────────────────────
//
// Every image is numbered across the conversation and introduced by a short
// text part — `Image 3 (receipt.png):` — the way multi-image prompting guides
// recommend, so the user, the model and the placeholder that later replaces a
// trimmed image all call it by one name. App-only bookkeeping rides on the
// parts as `_`-prefixed fields (`_n`, `_name`, `_labelFor`, `_placeholderFor`)
// which `toWire` strips before anything is sent.

/** `Image N (name)` — the one name an image goes by in labels and placeholders. */
export function imageLabel(n, name) {
  return `Image ${n} (${name ?? 'image'})`;
}

/** 1 + the highest image number already used in `messages` (images AND placeholders count). */
export function nextImageNumber(messages) {
  let max = 0;
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) {
      const n = p?._n ?? p?._placeholderFor ?? p?._labelFor;
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return max + 1;
}

/**
 * The content parts of a user turn that carries an image:
 * label → image → the user's question (or a default one).
 */
export function imageTurnContent({ n, name, dataUrl, text }) {
  return [
    { type: 'text', text: `${imageLabel(n, name)}:`, _labelFor: n },
    { type: 'image_url', image_url: { url: dataUrl }, _name: name, _n: n },
    { type: 'text', text: text || 'Describe this image.' },
  ];
}

// ─── context budget ──────────────────────────────────────────────────────

const HEX_FACTOR = 2;        // E2EE ciphertext is hex: 2 chars per byte
const PART_OVERHEAD = 96;    // JSON keys, quotes, eph key + nonce + tag per field

/** Estimated size of `messages` on the wire after per-field E2EE. */
export function estimateEncryptedBytes(messages) {
  let total = 0;
  for (const m of messages) {
    const c = m?.content;
    if (typeof c === 'string') total += c.length * HEX_FACTOR + PART_OVERHEAD;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p?.type === 'text') total += String(p.text ?? '').length * HEX_FACTOR + PART_OVERHEAD;
        else if (p?.type === 'image_url') total += String(p.image_url?.url ?? '').length * HEX_FACTOR + PART_OVERHEAD;
        else total += JSON.stringify(p).length * HEX_FACTOR + PART_OVERHEAD;
      }
    }
  }
  return total;
}

/** How an image part is referred to once it is gone: `Image 2 (b.jpg)`, or `image b.jpg` for an unnumbered part. */
const describe = (part) => (Number.isInteger(part._n) ? imageLabel(part._n, part._name) : `image ${part._name ?? ''}`.trim());

const placeholderFor = (part) => ({
  type: 'text', text: `[${describe(part)} sent earlier]`,
  ...(Number.isInteger(part._n) ? { _placeholderFor: part._n } : {}),
});

/** Every image part in `messages`, oldest first, as {mi, ci, label}. */
function imageParts(messages) {
  const out = [];
  messages.forEach((m, mi) => {
    if (!Array.isArray(m?.content)) return;
    m.content.forEach((p, ci) => { if (p?.type === 'image_url') out.push({ mi, ci, label: describe(p) }); });
  });
  return out;
}

/**
 * Replace the image part at (mi, ci) with its placeholder and drop the label
 * part that introduced it (the placeholder carries the same name, so keeping
 * "Image 2 (b.jpg):" in front of "[Image 2 (b.jpg) sent earlier]" is noise).
 */
function retireImage(messages, mi, ci) {
  const copy = messages.slice();
  const part = copy[mi].content[ci];
  const content = copy[mi].content
    .map((p, i) => (i === ci ? placeholderFor(part) : p))
    .filter((p) => !(Number.isInteger(part._n) && p?._labelFor === part._n));
  copy[mi] = { ...copy[mi], content };
  return copy;
}

/**
 * Keep the conversation under `budgetBytes` (estimated encrypted size) by
 * replacing the OLDEST image parts with a text placeholder, one at a time.
 * The newest image is never dropped: the user may be asking about it.
 * Pure — returns new arrays; the caller decides whether to persist them.
 *
 * @returns {{ messages: object[], dropped: string[] }}  dropped = labels, oldest first
 */
export function trimImageContext(messages, { budgetBytes = CONTEXT_BUDGET_BYTES } = {}) {
  let current = messages;
  const dropped = [];
  let images = imageParts(current);
  while (images.length > 1 && estimateEncryptedBytes(current) > budgetBytes) {
    const oldest = images[0];
    current = retireImage(current, oldest.mi, oldest.ci);
    dropped.push(oldest.label);
    images = imageParts(current);
  }
  return { messages: current, dropped };
}

/** Replace EVERY image part with its placeholder (the last-resort path after a 413). */
export function stripAllImages(messages) {
  let current = messages;
  const dropped = [];
  for (let images = imageParts(current); images.length; images = imageParts(current)) {
    const oldest = images[0];
    current = retireImage(current, oldest.mi, oldest.ci);
    dropped.push(oldest.label);
  }
  return { messages: current, dropped };
}

/**
 * Replace every image part EXCEPT those in the last message (the turn being
 * sent now) with its placeholder — the 413 retry. Only pictures the model
 * has actually seen before may be called "sent earlier"; stripping the
 * current turn's image would make the model answer about a picture it never
 * got. If nothing older exists, `dropped` is empty and `messages` is
 * returned as-is: the caller must NOT retry (the current image or the text
 * is the cause) and should give the image back to the user.
 */
export function stripHistoryImages(messages) {
  if (messages.length < 2) return { messages, dropped: [] };
  const history = messages.slice(0, -1);
  const { messages: stripped, dropped } = stripAllImages(history);
  if (!dropped.length) return { messages, dropped };
  return { messages: [...stripped, messages[messages.length - 1]], dropped };
}

/**
 * What actually goes on the wire for the CURRENT model. A model without
 * "image" in its `input_modalities` gets every image replaced by its
 * placeholder — for this request only. The caller keeps the un-stripped
 * history, so switching back to a vision model brings the pictures back.
 * (Never send images a model is not declared to take: the failure is an
 * upstream 4xx on every later turn, not a graceful ignore.)
 *
 * @returns {{ messages: object[], dropped: string[] }}
 */
export function outgoingFor(messages, { imagesAllowed }) {
  return imagesAllowed ? { messages, dropped: [] } : stripAllImages(messages);
}

/**
 * The messages as the API must see them: app-only fields (leading `_`, such
 * as `_name` on image parts) removed at every level. Upstreams may reject
 * unknown keys in content parts.
 */
export function toWire(messages) {
  const clean = (o) => {
    if (Array.isArray(o)) return o.map(clean);
    if (o && typeof o === 'object') {
      return Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, clean(v)]));
    }
    return o;
  };
  return clean(messages);
}
