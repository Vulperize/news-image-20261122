// World news of Sunday 22 November 2026 in one image.
// Node 22, standard library only, no network. Draws the picture with its own 5x7 bitmap font and
// shape rasteriser, then writes it with its own PNG encoder to /output/entry.png (1024 x 1024 RGB).
// Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;       // output pixels
const SS = 2;            // supersampling factor: draw at 2048 x 2048, average down to 1024
const W = SIZE * SS;

type RGB = [number, number, number];
type Pt = [number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// ---------------------------------------------------------------- canvas (coordinates in 1024 space)
const buf = new Uint8Array(W * W * 3);

function setPx(px: number, py: number, c: RGB): void {
  if (px < 0 || py < 0 || px >= W || py >= W) return;
  const i = (py * W + px) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}

// Fill every internal pixel whose centre (in 1024 space) passes `inside`, within a bounding box.
function fillWhere(x0: number, y0: number, x1: number, y1: number, c: RGB, inside: (x: number, y: number) => boolean): void {
  const pxa = Math.max(0, Math.floor(x0 * SS)), pxb = Math.min(W - 1, Math.ceil(x1 * SS));
  const pya = Math.max(0, Math.floor(y0 * SS)), pyb = Math.min(W - 1, Math.ceil(y1 * SS));
  for (let py = pya; py <= pyb; py++) {
    const y = (py + 0.5) / SS;
    for (let px = pxa; px <= pxb; px++) {
      const x = (px + 0.5) / SS;
      if (inside(x, y)) setPx(px, py, c);
    }
  }
}

function rect(x: number, y: number, w: number, h: number, c: RGB): void {
  fillWhere(x, y, x + w, y + h, c, (px, py) => px >= x && px < x + w && py >= y && py < y + h);
}

function circle(cx: number, cy: number, r: number, c: RGB): void {
  fillWhere(cx - r, cy - r, cx + r, cy + r, c, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
}

function ellipseRing(cx: number, cy: number, rx: number, ry: number, t: number, c: RGB): void {
  fillWhere(cx - rx, cy - ry, cx + rx, cy + ry, c, (x, y) => {
    const o = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
    const i = ((x - cx) / Math.max(rx - t, 0.01)) ** 2 + ((y - cy) / Math.max(ry - t, 0.01)) ** 2;
    return o <= 1 && i > 1;
  });
}

// Even-odd scanline fill of a polygon.
function poly(pts: Pt[], c: RGB): void {
  let ya = Infinity, yb = -Infinity;
  for (const [, y] of pts) { ya = Math.min(ya, y); yb = Math.max(yb, y); }
  const pya = Math.max(0, Math.floor(ya * SS)), pyb = Math.min(W - 1, Math.ceil(yb * SS));
  for (let py = pya; py <= pyb; py++) {
    const y = (py + 0.5) / SS;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const pxa = Math.max(0, Math.ceil(xs[k] * SS - 0.5)), pxb = Math.min(W - 1, Math.floor(xs[k + 1] * SS - 0.5));
      for (let px = pxa; px <= pxb; px++) setPx(px, py, c);
    }
  }
}

// Thick line with round caps.
function line(x1: number, y1: number, x2: number, y2: number, t: number, c: RGB): void {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (t / 2), ny = (dx / len) * (t / 2);
  poly([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]], c);
  circle(x1, y1, t / 2, c);
  circle(x2, y2, t / 2, c);
}

// Translate and scale a list of points (icons are drawn on a 130 x 130 grid).
const at = (ox: number, oy: number, pts: Pt[]): Pt[] => pts.map(([x, y]) => [ox + x, oy + y]);

