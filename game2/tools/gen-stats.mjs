// docs/v3/stats_v3.csv を読んで src/core/stats.gen.js を書き出す。
//
// 実行時に CSV を読まない。読むのはこの道具だけで、ゲームは生成された .js を import する。
// CSV を直したら、これを走らせ直して、test/check.js を緑にすること。
//
//   node game2/tools/gen-stats.mjs
//
// 出す2本：
//   src/core/stats.gen.js      列ごとの短い値（名前・染色体・腕・対・レア度・閾値・
//                              伸びしろ・遺伝方式・遺伝率・性別限定・伸びる場所）
//   src/core/statsText.gen.js  長い説明文（高いといい面・悪い面・相互関係・影響・注記）
//                              ホバー説明で使う。core/stats.js は import しない（重いので）

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');               // 増殖/
const CSV = join(ROOT, 'docs', 'v3', 'stats_v3.csv');
const OUT_DATA = join(HERE, '..', 'src', 'core', 'stats.gen.js');
const OUT_TEXT = join(HERE, '..', 'src', 'core', 'statsText.gen.js');

// ---- CSV を読む -----------------------------------------------------------
// 引用符付きの欄にも耐える書き方にしておく（いまの CSV には無いが、後で足される）
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* 捨てる */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

// ---- 段階の並び（低い→高い） ---------------------------------------------
const CATEGORIES = ['からだ', 'あたま', 'こころ'];
const RARITY = ['N', 'F', 'E', 'D', 'C', 'B', 'A', 'AA', 'S', 'SS'];
const THRESHOLD = ['該当なし', 'なし', '低い', '中', '高い', '非常に高い'];
const GROWTH = ['該当なし', 'ほぼゼロ', '小さい', '中', '大きい'];
const INHERIT = ['中間遺伝', '優劣'];
const HERITABILITY = ['低い', 'やや低い', '中', 'やや高い', '高い'];
const SEXLIMIT = ['なし', '女のみ', '男のみ'];
const PLACE = ['変わらない', '中央', '辺境', '両方'];

function level(list, raw, where) {
  // 「該当なし／…注記…」の形が来るので、／の手前だけを段階として見る
  const head = String(raw).split('／')[0].trim();
  const i = list.indexOf(head);
  if (i < 0) throw new Error(`gen-stats: ${where} に知らない値「${head}」`);
  return i;
}
function note(raw) {
  const parts = String(raw).split('／');
  return parts.length > 1 ? parts.slice(1).join('／').trim() : '';
}

// ---- 本体 ----------------------------------------------------------------
const src = readFileSync(CSV);
const sha = createHash('sha256').update(src).digest('hex');
const rows = parseCSV(src.toString('utf8').replace(/^﻿/, ''));
const head = rows[0];
const body = rows.slice(1);

const EXPECT = ['大項目', '中項目', '名前', '染色体', '腕', '対になるステ',
  '高いといい面', '高いと悪い面', '相互関係でさらにいい面', '相互関係でさらに悪い面',
  'レア度', '努力値の閾値', '伸びしろ', '遺伝方式', '遺伝率の基準値', '性別限定',
  '他のステへの影響', '他の枠への影響', '伸びる場所'];
if (head.length !== EXPECT.length || EXPECT.some((c, i) => head[i] !== c)) {
  throw new Error(`gen-stats: 列の並びが違う\n  期待 ${EXPECT.join(',')}\n  実際 ${head.join(',')}`);
}
for (const [i, r] of body.entries()) {
  if (r.length !== EXPECT.length) {
    throw new Error(`gen-stats: ${i + 2}行目の列数が ${r.length}（${EXPECT.length} のはず）`);
  }
}

const NAME = body.map(r => r[2].trim());
const dup = NAME.filter((n, i) => NAME.indexOf(n) !== i);
if (dup.length) throw new Error(`gen-stats: 名前が重複「${dup.join('／')}」`);

const index = new Map(NAME.map((n, i) => [n, i]));

const CATEGORY = body.map((r, i) => level(CATEGORIES, r[0], `${NAME[i]}の大項目`));
const SUBNAMES = [];
const SUB = body.map(r => {
  const s = r[1].trim();
  let k = SUBNAMES.indexOf(s);
  if (k < 0) { k = SUBNAMES.length; SUBNAMES.push(s); }
  return k;
});
const CHROM = body.map((r, i) => {
  const m = /^(\d+)番$/.exec(r[3].trim());
  if (!m) throw new Error(`gen-stats: ${NAME[i]} の染色体「${r[3]}」が読めない`);
  return parseInt(m[1], 10);
});
const ARM = body.map((r, i) => {
  const a = r[4].trim();
  if (a !== 'A' && a !== 'B') throw new Error(`gen-stats: ${NAME[i]} の腕「${a}」が A でも B でもない`);
  return a === 'A' ? 0 : 1;
});
const PAIR = body.map((r, i) => {
  const p = r[5].trim();
  if (p === 'なし' || p === '') return -1;
  if (!index.has(p)) throw new Error(`gen-stats: ${NAME[i]} の対「${p}」が一覧に無い`);
  return index.get(p);
});
const RARITY_I = body.map((r, i) => level(RARITY, r[10], `${NAME[i]}のレア度`));
const THRESH_I = body.map((r, i) => level(THRESHOLD, r[11], `${NAME[i]}の閾値`));
const GROWTH_I = body.map((r, i) => level(GROWTH, r[12], `${NAME[i]}の伸びしろ`));
const INHERIT_I = body.map((r, i) => level(INHERIT, r[13], `${NAME[i]}の遺伝方式`));
const HERIT_I = body.map((r, i) => level(HERITABILITY, r[14], `${NAME[i]}の遺伝率`));
const SEX_I = body.map((r, i) => level(SEXLIMIT, r[15], `${NAME[i]}の性別限定`));
const PLACE_I = body.map((r, i) => level(PLACE, r[18], `${NAME[i]}の伸びる場所`));

