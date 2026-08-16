#!/usr/bin/env node
/**
 * Generates the itqan Shield icon assets as PNGs with zero dependencies.
 *
 * Brand (docs/BRAND-GUIDELINES.md): ink #0A0A0A, white #FFFFFF, plus #EAB308.
 * Motif: solid shield silhouette with a plus mark.
 *
 * Outputs (relative to shield/):
 *   assets/icon.png           256x256  ink shield + yellow plus (app icon / installer)
 *   assets/tray.png           32x32    white shield (dark taskbars)
 *   assets/tray-dark.png      32x32    ink shield   (light taskbars)
 *   assets/trayTemplate.png   32x32    black shield + alpha (macOS template)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- PNG writer
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- shield drawing
const INK = [0x0a, 0x0a, 0x0a];
const WHITE = [0xff, 0xff, 0xff];
const PLUS = [0xea, 0xb3, 0x08];

/**
 * Returns true when normalized point (u,v) in [0,1]^2 is inside the shield.
 * Top edge ~v=0.10, shoulders to v=0.42, point at v=0.95.
 */
function inShield(u, v) {
  if (v < 0.10 || v > 0.95) return false;
  let hw;
  if (v <= 0.42) hw = 0.46;
  else {
    const t = (v - 0.42) / 0.53;
    hw = 0.46 * (1 - Math.pow(t, 1.7));
  }
  return Math.abs(u - 0.5) <= hw;
}

/** Returns true when (u,v) is inside the plus mark (centered ~0.5,0.52). */
function inPlus(u, v) {
  const s = 0.135; // half arm length
  const t = 0.038; // half arm thickness
  const cx = 0.5;
  const cy = 0.52;
  const dx = Math.abs(u - cx);
  const dy = Math.abs(v - cy);
  return (dx <= s && dy <= t) || (dy <= s && dx <= t);
}

function render(size, opts) {
  const { shield: shieldColor, plus, bg } = opts;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const i = (y * size + x) * 4;
      let color = null;
      if (plus && inPlus(u, v)) color = PLUS;
      else if (inShield(u, v)) color = shieldColor;
      if (color) {
        rgba[i] = color[0];
        rgba[i + 1] = color[1];
        rgba[i + 2] = color[2];
        rgba[i + 3] = 255;
      } else if (bg) {
        rgba[i] = bg[0];
        rgba[i + 1] = bg[1];
        rgba[i + 2] = bg[2];
        rgba[i + 3] = 255;
      }
    }
  }
  return encodePNG(size, size, rgba);
}

// ------------------------------------------------------------------ main
const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const files = {
  'icon.png': render(256, { shield: INK, plus: true }),
  'tray.png': render(32, { shield: WHITE, plus: true }),
  'tray-dark.png': render(32, { shield: INK, plus: true }),
  'trayTemplate.png': render(32, { shield: [0, 0, 0], plus: false }),
};

for (const [name, buf] of Object.entries(files)) {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`wrote assets/${name} (${buf.length} bytes)`);
}