// ---------------------------------------------------------------- 5x7 bitmap font (uppercase)
const ROWS_FONT: Record<string, string> = {
  'A': '.###.|#...#|#...#|#####|#...#|#...#|#...#', 'B': '####.|#...#|#...#|####.|#...#|#...#|####.',
  'C': '.###.|#...#|#....|#....|#....|#...#|.###.', 'D': '####.|#...#|#...#|#...#|#...#|#...#|####.',
  'E': '#####|#....|#....|####.|#....|#....|#####', 'F': '#####|#....|#....|####.|#....|#....|#....',
  'G': '.###.|#...#|#....|#.###|#...#|#...#|.####', 'H': '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  'I': '.###.|..#..|..#..|..#..|..#..|..#..|.###.', 'J': '..###|...#.|...#.|...#.|#..#.|#..#.|.##..',
  'K': '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', 'L': '#....|#....|#....|#....|#....|#....|#####',
  'M': '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', 'N': '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  'O': '.###.|#...#|#...#|#...#|#...#|#...#|.###.', 'P': '####.|#...#|#...#|####.|#....|#....|#....',
  'Q': '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', 'R': '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  'S': '.####|#....|#....|.###.|....#|....#|####.', 'T': '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  'U': '#...#|#...#|#...#|#...#|#...#|#...#|.###.', 'V': '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  'W': '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.', 'X': '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  'Y': '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', 'Z': '#####|....#|...#.|..#..|.#...|#....|#####',
  '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  '2': '.###.|#...#|....#|...#.|..#..|.#...|#####', '3': '####.|....#|....#|.###.|....#|....#|####.',
  '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', '5': '#####|#....|####.|....#|....#|#...#|.###.',
  '6': '..##.|.#...|#....|####.|#...#|#...#|.###.', '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
  '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.', '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
  ' ': '.....|.....|.....|.....|.....|.....|.....', "'": '..#..|..#..|.#...|.....|.....|.....|.....',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....', ';': '.....|.##..|.##..|.....|.##..|..#..|.#...',
  '-': '.....|.....|.....|#####|.....|.....|.....', ',': '.....|.....|.....|.....|.##..|..#..|.#...',
  '.': '.....|.....|.....|.....|.....|.##..|.##..', '*': '.....|.....|.###.|.###.|.###.|.....|.....',
  '/': '....#|....#|...#.|..#..|.#...|#....|#....',
};

function glyph(ch: string): string {
  const g = ROWS_FONT[ch];
  if (g === undefined) throw new Error(`no glyph for ${JSON.stringify(ch)}`);
  const rows = g.split('|');
  if (rows.length !== 7 || rows.some((r) => r.length !== 5)) throw new Error(`bad glyph ${JSON.stringify(ch)}`);
  return rows.join('');
}

const textWidth = (s: string, scale: number): number => (s.length * 6 - 1) * scale;

// Each lit cell is drawn 1 px wider and taller than the grid, so strokes stay solid when the
// image is shrunk to a thumbnail while the gaps inside letters stay open.
const BOLD = 1;

function text(s: string, x: number, y: number, scale: number, c: RGB): void {
  for (let i = 0; i < s.length; i++) {
    const g = glyph(s[i]);
    for (let r = 0; r < 7; r++)
      for (let k = 0; k < 5; k++)
        if (g[r * 5 + k] === '#') rect(x + (i * 6 + k) * scale, y + r * scale, scale + BOLD, scale + BOLD, c);
  }
}

function textCentered(s: string, cx: number, y: number, scale: number, c: RGB): void {
  text(s, Math.round(cx - textWidth(s, scale) / 2), y, scale, c);
}

