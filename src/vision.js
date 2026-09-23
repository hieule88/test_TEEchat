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
// Hence: shrink before encrypting (vision models downsample to ~1–2k px
// anyway), and keep images in context only within a byte budget, oldest out
// first, the latest always kept so follow-up questions about it still work.

export const MAX_SIDE_PX = 1568;          // longest side after resize
export const JPEG_QUALITY = 0.85;
export const MAX_SOURCE_BYTES = 6 * 1024 * 1024;   // what we accept from the picker (camera photos)
export const MAX_ENCODED_BYTES = 2 * 1024 * 1024;  // what we accept AFTER resizing — more is abnormal
export const KEEP_ORIGINAL_MAX_BYTES = 1024 * 1024; // small enough: send as-is (keeps PNG alpha)
export const CONTEXT_BUDGET_BYTES = 8 * 1024 * 1024; // estimated ENCRYPTED size of all images in context

/** Fit (w, h) inside a square of `maxSide`, never upscaling. */
export function fitWithin(width, height, maxSide = MAX_SIDE_PX) {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return [width, height];
  const k = maxSide / longest;
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
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
 * Small images (≤ KEEP_ORIGINAL_MAX_BYTES and ≤ MAX_SIDE_PX) go as-is — that
 * keeps PNG transparency and avoids a needless re-encode. Everything else is
 * drawn onto a canvas at most MAX_SIDE_PX on the long side and exported as
 * JPEG. The result must fit MAX_ENCODED_BYTES or the picture is refused.
 *
 * @returns {Promise<{name, dataUrl, bytes, width, height, resized, originalBytes}>}
 */
export async function prepareImage(file, {
  maxSide = MAX_SIDE_PX, quality = JPEG_QUALITY,
  keepOriginalMaxBytes = KEEP_ORIGINAL_MAX_BYTES, maxEncodedBytes = MAX_ENCODED_BYTES,
} = {}, env = browserImageEnv) {
  const img = await env.decode(file);
  try {
    const small = file.size <= keepOriginalMaxBytes && Math.max(img.width, img.height) <= maxSide;
    let dataUrl, width = img.width, height = img.height, resized = false;
    if (small) {
      dataUrl = await env.readDataUrl(file);
    } else {
      [width, height] = fitWithin(img.width, img.height, maxSide);
      dataUrl = env.encode(img.source, width, height, 'image/jpeg', quality);
      resized = true;
    }
    const bytes = dataUrlBytes(dataUrl);
    if (bytes > maxEncodedBytes) {
      throw new Error(`image is still ${(bytes / 1e6).toFixed(1)} MB after resizing — limit ${(maxEncodedBytes / 1e6).toFixed(0)} MB`);
    }
    return { name: file.name, dataUrl, bytes, width, height, resized, originalBytes: file.size };
  } finally {
    img.close?.();
  }
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

const placeholderFor = (part) => ({ type: 'text', text: `[image sent earlier: ${part._name ?? 'image'}]` });

/** Every image part in `messages`, oldest first, as {mi, ci, name}. */
function imageParts(messages) {
  const out = [];
  messages.forEach((m, mi) => {
    if (!Array.isArray(m?.content)) return;
    m.content.forEach((p, ci) => { if (p?.type === 'image_url') out.push({ mi, ci, name: p._name ?? 'image' }); });
  });
  return out;
}

function replacePart(messages, mi, ci, replacement) {
  const copy = messages.slice();
  const content = copy[mi].content.slice();
  content[ci] = replacement;
  copy[mi] = { ...copy[mi], content };
  return copy;
}

/**
 * Keep the conversation under `budgetBytes` (estimated encrypted size) by
 * replacing the OLDEST image parts with a text placeholder, one at a time.
 * The newest image is never dropped: the user may be asking about it.
 * Pure — returns new arrays; the caller decides whether to persist them.
 *
 * @returns {{ messages: object[], dropped: string[] }}
 */
export function trimImageContext(messages, { budgetBytes = CONTEXT_BUDGET_BYTES } = {}) {
  let current = messages;
  const dropped = [];
  let images = imageParts(current);
  while (images.length > 1 && estimateEncryptedBytes(current) > budgetBytes) {
    const oldest = images[0];
    const part = current[oldest.mi].content[oldest.ci];
    current = replacePart(current, oldest.mi, oldest.ci, placeholderFor(part));
    dropped.push(oldest.name);
    images = imageParts(current);
  }
  return { messages: current, dropped };
}

/** Replace EVERY image part with its placeholder (the last-resort path after a 413). */
export function stripAllImages(messages) {
  let current = messages;
  const dropped = [];
  for (const img of imageParts(messages).reverse()) {   // indexes stay valid: parts are replaced 1:1
    const part = current[img.mi].content[img.ci];
    current = replacePart(current, img.mi, img.ci, placeholderFor(part));
    dropped.unshift(img.name);
  }
  return { messages: current, dropped };
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