// ---- 対の整合（同じ染色体の反対の腕にあるか） -----------------------------
for (let i = 0; i < NAME.length; i++) {
  const j = PAIR[i];
  if (j < 0) continue;
  if (PAIR[j] !== i) throw new Error(`gen-stats: ${NAME[i]}↔${NAME[j]} の対が片思い`);
  if (CHROM[i] !== CHROM[j]) throw new Error(`gen-stats: ${NAME[i]}と${NAME[j]}の染色体が違う`);
  if (ARM[i] === ARM[j]) throw new Error(`gen-stats: ${NAME[i]}と${NAME[j]}が同じ腕に載っている`);
}

const q = s => JSON.stringify(s);
const list = a => `[${a.map(q).join(',')}]`;
const nums = a => `[${a.join(',')}]`;

// ---- stats.gen.js ---------------------------------------------------------
const dataJS = `// 自動生成。手で直さない。
// もと: docs/v3/stats_v3.csv (sha256 ${sha})
// 作り直し: node game2/tools/gen-stats.mjs
//
// ${NAME.length}ステ。列ごとに1本の配列（添字がステ番号）。

export const SOURCE = ${q('docs/v3/stats_v3.csv')};
export const SOURCE_SHA256 = ${q(sha)};
export const COUNT = ${NAME.length};

// 段階の並び。小さいほど低い
export const CATEGORIES = ${list(CATEGORIES)};
export const SUBCATEGORIES = ${list(SUBNAMES)};
export const RARITY_LEVELS = ${list(RARITY)};
export const THRESHOLD_LEVELS = ${list(THRESHOLD)};
export const GROWTH_LEVELS = ${list(GROWTH)};
export const INHERIT_MODES = ${list(INHERIT)};
export const HERITABILITY_LEVELS = ${list(HERITABILITY)};
export const SEXLIMIT_LEVELS = ${list(SEXLIMIT)};
export const PLACE_LEVELS = ${list(PLACE)};

export const NAME = ${list(NAME)};
export const CATEGORY = ${nums(CATEGORY)};
export const SUB = ${nums(SUB)};
export const CHROMOSOME = ${nums(CHROM)};
export const ARM = ${nums(ARM)};          // 0=A 1=B
export const PAIR = ${nums(PAIR)};        // 対になるステの番号。無ければ -1
export const RARITY = ${nums(RARITY_I)};
export const THRESHOLD = ${nums(THRESH_I)};
export const GROWTH = ${nums(GROWTH_I)};
export const INHERIT = ${nums(INHERIT_I)};
export const HERITABILITY = ${nums(HERIT_I)};
export const SEXLIMIT = ${nums(SEX_I)};
export const PLACE = ${nums(PLACE_I)};
`;

// ---- statsText.gen.js -----------------------------------------------------
const textJS = `// 自動生成。手で直さない。
// もと: docs/v3/stats_v3.csv (sha256 ${sha})
//
// 長い説明文。ホバー説明と用語辞書で使う。
// core/stats.js は これを import しない（重いので、要る側だけが読む）。

export const GOOD = ${list(body.map(r => r[6]))};
export const BAD = ${list(body.map(r => r[7]))};
export const SYNERGY_GOOD = ${list(body.map(r => r[8]))};
export const SYNERGY_BAD = ${list(body.map(r => r[9]))};
export const AFFECTS_STATS = ${list(body.map(r => r[16]))};
export const AFFECTS_FRAMES = ${list(body.map(r => r[17]))};
// 伸びしろ欄に「該当なし／…」で付いていた注記（こころの育ち方）
export const GROWTH_NOTE = ${list(body.map(r => note(r[12])))};
`;

writeFileSync(OUT_DATA, dataJS);
writeFileSync(OUT_TEXT, textJS);

const byCat = CATEGORIES.map((c, i) => `${c}${CATEGORY.filter(x => x === i).length}`).join(' ');
const armA = ARM.filter(a => a === 0).length;
process.stdout.write(
  `stats.gen.js を書いた: ${NAME.length}ステ（${byCat}）` +
  ` 染色体${Math.max(...CHROM)}本 腕A${armA}/B${ARM.length - armA}` +
  ` 対${PAIR.filter(p => p >= 0).length}本\n`);
