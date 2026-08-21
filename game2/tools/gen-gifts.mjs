// docs/v3/gifts.csv を読んで src/core/gifts.gen.js を書き出す。
//
//   node game2/tools/gen-gifts.mjs
//
// S以上（授かりもの）は104ステとは別枠。
// 0〜100の値ではなく「持っている／いない」の二値で、1つの座位が取りうる11種類の値。
// 野生型(0) ＋ 10個。同じ座位なので、1人が2つ発現することは構造上ありえない。
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV } from './gen-stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CSV = join(ROOT, 'docs', 'v3', 'gifts.csv');
const OUT = join(HERE, '..', 'src', 'core', 'gifts.gen.js');

const text = readFileSync(CSV, 'utf8');
const sha = createHash('sha256').update(text).digest('hex');
const rows = parseCSV(text).filter(r => r.length > 1 && r[0]);
const head = rows[0], body = rows.slice(1);

const TIERS = ['S', 'SS', 'SSS', 'G'];
const list = a => '[' + a.map(v => JSON.stringify(v)).join(', ') + ']';
const nums = a => '[' + a.join(', ') + ']';

const idx = n => { const i = head.indexOf(n); if (i < 0) throw new Error(`列がない: ${n}`); return i; };
const C = { key: idx('key'), name: idx('名前'), tier: idx('段'), mode: idx('遺伝方式'),
            w: idx('重み'), eff: idx('効果'), when: idx('効きはじめ') };

for (const r of body) {
  if (!TIERS.includes(r[C.tier])) throw new Error(`段が変: ${r[C.key]} = ${r[C.tier]}`);
  if (r[C.mode] !== '劣性' && r[C.mode] !== '顕性') throw new Error(`遺伝方式が変: ${r[C.key]}`);
  if (!(+r[C.w] > 0)) throw new Error(`重みが変: ${r[C.key]}`);
}
// 顕性は多くても1つ。顕性は小集団で暴走するので（実測：村の6割を占めた）0でよい
const dom = body.filter(r => r[C.mode] === '顕性');
if (dom.length > 1) throw new Error(`顕性は多くても1つ（いまは${dom.length}個）`);

const W = body.map(r => +r[C.w]);
const total = W.reduce((a, b) => a + b, 0);

const js = `// 自動生成。手で直さない。
// もと: docs/v3/gifts.csv (sha256 ${sha})
// 作り直し: node game2/tools/gen-gifts.mjs
//
// S以上＝授かりもの。104ステとは別枠。A-23。
//   ・0〜100の値ではなく「持っている／いない」
//   ・1つの座位。野生型(NONE=0) と 10個の授かりもの(1〜10)
//   ・繁栄だけ顕性。残り9つは劣性ホモでのみ発現
//   ・同じ座位なので、2つ同時に発現することは構造上ありえない

export const SOURCE = "docs/v3/gifts.csv";
export const SOURCE_SHA256 = "${sha}";
export const COUNT = ${body.length};

/** 野生型。持っていない状態 */
export const NONE = 0;

export const TIERS = ${list(TIERS)};

/** 添字は 1〜COUNT。0番は野生型なので空けてある */
export const KEY   = ${list(['', ...body.map(r => r[C.key])])};
export const NAME  = ${list(['', ...body.map(r => r[C.name])])};
export const TIER  = ${nums([-1, ...body.map(r => TIERS.indexOf(r[C.tier]))])};
export const EFFECT = ${list(['', ...body.map(r => r[C.eff])])};
export const WHEN  = ${list(['', ...body.map(r => r[C.when])])};

/** 顕性か。繁栄だけ true */
export const DOMINANT = ${list([false, ...body.map(r => r[C.mode] === '顕性')])};

/** 新規変異が起きたとき、どれになるかの重み。合計 ${total} */
export const WEIGHT = ${nums([0, ...W])};
export const WEIGHT_TOTAL = ${total};

/** 出産1回あたり、新しい授かりものの種が生まれる確率。A-23 */
export const MUT_PER_BIRTH = 1 / 4700;

export const OF = Object.freeze(Object.fromEntries(
  KEY.map((k, i) => [k, i]).filter(([k]) => k)));

/** 重み付きで1つ引く。rng は core/rng.js の RNG */
export function rollGift(rng) {
  let r = rng.next() * WEIGHT_TOTAL;
  for (let g = 1; g <= COUNT; g++) { r -= WEIGHT[g]; if (r < 0) return g; }
  return COUNT;
}

/** 2本の対立遺伝子から、実際に発現しているものを決める。0なら何も無し */
export function express(a, b) {
  if (a !== NONE && DOMINANT[a]) return a;        // 顕性は1本で出る
  if (b !== NONE && DOMINANT[b]) return b;
  if (a === b && a !== NONE) return a;            // 劣性は揃ったときだけ
  return NONE;
}

/** 発現はしていないが隠して運んでいるもの（保因） */
export function carried(a, b) {
  const e = express(a, b);
  const out = [];
  if (a !== NONE && a !== e) out.push(a);
  if (b !== NONE && b !== e && b !== a) out.push(b);
  return out;
}
`;
writeFileSync(OUT, js);
const byTier = TIERS.map(t => `${t}${body.filter(r => r[C.tier] === t).length}`).join(' ');
process.stdout.write(`gifts.gen.js を書いた: ${body.length}個（${byTier}） 顕性${dom.length} 劣性${body.length - dom.length} 重み計${total}\n`);
