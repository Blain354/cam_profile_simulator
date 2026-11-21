/**
 * Zero-dependency, spec-compliant GIF89a encoder optimized for Canvas 2D
 * CAD/technical visualizations.
 *
 * - Builds an adaptive 256-color Global Color Table via median-cut quantization
 *   over sampled frame pixels (preserving flat dark tones and crisp strokes).
 * - Maps RGBA pixels to palette indices via a lazy 15-bit RGB LUT.
 * - Encodes full frames using flat-array GIF LZW (9–12 bit variable codes)
 *   with Netscape 2.0 infinite looping and exact per-frame centisecond delays.
 */

export interface GifFrameInput {
  rgba: Uint8ClampedArray;
  /** Frame display duration in milliseconds (clamped to >= 20 ms per browser GIF spec). */
  delayMs: number;
}

class ByteWriter {
  private buf: Uint8Array;
  private pos = 0;

  constructor(initialCapacity = 65536) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private ensure(extra: number) {
    if (this.pos + extra <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.pos + extra) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf.subarray(0, this.pos));
    this.buf = grown;
  }

  byte(v: number) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  u16(v: number) {
    this.ensure(2);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >> 8) & 0xff;
  }

  bytes(arr: ArrayLike<number>) {
    this.ensure(arr.length);
    for (let i = 0; i < arr.length; i++) {
      this.buf[this.pos++] = arr[i] & 0xff;
    }
  }

  ascii(str: string) {
    this.ensure(str.length);
    for (let i = 0; i < str.length; i++) {
      this.buf[this.pos++] = str.charCodeAt(i) & 0xff;
    }
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

interface ColorBucket {
  colors: number[]; // packed 15-bit RGB keys (r5<<10 | g5<<5 | b5)
  counts: Int32Array;
  totalCount: number;
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

function makeBucket(colors: number[], counts: Int32Array): ColorBucket {
  let rMin = 31, rMax = 0, gMin = 31, gMax = 0, bMin = 31, bMax = 0;
  let totalCount = 0;
  for (let i = 0; i < colors.length; i++) {
    const k = colors[i];
    const r = (k >> 10) & 31;
    const g = (k >> 5) & 31;
    const b = k & 31;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
    totalCount += counts[k];
  }
  return { colors, counts, totalCount, rMin, rMax, gMin, gMax, bMin, bMax };
}

/** Build a 256-color RGB palette (768 bytes) via median-cut over sampled frames. */
function buildPalette(frames: GifFrameInput[], pinnedColors: [number, number, number][]): Uint8Array {
  const counts = new Int32Array(32768);
  const frameStride = Math.max(1, Math.floor(frames.length / 18));
  for (let fi = 0; fi < frames.length; fi += frameStride) {
    const rgba = frames[fi].rgba;
    // Sample every 2nd pixel so quantization stays < 10 ms even for large canvases
    for (let i = 0; i < rgba.length; i += 8) {
      const k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
      counts[k]++;
    }
  }
  // Always include the last frame (typically the finale)
  if (frames.length > 0) {
    const last = frames[frames.length - 1].rgba;
    for (let i = 0; i < last.length; i += 8) {
      const k = ((last[i] >> 3) << 10) | ((last[i + 1] >> 3) << 5) | (last[i + 2] >> 3);
      counts[k]++;
    }
  }

  const unique: number[] = [];
  for (let k = 0; k < 32768; k++) {
    if (counts[k] > 0) unique.push(k);
  }

  const palette = new Uint8Array(256 * 3);
  const pinnedCount = Math.min(pinnedColors.length, 32);
  for (let i = 0; i < pinnedCount; i++) {
    palette[i * 3] = pinnedColors[i][0];
    palette[i * 3 + 1] = pinnedColors[i][1];
    palette[i * 3 + 2] = pinnedColors[i][2];
  }

  const targetDynamic = 256 - pinnedCount;
  if (unique.length === 0) return palette;

  const buckets: ColorBucket[] = [makeBucket(unique, counts)];
  while (buckets.length < targetDynamic) {
    let splitIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.colors.length <= 1) continue;
      const range = Math.max(b.rMax - b.rMin, b.gMax - b.gMin, b.bMax - b.bMin);
      if (range <= 0) continue;
      // Favor wide color range weighted mildly by pixel population
      const score = range * Math.log2(b.totalCount + 2);
      if (score > bestScore) {
        bestScore = score;
        splitIdx = i;
      }
    }
    if (splitIdx < 0) break;

    const bucket = buckets[splitIdx];
    const rRange = bucket.rMax - bucket.rMin;
    const gRange = bucket.gMax - bucket.gMin;
    const bRange = bucket.bMax - bucket.bMin;
    const shift = gRange >= rRange && gRange >= bRange ? 5 : rRange >= bRange ? 10 : 0;

    bucket.colors.sort((a, b) => ((a >> shift) & 31) - ((b >> shift) & 31));
    const half = bucket.totalCount / 2;
    let acc = 0;
    let mid = 1;
    for (let i = 0; i < bucket.colors.length - 1; i++) {
      acc += counts[bucket.colors[i]];
      if (acc >= half) {
        mid = Math.max(1, i + 1);
        break;
      }
    }
    const left = bucket.colors.slice(0, mid);
    const right = bucket.colors.slice(mid);
    buckets.splice(splitIdx, 1, makeBucket(left, counts), makeBucket(right, counts));
  }

  for (let i = 0; i < buckets.length && pinnedCount + i < 256; i++) {
    const b = buckets[i];
    let rSum = 0, gSum = 0, bSum = 0, wSum = 0;
    for (let j = 0; j < b.colors.length; j++) {
      const k = b.colors[j];
      const w = counts[k];
      rSum += (((k >> 10) & 31) * 8 + 4) * w;
      gSum += (((k >> 5) & 31) * 8 + 4) * w;
      bSum += ((k & 31) * 8 + 4) * w;
      wSum += w;
    }
    const idx = (pinnedCount + i) * 3;
    if (wSum > 0) {
      palette[idx] = Math.min(255, Math.round(rSum / wSum));
      palette[idx + 1] = Math.min(255, Math.round(gSum / wSum));
      palette[idx + 2] = Math.min(255, Math.round(bSum / wSum));
    }
  }

  return palette;
}

