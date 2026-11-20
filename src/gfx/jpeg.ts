import type { DecodedImage } from './png';

/**
 * JPEG support: synchronous size parsing + async pixel pre-decode.
 *
 * ## Why split it in two
 *
 * MIDP's `Image.createImage(InputStream)` is a **synchronous** call, but the
 * browser only decodes JPEG via `createImageBitmap`, which is **async**
 * (returns a Promise). There is no legal way to synchronously await a Promise
 * in JS (`Atomics.wait` would block the event loop and stall the
 * createImageBitmap decode thread along with it). So we split the work:
 *
 * - **Size** (`getWidth`/`getHeight`, used by the game for layout) -> read
 *   the SOF markers, **synchronously**.
 * - **Pixels** (`drawImage`) -> before the MIDlet boots, `await
 *   createImageBitmap` every jpg in the jar and cache the results; at
 *   runtime `createImage` just looks the cache up.
 *
 * ## Why use the browser decoder instead of writing our own JPEG decoder
 *
 * A correct baseline JPEG decoder (Huffman + IDCT + upsampling) is at least
 * 500-800 lines; with progressive, chroma subsampling variants and CMYK/YCCK
 * color spaces, thousands. The browser already ships an industrial-grade
 * JPEG decoder (libjpeg-turbo), and `createImageBitmap` gets you the pixels
 * in one line. That is the core idea of this project -- **let the browser
 * fill in what is missing, don't rebuild it yourself**: ~120 lines of code
 * for full JPEG support, 0 KB extra payload.
 *
 * By the same logic we skip GIF (`createImageBitmap` only decodes the first
 * frame) and BMP (rare in J2ME; handle when we meet one). Both get a clear
 * message in `unsupportedImageFormat`.
 */

/** JPEG SOI marker FFD8 + next byte (FF D8 FF is the SOI + marker prefix). */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function isGif(bytes: Uint8Array): boolean {
  return bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
}

/**
 * Read the size synchronously from the SOF markers. In JPEG the dimensions are
 * written in plain text near the file head (within a few hundred bytes), so we
 * get them instantly without decoding -- exactly what the synchronous MIDP API
 * needs.
 *
 * Supported SOF: SOF0/1/2/3/5/6/7/9/10/11/13/14/15.
 * Excluded: DHT(C4)/JPG(C8)/DAC(CC) -- these are C4/C8/CC, not SOF, easy to mix up.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(bytes)) return null;
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    let marker = bytes[p + 1];
    // Skip fill bytes: in FF FF D8 the run of FF bytes is just padding
    while (marker === 0xff && p + 2 < bytes.length) {
      p++;
      marker = bytes[p + 1];
    }
    p += 2;
    // Markers without a length field
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break; // EOI
    if (p + 2 > bytes.length) break;
    const len = (bytes[p] << 8) | bytes[p + 1];
    if (len < 2 || p + len > bytes.length) break;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      // Segment layout: FF Cn(2) len(2) precision(1) height(2) width(2) ncomponents(1) ...
      if (p + 7 <= bytes.length) {
        const height = (bytes[p + 3] << 8) | bytes[p + 4];
        const width = (bytes[p + 5] << 8) | bytes[p + 6];
        if (width > 0 && height > 0) return { width, height };
      }
      return null;
    }
    p += len;
  }
  return null;
}

/**
 * Asynchronously decode JPEG pixels. Uses the browser's native decoder
 * (libjpeg-turbo), so baseline/progressive, 4:4:4/4:2:2/4:2:0, grayscale and
 * CMYK are all supported.
 */
export async function decodeJpeg(bytes: Uint8Array): Promise<DecodedImage> {
  const info = jpegSize(bytes);
  // Use a Blob instead of a dataURL: skips base64 encode/decode (~half the time
  // for a 10 KB image) and avoids the string blow-up for large images
  // (some game resources are 1024x1024).
  const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, width, height);
    // getImageData returns a Uint8ClampedArray, which is what DecodedImage wants
    return { width, height, data: new Uint8ClampedArray(img.data) };
  } finally {
    bitmap.close();
    void info;
  }
}

/**
 * Cache of decoded JPEGs. The key is the file content's FNV-1a hash + length,
 * so the same jpg read from different paths/streams still hits the cache --
 * old games often bundle the same image under multiple resource entries.
 */
const cache = new Map<string, DecodedImage>();

/** Content fingerprint: length + FNV-1a 32-bit. Good enough and fast (no need to pull in crypto for consistency). */
export function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length}:${(h >>> 0).toString(36)}`;
}

export function cachedJpeg(bytes: Uint8Array): DecodedImage | undefined {
  return cache.get(fingerprint(bytes));
}

export function cacheJpeg(bytes: Uint8Array, img: DecodedImage): void {
  cache.set(fingerprint(bytes), img);
}

/** For tests / reloads: clear the cache. */
export function clearJpegCache(): void {
  cache.clear();
}

/**
 * Boot-time prewarm: decode every jpeg resource in the jar.
 * Must be awaited before the MIDlet starts, otherwise the runtime sync
 * createImage call has no pixels.
 *
 * Returns stats for logging: how many decoded, how many failed (failures do
 * not block the game, only logged).
 */
export async function prewarmImages(
  entries: Iterable<[string, Uint8Array]>,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ decoded: number; failed: number; total: number }> {
  const jobs: [string, Uint8Array][] = [];
  for (const [name, bytes] of entries) {
    if (isJpeg(bytes)) jobs.push([name, bytes]);
  }
  let decoded = 0;
  let failed = 0;
  // Serial decode: parallel createImageBitmap calls actually make the main
  // thread's decode queue time out more often, and serial timing is
  // predictable (~1-3 ms per image).
  for (let i = 0; i < jobs.length; i++) {
    const [name, bytes] = jobs[i];
    try {
      cacheJpeg(bytes, await decodeJpeg(bytes));
      decoded++;
    } catch {
      failed++;
    }
    onProgress?.(i + 1, jobs.length, name);
  }
  return { decoded, failed, total: jobs.length };
}
