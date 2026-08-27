// 地形生成の出力を PPM で書き出す。node game2/test/mapgen-render.mjs [seed] [out.ppm]
import { generate, W, N, T, ORE } from '../src/world/mapgen.js';
import { writeFileSync } from 'node:fs';

const seed = Number(process.argv[2] || 1);
const out = process.argv[3] || `/tmp/map-${seed}.ppm`;
const S = 2;                                   // 1里マス = 2px → 768×768

const g = generate(seed);
const COL = {
  [T.SEA]:      [ 24,  52,  96],
  [T.LAKE]:     [ 52, 110, 168],
  [T.ICE]:      [238, 244, 250],
  [T.ALP]:      [206, 206, 210],
  [T.MTN]:      [146, 142, 138],
  [T.HILL]:     [166, 142,  96],
  [T.WASTE]:    [186, 168, 118],
  [T.SAND]:     [220, 202, 148],
  [T.MARSH]:    [ 74, 108,  92],
  [T.JUNGLE]:   [ 30,  78,  42],
  [T.WOOD]:     [ 62, 116,  60],
  [T.PLAIN]:    [136, 172,  94],
  [T.GRASS]:    [178, 190, 104],
  [T.ROCK]:     [130, 124, 118],
  [T.SALTLAKE]: [200, 214, 220],
};
const ORECOL = {
  [ORE.IRON]:     [ 70,  70,  76],
  [ORE.COPPER]:   [200, 110,  50],
  [ORE.TIN]:      [180, 180, 200],
  [ORE.GOLD]:     [255, 214,  60],
  [ORE.LEAD]:     [110, 110, 130],
  [ORE.STONE]:    [230, 230, 230],
  [ORE.ROCKSALT]: [250, 250, 200],
};

const px = Buffer.alloc(W * S * W * S * 3);
const put = (x, y, c) => {
  for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
    const o = (((y * S + dy) * W * S) + (x * S + dx)) * 3;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
  }
};
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x;
  let c = COL[g.ter[i]] || [255, 0, 255];
  if (g.land[i]) {                                   // 標高で陰影
    const sh = 0.82 + g.h[i] * 0.36;
    c = [Math.min(255, c[0] * sh) | 0, Math.min(255, c[1] * sh) | 0, Math.min(255, c[2] * sh) | 0];
  }
  if (g.river[i] === 1) c = [ 96, 150, 200];
  if (g.river[i] === 2) c = [ 62, 126, 196];
  if (g.river[i] === 3) c = [ 34, 100, 190];
  if (g.ore[i]) c = g.silver[i] ? [235, 235, 245] : (ORECOL[g.ore[i]] || c);
  put(x, y, c);
}
writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${W * S} ${W * S}\n255\n`), px]));
console.log('wrote', out);