/** Map RGBA buffer to 8-bit palette indices using a lazy 15-bit RGB LUT. */
function quantizeFrame(
  rgba: Uint8ClampedArray,
  palette: Uint8Array,
  lut: Int16Array,
  outIndices: Uint8Array,
) {
  const n = outIndices.length;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = lut[key];
    if (idx < 0) {
      let bestDist = 0x7fffffff;
      let bestI = 0;
      for (let c = 0; c < 256; c++) {
        const co = c * 3;
        const dr = r - palette[co];
        const dg = g - palette[co + 1];
        const db = b - palette[co + 2];
        const dist = dr * dr * 2 + dg * dg * 4 + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestI = c;
          if (dist === 0) break;
        }
      }
      idx = bestI;
      lut[key] = idx;
    }
    outIndices[i] = idx;
  }
}

// Hash table size (prime > 4096 * 2 for fast open addressing with minimal collisions)
const HASH_SIZE = 9973;

/** GIF89a LZW compression for 8-bit indexed pixel streams (minCodeSize = 8). */
function writeLzwImageData(writer: ByteWriter, indices: Uint8Array) {
  const minCodeSize = 8;
  const clearCode = 1 << minCodeSize; // 256
  const eoiCode = clearCode + 1;      // 257

  writer.byte(minCodeSize);

  const hashKeys = new Int32Array(HASH_SIZE).fill(-1);
  const hashVals = new Int16Array(HASH_SIZE);
  const subBlock = new Uint8Array(255);
  let subLen = 0;

  let bitAcc = 0;
  let bitCount = 0;

  const flushSubBlock = () => {
    if (subLen > 0) {
      writer.byte(subLen);
      writer.bytes(subBlock.subarray(0, subLen));
      subLen = 0;
    }
  };

  const emit = (code: number, size: number) => {
    bitAcc |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      subBlock[subLen++] = bitAcc & 0xff;
      bitAcc >>= 8;
      bitCount -= 8;
      if (subLen === 255) flushSubBlock();
    }
  };

  let codeSize = minCodeSize + 1; // 9
  let nextCode = eoiCode + 1;     // 258

  emit(clearCode, codeSize);

  if (indices.length > 0) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      let slot = (key * 2654435761 >>> 0) % HASH_SIZE;
      let found = -1;
      while (true) {
        const hk = hashKeys[slot];
        if (hk === -1) break;
        if (hk === key) {
          found = hashVals[slot];
          break;
        }
        slot++;
        if (slot === HASH_SIZE) slot = 0;
      }

      if (found !== -1) {
        prefix = found;
      } else {
        emit(prefix, codeSize);
        if (nextCode < 4096) {
          hashKeys[slot] = key;
          hashVals[slot] = nextCode;
          if (nextCode === (1 << codeSize) && codeSize < 12) {
            codeSize++;
          }
          nextCode++;
        } else {
          emit(clearCode, codeSize);
          hashKeys.fill(-1);
          codeSize = minCodeSize + 1;
          nextCode = eoiCode + 1;
        }
        prefix = k;
      }
    }
    emit(prefix, codeSize);
  }

  emit(eoiCode, codeSize);
  if (bitCount > 0) {
    subBlock[subLen++] = bitAcc & 0xff;
    if (subLen === 255) flushSubBlock();
  }
  flushSubBlock();
  writer.byte(0x00); // Block terminator
}

