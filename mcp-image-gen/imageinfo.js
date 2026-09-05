/**
 * Width and height straight out of the file header.
 *
 * The tool result has to tell the model what it actually produced, and "what it
 * produced" includes the dimensions — `meta/muse-image` ignores the exact
 * aspect_ratio and answers with an orientation, so the requested ratio is not
 * evidence of anything. `sharp` is not a dependency of this sidecar and pulling it
 * in for two integers is not worth the image size; four container headers is
 * ~70 lines.
 *
 * Returns `null` for an unrecognised header rather than guessing — the caller then
 * reports the byte size alone instead of inventing a resolution.
 */

function fromPng(buf) {
  // 8-byte signature, then a length-prefixed IHDR whose first two fields are the
  // dimensions as big-endian uint32.
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function fromGif(buf) {
  if (buf.length < 10) return null;
  const magic = buf.toString('ascii', 0, 6);
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function fromJpeg(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;

  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++; // fill byte or padding; resync on the next marker
      continue;
    }
    const marker = buf[pos + 1];

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan

    // SOF0..SOF15 hold the frame dimensions; C4/C8/CC are Huffman/JPG/arithmetic
    // tables that happen to sit in the same range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }

    const segLength = buf.readUInt16BE(pos + 2);
    if (segLength < 2) return null;
    pos += 2 + segLength;
  }
  return null;
}

function fromWebp(buf) {
  // The container meta/muse-image actually answers in, in all three of its flavours.
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;

  const fourcc = buf.toString('ascii', 12, 16);

  if (fourcc === 'VP8 ') {
    // Lossy: 3-byte frame tag, the 0x9d012a sync code, then two 14-bit fields.
    if (buf.readUIntBE(23, 3) !== 0x9d012a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }

  if (fourcc === 'VP8L') {
    // Lossless: 0x2f signature, then 14 bits of (width-1) and 14 of (height-1).
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }

  if (fourcc === 'VP8X') {
    // Extended: canvas size as two 24-bit little-endian (value-1) fields.
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }

  return null;
}

export function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  for (const reader of [fromWebp, fromPng, fromJpeg, fromGif]) {
    try {
      const dims = reader(buffer);
      if (dims && dims.width > 0 && dims.height > 0) return dims;
    } catch {
      /* truncated or malformed header: try the next reader */
    }
  }
  return null;
}

export function ratioValue(name) {
  const [w, h] = String(name).split(':').map(Number);
  return w > 0 && h > 0 ? w / h : null;
}

/** Within this of each other, two ratios are the same picture. */
const RATIO_TOLERANCE = 0.02;

export function ratiosMatch(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(a - b) / b < RATIO_TOLERANCE;
}

/**
 * The name of the delivered ratio, when one of the accepted values fits it — and
 * `null` when none does.
 *
 * Reducing by GCD is the obvious move and the wrong one: 768×817 reduces to
 * 768:817, which is true, unhelpful, and impossible to compare against the `1:1`
 * the model asked for. And a nearest-match with no tolerance is worse than
 * useless — it would call 768×817 a 1:1 square. So: name it only when the name is
 * honest, and otherwise let the pixel dimensions speak, since they already do.
 */
export function nearestRatio({ width, height }, candidates) {
  const actual = width / height;
  let best = null;
  let bestDelta = Infinity;
  for (const candidate of candidates) {
    const value = ratioValue(candidate);
    if (value == null) continue;
    const delta = Math.abs(value - actual);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }
  return best && bestDelta / actual < RATIO_TOLERANCE ? best : null;
}

export function orientationOf({ width, height }) {
  if (width === height) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
