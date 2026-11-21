import { describe, expect, it } from 'vitest';
import { encodeGif } from './gifEncoder';

/** Minimal GIF89a + LZW decoder to verify spec compliance & pixel roundtrip. */
function decodeGifForTest(bytes: Uint8Array) {
  let pos = 0;
  const readStr = (n: number) => String.fromCharCode(...bytes.slice(pos, (pos += n)));
  const readU16 = () => {
    const v = bytes[pos] | (bytes[pos + 1] << 8);
    pos += 2;
    return v;
  };

  const header = readStr(6);
  const width = readU16();
  const height = readU16();
  const packed = bytes[pos++];
  pos += 2; // bg + aspect
  const gctSize = packed & 0x80 ? 1 << ((packed & 0x07) + 1) : 0;
  const gct = bytes.slice(pos, (pos += gctSize * 3));

  const frames: { delayCs: number; pixels: Uint8Array }[] = [];
  let hasNetscapeLoop = false;
  let lastDelayCs = 0;

  while (pos < bytes.length) {
    const introducer = bytes[pos++];
    if (introducer === 0x3b) break; // Trailer
    if (introducer === 0x21) {
      const label = bytes[pos++];
      if (label === 0xf9) {
        const blockSize = bytes[pos++];
        expect(blockSize).toBe(4);
        pos++; // packed
        lastDelayCs = readU16();
        pos++; // transparent idx
        expect(bytes[pos++]).toBe(0);
      } else if (label === 0xff) {
        const blockSize = bytes[pos++];
        const appId = readStr(blockSize);
        if (appId === 'NETSCAPE2.0') hasNetscapeLoop = true;
        while (bytes[pos] !== 0) pos += bytes[pos] + 1;
        pos++;
      } else {
        while (bytes[pos] !== 0) pos += bytes[pos] + 1;
        pos++;
      }
    } else if (introducer === 0x2c) {
      const left = readU16();
      const top = readU16();
      const w = readU16();
      const h = readU16();
      expect(left).toBe(0);
      expect(top).toBe(0);
      expect(w).toBe(width);
      expect(h).toBe(height);
      pos++; // packed (no LCT)

      const minCodeSize = bytes[pos++];
      const clearCode = 1 << minCodeSize;
      const eoiCode = clearCode + 1;

      // Read all sub-blocks into a contiguous stream
      const chunks: Uint8Array[] = [];
      let totalLen = 0;
      while (bytes[pos] !== 0) {
        const len = bytes[pos++];
        chunks.push(bytes.slice(pos, (pos += len)));
        totalLen += len;
      }
      pos++; // block terminator
      const stream = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) {
        stream.set(c, off);
        off += c.length;
      }

      // LZW decode
      let bitPos = 0;
      const readCode = (size: number) => {
        let val = 0;
        for (let b = 0; b < size; b++) {
          const byteIdx = (bitPos + b) >> 3;
          const bitIdx = (bitPos + b) & 7;
          if ((stream[byteIdx] >> bitIdx) & 1) val |= 1 << b;
        }
        bitPos += size;
        return val;
      };

      const out: number[] = [];
      let codeSize = minCodeSize + 1;
      let dict: number[][] = [];
      const resetDict = () => {
        dict = [];
        for (let i = 0; i < clearCode; i++) dict[i] = [i];
        dict[clearCode] = [];
        dict[eoiCode] = [];
        codeSize = minCodeSize + 1;
      };
      resetDict();

      let prev: number[] | null = null;
      while (bitPos + codeSize <= stream.length * 8) {
        const code = readCode(codeSize);
        if (code === clearCode) {
          resetDict();
          prev = null;
          continue;
        }
        if (code === eoiCode) break;

        let entry: number[];
        if (code < dict.length) {
          entry = dict[code];
        } else if (code === dict.length && prev) {
          entry = [...prev, prev[0]];
        } else {
          throw new Error(`Invalid LZW code ${code} (dict=${dict.length})`);
        }
        for (let i = 0; i < entry.length; i++) out.push(entry[i]);

        if (prev && dict.length < 4096) {
          dict.push([...prev, entry[0]]);
          if (dict.length === 1 << codeSize && codeSize < 12) {
            codeSize++;
          }
        }
        prev = entry;
      }

      frames.push({ delayCs: lastDelayCs, pixels: new Uint8Array(out) });
    }
  }

  return { header, width, height, gct, hasNetscapeLoop, frames };
}

describe('gifEncoder', () => {
  it('encodes valid looping GIF89a with exact frame delays and pixel roundtrip', () => {
    const w = 120;
    const h = 80;
    const makeFrame = (seed: number) => {
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          // Mix flat spans and varied patterns to force > 4096 LZW table clears
          const band = (x + y * 3 + seed * 17) % 13;
          rgba[i] = band === 0 ? 245 : band === 1 ? 52 : 13 + ((x * 7 + y * 5 + seed * 31) % 60);
          rgba[i + 1] = band === 0 ? 158 : band === 1 ? 211 : 14 + ((x * 3 + y * 11) % 50);
          rgba[i + 2] = band === 0 ? 11 : band === 1 ? 153 : 18 + ((x * 13 + y * 2) % 64);
          rgba[i + 3] = 255;
        }
      }
      return rgba;
    };

    const f1 = makeFrame(1);
    const f2 = makeFrame(2);
    const gif = encodeGif(
      w,
      h,
      [
        { rgba: f1, delayMs: 90 },
        { rgba: f2, delayMs: 750 },
      ],
      [
        [13, 14, 17],
        [245, 158, 11],
        [52, 211, 153],
      ],
    );

    expect(gif[gif.length - 1]).toBe(0x3b);
    const decoded = decodeGifForTest(gif);
    expect(decoded.header).toBe('GIF89a');
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(decoded.hasNetscapeLoop).toBe(true);
    expect(decoded.frames).toHaveLength(2);
    expect(decoded.frames[0].delayCs).toBe(9);
    expect(decoded.frames[1].delayCs).toBe(75);
    expect(decoded.frames[0].pixels.length).toBe(w * h);
    expect(decoded.frames[1].pixels.length).toBe(w * h);

    // Check pinned colors decoded faithfully on frame 1
    for (let p = 0; p < w * h; p += 19) {
      const idx = decoded.frames[0].pixels[p];
      const dr = Math.abs(decoded.gct[idx * 3] - f1[p * 4]);
      const dg = Math.abs(decoded.gct[idx * 3 + 1] - f1[p * 4 + 1]);
      const db = Math.abs(decoded.gct[idx * 3 + 2] - f1[p * 4 + 2]);
      expect(dr + dg + db).toBeLessThan(48);
    }
  });
});