// Greedy word wrap; throws when a word or the block does not fit, so nothing is ever cut off.
function wrap(s: string, scale: number, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of s.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (textWidth(next, scale) <= maxW) cur = next;
    else {
      if (!cur || textWidth(word, scale) > maxW) throw new Error(`"${word}" does not fit in ${maxW}px at scale ${scale}`);
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------- palette
const BG = hex('#0E1A2B');
const WHITE = hex('#FFFFFF');
const INK = hex('#111111');
const PAPER = hex('#FAF7F0');
const YELLOW = hex('#FFD23F');
const FLAME = hex('#FF9F1C');
const RED = hex('#E53935');
const GREEN = hex('#1E7F3F');
const BLUE = hex('#1F5FBF');
const ORANGE = hex('#C4501A');
const WAR = hex('#A61E1E');
const PURPLE = hex('#5E35A0');
const TEAL = hex('#0B6E78');

// ---------------------------------------------------------------- icons (130 x 130 tile at ox, oy)
type Icon = (ox: number, oy: number, bg: RGB) => void;

const globeNoDeal: Icon = (ox, oy, bg) => {
  const cx = ox + 58, cy = oy + 62;
  circle(cx, cy, 44, WHITE);
  ellipseRing(cx, cy, 20, 44, 4, bg);
  rect(cx - 44, cy - 2, 88, 4, bg);
  rect(cx - 38, cy - 24, 76, 4, bg);
  rect(cx - 38, cy + 20, 76, 4, bg);
  circle(ox + 100, oy + 100, 24, RED);
  ellipseRing(ox + 100, oy + 100, 24, 24, 3, WHITE);
  line(ox + 90, oy + 90, ox + 110, oy + 110, 6, WHITE);
  line(ox + 110, oy + 90, ox + 90, oy + 110, 6, WHITE);
};

const capitol: Icon = (ox, oy) => {
  rect(ox + 16, oy + 104, 98, 12, WHITE);
  rect(ox + 22, oy + 96, 86, 6, WHITE);
  for (let i = 0; i < 6; i++) rect(ox + 26 + i * 14, oy + 70, 8, 26, WHITE);
  rect(ox + 22, oy + 62, 86, 8, WHITE);
  fillWhere(ox + 35, oy + 28, ox + 95, oy + 60, WHITE, (x, y) => y <= oy + 60 && (x - (ox + 65)) ** 2 + (y - (oy + 60)) ** 2 <= 30 * 30);
  rect(ox + 61, oy + 16, 8, 14, WHITE);
  rect(ox + 64, oy + 6, 2, 12, WHITE);
};

const jet: Icon = (ox, oy) => {
  poly(at(ox, oy, [[65, 8], [73, 30], [73, 52], [118, 80], [118, 92], [73, 80], [73, 100], [92, 114], [92, 122], [65, 114],
    [38, 122], [38, 114], [57, 100], [57, 80], [12, 92], [12, 80], [57, 52], [57, 30]]), WHITE);
  circle(ox + 65, oy + 38, 4, YELLOW);
};

const strikeBlock: Icon = (ox, oy, bg) => {
  poly(at(ox, oy, [[22, 120], [22, 30], [70, 30], [78, 46], [88, 40], [98, 58], [108, 54], [108, 120]]), WHITE);
  for (let r = 0; r < 5; r++)
    for (let k = 0; k < 4; k++) {
      const wx = ox + 30 + k * 19, wy = oy + 40 + r * 15;
      if (!(k >= 2 && r === 0)) rect(wx, wy, 10, 8, bg);
    }
  poly(at(ox, oy, [[68, 44], [74, 18], [82, 32], [90, 8], [98, 30], [108, 20], [110, 52], [86, 46]]), FLAME);
  poly(at(ox, oy, [[78, 44], [84, 28], [90, 38], [96, 24], [102, 46]]), YELLOW);
  rect(ox + 14, oy + 120, 102, 4, WHITE);
};

const fallingChart: Icon = (ox, oy) => {
  rect(ox + 14, oy + 12, 6, 106, WHITE);
  rect(ox + 14, oy + 112, 104, 6, WHITE);
  const pts: Pt[] = at(ox, oy, [[28, 26], [48, 48], [62, 38], [84, 72], [98, 64], [110, 96]]);
  for (let i = 0; i + 1 < pts.length; i++) line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 7, RED);
  poly(at(ox, oy, [[100, 98], [118, 84], [118, 110]]), RED);
  rect(ox + 70, oy + 14, 46, 22, WHITE);
  text('AI', ox + 81, oy + 18, 2, PURPLE);
};

const droneOverHome: Icon = (ox, oy, bg) => {
  const cx = ox + 65, cy = oy + 34;
  line(cx - 30, cy - 18, cx + 30, cy + 18, 5, WHITE);
  line(cx + 30, cy - 18, cx - 30, cy + 18, 5, WHITE);
  for (const [dx, dy] of [[-30, -18], [30, -18], [-30, 18], [30, 18]] as Pt[]) ellipseRing(cx + dx, cy + dy, 14, 6, 3, WHITE);
  circle(cx, cy, 9, WHITE);
  line(cx, cy + 12, cx, cy + 40, 3, YELLOW);
  poly(at(ox, oy, [[30, 96], [65, 70], [100, 96]]), WHITE);
  rect(ox + 38, oy + 96, 54, 26, WHITE);
  rect(ox + 59, oy + 104, 12, 18, bg);
};

const missileHit: Icon = (ox, oy) => {
  const ang = -Math.PI / 4, ca = Math.cos(ang), sa = Math.sin(ang);
  const rot = (p: Pt[]): Pt[] => p.map(([x, y]) => [ox + 44 + x * ca - y * sa, oy + 86 + x * sa + y * ca]);
  poly(rot([[-40, -7], [20, -7], [36, 0], [20, 7], [-40, 7]]), WHITE);
  poly(rot([[-40, -7], [-48, -18], [-30, -7]]), WHITE);
  poly(rot([[-40, 7], [-48, 18], [-30, 7]]), WHITE);
  const sx = ox + 92, sy = oy + 38, star: Pt[] = [];
  for (let i = 0; i < 16; i++) {
    const r = i % 2 === 0 ? 32 : 13, a = (i * Math.PI) / 8;
    star.push([sx + r * Math.cos(a), sy + r * Math.sin(a)]);
  }
  poly(star, YELLOW);
  circle(sx, sy, 9, WHITE);
};

const burningShip: Icon = (ox, oy, bg) => {
  poly(at(ox, oy, [[8, 76], [122, 76], [110, 100], [20, 100]]), WHITE);
  rect(ox + 80, oy + 52, 28, 24, WHITE);
  rect(ox + 86, oy + 58, 6, 6, bg);
  rect(ox + 96, oy + 58, 6, 6, bg);
  poly(at(ox, oy, [[24, 76], [30, 46], [38, 60], [46, 30], [54, 56], [62, 42], [68, 76]]), FLAME);
  poly(at(ox, oy, [[34, 76], [40, 58], [46, 66], [50, 50], [58, 76]]), YELLOW);
  for (let i = 0; i < 3; i++) line(ox + 12 + i * 38, oy + 114, ox + 36 + i * 38, oy + 114, 4, WHITE);
};

// ---------------------------------------------------------------- the day's stories (see notes.md)
interface Story { tag: string; head: string; color: RGB; icon: Icon }

const STORIES: Story[] = [
  { tag: 'CLIMATE * TURKEY', head: 'COP31 CLIMATE TALKS END WITHOUT DEAL', color: GREEN, icon: globeNoDeal },
  { tag: 'USA * ELECTIONS', head: "DEMOCRATS' BIGGEST HOUSE MAJORITY SINCE 1992", color: BLUE, icon: capitol },
  { tag: 'IRAN * USA', head: 'TRUMP: IRAN WAR COULD RESUME', color: ORANGE, icon: jet },
  { tag: 'UKRAINE * WAR', head: 'DRONE HITS KYIV-AREA FLATS: 14 MISSING', color: WAR, icon: strikeBlock },
  { tag: 'MARKETS * KOREA', head: 'AI STOCK ROUT: SEOUL READIES FUND', color: PURPLE, icon: fallingChart },
  { tag: 'SUDAN * WAR', head: 'DRONES KILL CHILDREN IN KHARTOUM', color: WAR, icon: droneOverHome },
  { tag: 'YEMEN * SAUDI', head: 'SAUDI ARABIA SHOOTS DOWN HOUTHI MISSILE', color: ORANGE, icon: missileHit },
  { tag: 'BALTIC * FINLAND', head: 'RUSSIA TOWS DRONE-HIT SHIP FROM FINLAND', color: TEAL, icon: burningShip },
];

// ---------------------------------------------------------------- layout
const M = 12, GAP = 10;
const TITLE_H = 158;
const COLS = 2, ROWS = 4;
const PW = Math.floor((SIZE - 2 * M - GAP * (COLS - 1)) / COLS);
const PH = Math.floor((SIZE - TITLE_H - M - GAP * (ROWS - 1)) / ROWS);
const TAG_H = 42, TAG_SCALE = 4, TILE = 130, HEAD_SCALE = 4, LINE_H = 7 * HEAD_SCALE + 8;

rect(0, 0, SIZE, SIZE, BG);

// Title: the day it sums up, large.
textCentered('WORLD NEWS OF SUNDAY', SIZE / 2, 18, 5, WHITE);
textCentered('22 NOVEMBER 2026', SIZE / 2, 66, 10, YELLOW);
rect(M, TITLE_H - 10, SIZE - 2 * M, 3, YELLOW);

STORIES.forEach((s, i) => {
  const x = M + (i % COLS) * (PW + GAP);
  const y = TITLE_H + Math.floor(i / COLS) * (PH + GAP);
  rect(x, y, PW, PH, PAPER);
  rect(x, y, PW, TAG_H, s.color);
  if (textWidth(s.tag, TAG_SCALE) > PW - 24) throw new Error(`tag too wide: ${s.tag}`);
  text(s.tag, x + 12, y + Math.floor((TAG_H - 7 * TAG_SCALE) / 2), TAG_SCALE, WHITE);

  const bodyTop = y + TAG_H, bodyH = PH - TAG_H;
  const tx = x + 10, ty = bodyTop + Math.floor((bodyH - TILE) / 2);
  rect(tx, ty, TILE, TILE, s.color);
  s.icon(tx, ty, s.color);

  const hx = tx + TILE + 14, hw = x + PW - 12 - hx;
  const lines = wrap(s.head, HEAD_SCALE, hw);
  const blockH = lines.length * LINE_H - 8;
  if (blockH > bodyH - 12) throw new Error(`headline too tall: ${s.head}`);
  let ly = bodyTop + Math.floor((bodyH - blockH) / 2);
  for (const l of lines) { text(l, hx, ly, HEAD_SCALE, INK); ly += LINE_H; }
});

// ---------------------------------------------------------------- downsample 2x2 -> RGB rows
const raw = new Uint8Array(SIZE * (1 + SIZE * 3));
for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 3);
  raw[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) sum += buf[((y * SS + sy) * W + (x * SS + sx)) * 3 + ch];
      raw[row + 1 + x * 3 + ch] = Math.round(sum / (SS * SS));
    }
  }
}

// ---------------------------------------------------------------- PNG encoder
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // colour type: RGB
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // deflate, adaptive filtering, no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', new Uint8Array(0)),
]);

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'entry.png');
writeFileSync(outFile, png);
chmodSync(outFile, 0o644);
