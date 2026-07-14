#!/usr/bin/env node
/**
 * Build the 16/48/128 toolbar icons from a hand-rolled PNG generator.
 *
 * No external deps: we emit a minimal, valid PNG by hand. The icon is
 * a solid orange (#ff9f40) rounded square with a clipboard glyph in the
 * middle (filled rectangle that nods at the outline of a clipboard top).
 *
 * Run this before `pnpm build` if you ever need to regenerate the PNGs;
 * the build process itself just copies the already-committed icons.
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'icons');

const ORANGE = [0xff, 0x9f, 0x40];
const WHITE = [0xff, 0xff, 0xff];
const DARK = [0xb6, 0x6e, 0x2d];

function makeBuffer(size) {
  // RGBA pixel buffer.
  const pixels = new Uint8Array(size * size * 4);
  const r = Math.round(size * 0.15); // corner radius
  const cx = size / 2;
  const cy = size / 2;
  // Clipboard glyph dimensions, relative to icon size.
  const cw = Math.round(size * 0.5);
  const ch = Math.round(size * 0.62);
  const cx0 = Math.round(cx - cw / 2);
  const cy0 = Math.round(cy - ch / 2 + size * 0.04);
  // The little clip handle on top of the clipboard.
  const hw = Math.round(cw * 0.45);
  const hh = Math.round(size * 0.08);
  const hx0 = Math.round(cx - hw / 2);
  const hy0 = cy0 - Math.round(hh / 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Rounded-square mask.
      const inCorner = (() => {
        if (x < r && y < r) {
          const dx = r - x;
          const dy = r - y;
          return dx * dx + dy * dy > r * r;
        }
        if (x >= size - r && y < r) {
          const dx = x - (size - r);
          const dy = r - y;
          return dx * dx + dy * dy > r * r;
        }
        if (x < r && y >= size - r) {
          const dx = r - x;
          const dy = y - (size - r);
          return dx * dx + dy * dy > r * r;
        }
        if (x >= size - r && y >= size - r) {
          const dx = x - (size - r);
          const dy = y - (size - r);
          return dx * dx + dy * dy > r * r;
        }
        return false;
      })();

      if (inCorner) {
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
        continue;
      }

      // Default: orange.
      let [rr, gg, bb] = ORANGE;
      let aa = 255;

      // Clipboard glyph (white rounded rect outline).
      const inClip =
        x >= cx0 && x < cx0 + cw && y >= cy0 && y < cy0 + ch;
      const inClipInner =
        x >= cx0 + 2 && x < cx0 + cw - 2 && y >= cy0 + 2 && y < cy0 + ch - 2;
      const inHandle =
        x >= hx0 && x < hx0 + hw && y >= hy0 && y < hy0 + hh;

      if (inHandle) {
        [rr, gg, bb] = DARK;
      } else if (inClip && !inClipInner) {
        [rr, gg, bb] = WHITE;
      } else if (inClip) {
        // Faint horizontal lines hint at "text on the clipboard".
        const stripe = Math.round((y - cy0 - 4) / Math.max(1, Math.round(size * 0.12)));
        if (
          y - cy0 > 6 &&
          y - cy0 < ch - 4 &&
          stripe % 2 === 0 &&
          x - cx0 > 5 &&
          x - cx0 < cw - 5
        ) {
          [rr, gg, bb] = WHITE;
        }
      }

      pixels[idx] = rr;
      pixels[idx + 1] = gg;
      pixels[idx + 2] = bb;
      pixels[idx + 3] = aa;
    }
  }
  return pixels;
}

// PNG encoder — minimal, RGBA only.
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  // CRC32 — RFC 1952 / PNG spec.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // IDAT — filter byte 0 per scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x];
    }
  }
  const idat = deflateSync(raw);
  const iend = Buffer.alloc(0);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', iend),
  ]);
}

for (const size of [16, 48, 128]) {
  const buf = makeBuffer(size);
  const png = encodePng(size, size, buf);
  const out = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