/**
 * Encode an array of RGBA frames into a looping GIF89a byte array.
 * `pinnedColors` guarantees exact representation for critical UI/brand colors.
 */
export function encodeGif(
  width: number,
  height: number,
  frames: GifFrameInput[],
  pinnedColors: [number, number, number][] = [],
): Uint8Array {
  const writer = new ByteWriter(Math.max(65536, frames.length * 8192));
  const palette = buildPalette(frames, pinnedColors);
  const lut = new Int16Array(32768).fill(-1);
  const pixelCount = width * height;
  const indices = new Uint8Array(pixelCount);

  // Header
  writer.ascii('GIF89a');

  // Logical Screen Descriptor
  writer.u16(width);
  writer.u16(height);
  writer.byte(0xf7); // GCT present (1), 8-bit color res (111), unsorted (0), 256 entries (111)
  writer.byte(0);    // Background color index
  writer.byte(0);    // Pixel aspect ratio

  // Global Color Table (256 * 3 bytes)
  writer.bytes(palette);

  // Netscape 2.0 Application Extension (loop infinitely)
  writer.bytes([0x21, 0xff, 0x0b]);
  writer.ascii('NETSCAPE2.0');
  writer.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const delayCs = Math.max(2, Math.min(65535, Math.round(f.delayMs / 10)));

    // Graphic Control Extension
    writer.bytes([0x21, 0xf9, 0x04, 0x04]); // disposal=1 (do not dispose), no transparency
    writer.u16(delayCs);
    writer.byte(0);    // Transparent color index (unused)
    writer.byte(0);    // Block terminator

    // Image Descriptor
    writer.byte(0x2c);
    writer.u16(0);     // left
    writer.u16(0);     // top
    writer.u16(width);
    writer.u16(height);
    writer.byte(0);    // no local color table, not interlaced

    quantizeFrame(f.rgba, palette, lut, indices);
    writeLzwImageData(writer, indices);
  }

  // Trailer
  writer.byte(0x3b);
  return writer.toUint8Array();
}
