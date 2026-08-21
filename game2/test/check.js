// 継ぎ目の検査台。node game2/test/check.js
//
// 旧版の教訓：「sim単体とUI単体をいくら検証しても、繋いだ状態は検証されない。
// 13項目が緑のままゲームが起動していなかった」。
// だから検査台を先に作る。中身は旧版の23項目を捨てて、新しく起こす。
//
// いまは土台（core）だけ。world/flow/ui が生えたら、ここに足していく。
// 1項目1行で緑/赤を出し、最後に n/m 緑 を出す。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RNG, rng } from '../src/core/rng.js';
import * as C from '../src/core/calendar.js';
import { make, Store, growArray } from '../src/core/arrays.js';
import * as S from '../src/core/stats.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME2 = join(HERE, '..');
const ROOT = join(GAME2, '..');

// ---- 検査台 ---------------------------------------------------------------
let pass = 0, fail = 0;
const GREEN = '\x1b[32m緑\x1b[0m', RED = '\x1b[31m赤\x1b[0m';

function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`${GREEN} ${label}`); }
  else { fail++; console.log(`${RED} ${label}${detail ? '  … ' + detail : ''}`); }
}
// 投げたら赤にする。書き間違いで検査台ごと落ちるのを防ぐ
function check(label, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) ok(label, true);
    else ok(label, false, String(r));
  } catch (e) {
    ok(label, false, e.message);
  }
}
const eq = (a, b) => a === b ? true : `${a} ≠ ${b}`;
const near = (a, b, tol) => Math.abs(a - b) <= tol ? true : `${a} が ${b}±${tol} の外`;

function section(name) { console.log(`\n── ${name} ──`); }

// ===========================================================================
section('乱数（core/rng.js）');
// ===========================================================================

check('同じ種から同じ列が出る', () => {
  const a = new RNG(12345), b = new RNG(12345);
  for (let i = 0; i < 10000; i++) {
    const x = a.next(), y = b.next();
    if (x !== y) return `${i}回目で食い違う ${x} ≠ ${y}`;
  }
  return true;
});

check('違う種なら違う列になる', () => {
  const a = new RNG(1), b = new RNG(2);
  let same = 0;
  for (let i = 0; i < 1000; i++) if (a.next() === b.next()) same++;
  return same === 0 ? true : `${same}回一致してしまった`;
});

check('旧実装（game/src/core/rng.js）と同じ値が出る', () => {
  // 移植の証拠。旧 xorshift32 が種1で出す最初の5つを焼き付けてある。
  // ここが動いたら「同じ種から同じ歴史」が旧版と切れる
  const r = new RNG(1);
  const got = [r.next(), r.next(), r.next(), r.next(), r.next()];
  const want = [
    0.00006295018829405308, 0.015747428173199296, 0.6164041024167091,
    0.07161863497458398, 0.5584883580449969,
  ];
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) return `${i}番目 ${got[i]} ≠ ${want[i]}`;
  }
  // normal/int/range も旧版と同じ順で同じ値
  const r2 = new RNG(42);
  const g2 = [r2.normal(50, 15), r2.int(100), r2.range(0, 1)];
  const w2 = [22.393262346682306, 11, 0.8493769019842148];
  for (let i = 0; i < w2.length; i++) if (g2[i] !== w2[i]) return `normal系 ${i}番目 ${g2[i]}`;
  return true;
});

check('0〜1の外へ出ない', () => {
  const r = new RNG(7);
  for (let i = 0; i < 200000; i++) {
    const x = r.next();
    if (!(x >= 0 && x < 1)) return `${x} が出た`;
    if (Number.isNaN(x)) return 'NaN が出た';
  }
  return true;
});

check('int/range/bool/pick が範囲を守る', () => {
  const r = new RNG(99);
  const arr = [10, 20, 30, 40];
  for (let i = 0; i < 50000; i++) {
    const n = r.int(6);
    if (!Number.isInteger(n) || n < 0 || n > 5) return `int(6) が ${n}`;
    const v = r.range(-3, 5);
    if (!(v >= -3 && v < 5)) return `range が ${v}`;
    if (typeof r.bool(0.3) !== 'boolean') return 'bool が真偽でない';
    if (!arr.includes(r.pick(arr))) return 'pick が外の値を返した';
  }
  return true;
});

check('正規乱数の平均と散らばりが合う', () => {
  const r = new RNG(4242);
  const n = 200000; let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const x = r.normal(50, 15); s += x; s2 += x * x; }
  const mu = s / n, sd = Math.sqrt(s2 / n - mu * mu);
  const a = near(mu, 50, 0.3), b = near(sd, 15, 0.3);
  return a === true ? b : `平均 ${a}`;
});

check('clampNormal が枠を越えない', () => {
  const r = new RNG(5);
  for (let i = 0; i < 100000; i++) {
    const x = r.clampNormal(50, 40, 0, 100);
    if (!(x >= 0 && x <= 100)) return `${x} が出た`;
  }
  return true;
});

check('shuffle が決定的で、中身を落とさない', () => {
  const base = Array.from({ length: 200 }, (_, i) => i);
  const a = new RNG(31).shuffle(base.slice());
  const b = new RNG(31).shuffle(base.slice());
  if (a.join() !== b.join()) return '同じ種で並びが違う';
  if (a.slice().sort((x, y) => x - y).join() !== base.join()) return '中身が変わった';
  if (a.join() === base.join()) return '混ざっていない';
  return true;
});

check('fork が枝ごとに決まり、親を汚さない', () => {
  const p = new RNG(777);
  const s0 = p.save();
  const x = p.fork(3).next(), y = p.fork(3).next(), z = p.fork(4).next();
  if (x !== y) return '同じ枝で違う値';
  if (x === z) return '違う枝で同じ値';
  return eq(p.save(), s0);
});

check('save/load で続きが再現する', () => {
  const r = new RNG(2024);
  for (let i = 0; i < 100; i++) r.next();
  const st = r.save();
  const want = [r.next(), r.next(), r.next()];
  const r2 = rng(1).load(st);
  const got = [r2.next(), r2.next(), r2.next()];
  return eq(want.join(), got.join());
});

// ===========================================================================
section('暦（core/calendar.js）');
// ===========================================================================

check('1ヶ月30日・1年12ヶ月・1年360日', () =>
  C.DAYS_PER_MONTH === 30 && C.MONTHS_PER_YEAR === 12 && C.DAYS_PER_YEAR === 360
  || `${C.DAYS_PER_MONTH}/${C.MONTHS_PER_YEAR}/${C.DAYS_PER_YEAR}`);

check('tick0 は 1年1月1日・春', () => {
  const d = C.dateOf(0);
  return (d.year === 1 && d.month === 1 && d.day === 1 && d.seasonName === '春')
    || C.formatDate(0);
});

check('359tick で 1年12月30日・冬、360tick で 2年1月1日', () => {
  const a = C.dateOf(359), b = C.dateOf(360);
  if (!(a.year === 1 && a.month === 12 && a.day === 30 && a.winter)) return C.formatDate(359);
  if (!(b.year === 2 && b.month === 1 && b.day === 1)) return C.formatDate(360);
  return true;
});

check('季節が春夏秋冬で3ヶ月ずつ回る', () => {
  const days = [0, 0, 0, 0];
  for (let t = 0; t < 360; t++) days[C.season(t)]++;
  if (days.some(d => d !== 90)) return days.join('/');
  // 並びも見る（年の頭が春、10〜12月が冬）
  const order = [C.seasonName(0), C.seasonName(90), C.seasonName(180), C.seasonName(270)];
  return eq(order.join(''), '春夏秋冬');
});

check('冬は作物ができない（1年のうち90日）', () => {
  let no = 0;
  for (let t = 0; t < 360; t++) if (!C.cropsGrow(t)) no++;
  if (no !== 90) return `${no}日`;
  for (let t = 0; t < 360; t++) if (C.isWinter(t) === C.cropsGrow(t)) return `${t}日目が食い違う`;
  return true;
});

check('日付 → tick → 日付 の往復が10年ぶん合う', () => {
  for (let t = 0; t < 3600; t++) {
    const d = C.dateOf(t);
    const back = C.tickOf(d.year, d.month, d.day);
    if (back !== t) return `${t} → ${C.formatDate(t)} → ${back}`;
  }
  return true;
});

check('月の頭・年の頭・季節の頭を数え違えない（10年）', () => {
  let m = 0, y = 0, s = 0;
  for (let t = 0; t < 3600; t++) {
    if (C.isMonthStart(t)) m++;
    if (C.isYearStart(t)) y++;
    if (C.isSeasonStart(t)) s++;
  }
  return (m === 120 && y === 10 && s === 40) || `月${m} 年${y} 季${s}`;
});

check('Calendar.step() が節目を知らせる', () => {
  const cal = new C.Calendar(0);
  let m = 0, y = 0;
  for (let i = 0; i < 3600; i++) { const e = cal.step(); if (e.monthStart) m++; if (e.yearStart) y++; }
  if (cal.tick !== 3600) return `tick ${cal.tick}`;
  if (m !== 120 || y !== 10) return `月${m} 年${y}`;
  return eq(cal.year, 11);
});

check('advance でまとめて飛ばしても、またいだ回数が合う', () => {
  const cal = new C.Calendar(0);
  const r = cal.advance(3600 + 15);
  return (r.months === 120 && r.years === 10) || `月${r.months} 年${r.years}`;
});

check('壁時計を見ないで進む（Calendar は Date を知らない）', () => {
  const a = new C.Calendar(0), b = new C.Calendar(0);
  for (let i = 0; i < 500; i++) { a.step(); b.step(); }
  return eq(C.formatDate(a.tick), C.formatDate(b.tick));
});

check('年齢：月齢で持って歳に直す（18歳=216ヶ月・妊娠10ヶ月=300日）', () => {
  const birth = C.tickOf(1, 1, 1);
  if (C.ageMonths(birth + 300, birth) !== 10) return `妊娠 ${C.ageMonths(birth + 300, birth)}ヶ月`;
  if (C.yearsToMonths(18) !== 216) return '18歳が216ヶ月でない';
  if (C.ageYears(birth + 18 * 360, birth) !== 18) return '18年で18歳にならない';
  if (C.ageYears(birth + 18 * 360 - 1, birth) !== 17) return '誕生日の前日に歳を取っている';
  if (C.monthsToYears(C.ageMonths(birth + 40 * 360, birth)) !== 40) return '40歳が合わない';
  // 寿命70歳が Uint16 の月齢に収まるか
  return (C.yearsToMonths(70) < 65536) || '月齢が Uint16 を超える';
});

check('速さ：1倍で1日1分・60倍で1ヶ月30秒・1年6分', () => {
  if (C.msPerTick(1) !== 60000) return `1倍 ${C.msPerTick(1)}ms`;
  if (C.realSecondsPerMonth(60) !== 30) return `60倍 ${C.realSecondsPerMonth(60)}秒`;
  if (C.realSecondsPerMonth(60) * 12 !== 360) return '1年が6分でない';
  return (C.SPEED_MAX_RELEASE === 60 && C.SPEED_MAX_DEBUG === 500)
    || `${C.SPEED_MAX_RELEASE}/${C.SPEED_MAX_DEBUG}`;
});

// ===========================================================================
section('型付き配列（core/arrays.js）');
// ===========================================================================

const SPEC = {
  age: 'u16', sex: 'u8', house: 'u32', village: 'u16',
  rank: 'u8', post: 'u8', state: 'u32', wealth: 'f32', alive: 'u8',
  gene: 'f32*104', ev: 'f32*104',
};

check('確保できて、型が指定どおり', () => {
  const p = make(16, SPEC);
  if (!(p.age instanceof Uint16Array)) return 'age が Uint16Array でない';
  if (!(p.house instanceof Uint32Array)) return 'house が Uint32Array でない';
  if (!(p.wealth instanceof Float32Array)) return 'wealth が Float32Array でない';
  if (!Array.isArray(p.gene) || p.gene.length !== 104) return `gene が ${p.gene?.length} 本`;
  if (!(p.gene[103] instanceof Float32Array)) return 'gene[103] が Float32Array でない';
  return eq(p.cap, 16);
});

check('中身がゼロで始まる', () => {
  const p = make(64, SPEC);
  for (let i = 0; i < 64; i++) {
    if (p.age[i] !== 0 || p.wealth[i] !== 0) return `${i} が0でない`;
    for (let s = 0; s < 104; s++) if (p.gene[s][i] !== 0) return `gene[${s}][${i}] が0でない`;
  }
  return true;
});

check('alloc が連番を返し、足りなくなれば勝手に伸びる', () => {
  const p = make(4, SPEC);
  for (let i = 0; i < 1000; i++) {
    const at = p.alloc();
    if (at !== i) return `${i}回目が ${at}`;
  }
  if (p.len !== 1000) return `len ${p.len}`;
  return (p.cap >= 1000) || `cap ${p.cap}`;
});

check('拡張しても中身が壊れない（1万件）', () => {
  const p = make(8, SPEC);
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const at = p.alloc();
    p.age[at] = (i * 7) % 65536;
    p.house[at] = i * 3;
    p.wealth[at] = i * 0.5;
    p.gene[0][at] = i % 101;
    p.gene[103][at] = 100 - (i % 101);
  }
  for (let i = 0; i < N; i++) {
    if (p.age[i] !== (i * 7) % 65536) return `age[${i}]`;
    if (p.house[i] !== i * 3) return `house[${i}]`;
    if (p.wealth[i] !== i * 0.5) return `wealth[${i}]`;
    if (p.gene[0][i] !== i % 101) return `gene[0][${i}]`;
    if (p.gene[103][i] !== 100 - (i % 101)) return `gene[103][${i}]`;
  }
  return true;
});

check('伸ばしても添字が動かない（しがらみの辺が壊れない）', () => {
  const p = make(2, { alive: 'u8' });
  const ids = [];
  for (let i = 0; i < 500; i++) ids.push(p.alloc());
  for (const id of ids) p.alive[id] = 1;
  for (let i = 0; i < 500; i++) if (ids[i] !== i) return `${i}番の添字が ${ids[i]}`;
  return p.alive.slice(0, 500).every(v => v === 1) || '生存フラグが落ちた';
});

check('clear と copyRow が幅つきの列まで届く', () => {
  const p = make(8, SPEC);
  p.alloc(4);
  p.age[1] = 42; p.wealth[1] = 3.5;
  for (let s = 0; s < 104; s++) p.gene[s][1] = s + 1;
  p.copyRow(2, 1);
  if (p.age[2] !== 42 || p.wealth[2] !== 3.5) return '写せていない';
  for (let s = 0; s < 104; s++) if (p.gene[s][2] !== s + 1) return `gene[${s}] を写せていない`;
  p.clear(1);
  if (p.age[1] !== 0) return 'clear が効いていない';
  for (let s = 0; s < 104; s++) if (p.gene[s][1] !== 0) return `gene[${s}] が消えていない`;
  return true;
});

check('save/load の往復で中身が同じ', () => {
  const p = make(8, SPEC);
  const r = new RNG(3);
  for (let i = 0; i < 300; i++) {
    const at = p.alloc();
    p.age[at] = r.int(900); p.sex[at] = r.int(2);
    for (let s = 0; s < 104; s++) p.gene[s][at] = r.int(101);
  }
  const q = Store.load(p.save());
  if (q.len !== p.len) return `len ${q.len}`;
  for (let i = 0; i < p.len; i++) {
    if (q.age[i] !== p.age[i] || q.sex[i] !== p.sex[i]) return `${i} が違う`;
    for (let s = 0; s < 104; s++) if (q.gene[s][i] !== p.gene[s][i]) return `gene[${s}][${i}]`;
  }
  return true;
});

check('10万人ぶんの見積りが実測（86MB）と合う', () => {
  const p = make(100000, SPEC);
  const mb = p.bytes() / 1e6;
  // gene/ev が f32×104×2 = 832バイト、他が20バイトで 852バイト/人
  if (p.bytesPerRow() !== 852) return `1人 ${p.bytesPerRow()}バイト`;
  return (mb > 80 && mb < 92) || `${mb.toFixed(1)}MB`;
});

check('知らない型は投げて止まる', () => {
  try { make(4, { x: 'u7' }); return '通ってしまった'; } catch { /* 期待どおり */ }
  try { make(4, { x: 'f32*0' }); return '幅0が通ってしまった'; } catch { /* 期待どおり */ }
  return true;
});

check('growArray は1本だけ伸ばしても中身を保つ', () => {
  let a = new Int32Array(4);
  a[0] = 11; a[3] = 44;
  a = growArray(a, 100);
  return (a.length === 100 && a[0] === 11 && a[3] === 44 && a[99] === 0) || '壊れた';
});

// ===========================================================================
section('104ステ（core/stats.js）');
// ===========================================================================

check('104ステある（からだ50・あたま25・こころ29）', () => {
  if (S.COUNT !== 104) return `${S.COUNT}個`;
  if (S.NAME.length !== 104) return `名前が ${S.NAME.length}個`;
  const c = S.BY_CATEGORY.map(a => a.length);
  return (c[0] === 50 && c[1] === 25 && c[2] === 29) || c.join('/');
});

check('名前の重複がゼロ', () => {
  const seen = new Set();
  for (const n of S.NAME) {
    if (!n) return '空の名前がある';
    if (seen.has(n)) return `「${n}」が重複`;
    seen.add(n);
  }
  return eq(seen.size, 104);
});

check('腕の数が 52対52', () => {
  let a = 0, b = 0;
  for (let i = 0; i < S.COUNT; i++) (S.ARM[i] === S.ARM_A ? a++ : b++);
  return (a === 52 && b === 52) || `A${a} B${b}`;
});

check('染色体が1〜14で穴が無い', () => {
  const seen = new Set(S.CHROMOSOME);
  if (S.CHROMOSOME_COUNT !== 14) return `${S.CHROMOSOME_COUNT}本`;
  for (let c = 1; c <= 14; c++) if (!seen.has(c)) return `${c}番が空`;
  for (const c of S.CHROMOSOME) if (!(c >= 1 && c <= 14)) return `${c}番がある`;
  return true;
});

check('対は必ず両思いで、同じ染色体の反対の腕にある', () => {
  let pairs = 0;
  for (let i = 0; i < S.COUNT; i++) {
    const j = S.PAIR[i];
    if (j < 0) continue;
    pairs++;
    if (S.PAIR[j] !== i) return `${S.NAME[i]}→${S.NAME[j]} が片思い`;
    if (S.CHROMOSOME[i] !== S.CHROMOSOME[j]) return `${S.NAME[i]}と${S.NAME[j]}の染色体が違う`;
    if (S.ARM[i] === S.ARM[j]) return `${S.NAME[i]}と${S.NAME[j]}が同じ腕`;
  }
  return pairs > 0 || '対が1つも無い';
});

check('連鎖群が引ける（同じ腕・反対の腕）', () => {
  const id = S.needId('最大筋力');
  if (S.PAIR[id] !== S.idOf('敏捷')) return '最大筋力の対が敏捷でない';
  const linked = S.linkedWith(id);
  if (!linked.includes(id)) return '自分が同じ腕の一覧にいない';
  const opp = S.opposingArm(id);
  if (!opp.includes(S.idOf('敏捷'))) return '敏捷が反対の腕にいない';
  for (const k of linked) if (opp.includes(k)) return '同じステが両腕にいる';
  // 全部の腕を足すと104になる
  let n = 0;
  for (let c = 1; c <= S.CHROMOSOME_COUNT; c++) n += S.armMembers(c, 0).length + S.armMembers(c, 1).length;
  return eq(n, 104);
});

check('名前 ↔ 番号 の索引が往復する', () => {
  for (let i = 0; i < S.COUNT; i++) if (S.idOf(S.nameOf(i)) !== i) return `${S.NAME[i]}`;
  if (S.idOf('そんなステは無い') !== -1) return '無い名前が -1 を返さない';
  if (S.has('そんなステは無い')) return 'has が嘘をつく';
  try { S.needId('そんなステは無い'); return 'needId が投げない'; } catch { /* 期待どおり */ }
  return true;
});

check('段階の値が全部、表の中に収まっている', () => {
  const within = (arr, list, label) => {
    for (let i = 0; i < S.COUNT; i++) {
      const v = arr[i];
      if (!Number.isInteger(v) || v < 0 || v >= list.length) return `${S.NAME[i]} の${label} が ${v}`;
    }
    return true;
  };
  for (const [arr, list, label] of [
    [S.CATEGORY, S.CATEGORIES, '大項目'], [S.SUB, S.SUBCATEGORIES, '中項目'],
    [S.RARITY, S.RARITY_LEVELS, 'レア度'], [S.THRESHOLD, S.THRESHOLD_LEVELS, '閾値'],
    [S.GROWTH, S.GROWTH_LEVELS, '伸びしろ'], [S.INHERIT, S.INHERIT_MODES, '遺伝方式'],
    [S.HERITABILITY, S.HERITABILITY_LEVELS, '遺伝率'], [S.SEXLIMIT, S.SEXLIMIT_LEVELS, '性別限定'],
    [S.PLACE, S.PLACE_LEVELS, '伸びる場所'],
  ]) { const r = within(arr, list, label); if (r !== true) return r; }
  return true;
});

check('遺伝方式：からだ・あたまは中間遺伝、こころは優劣（A-5／A-20）', () => {
  for (let i = 0; i < S.COUNT; i++) {
    const want = S.CATEGORY[i] === S.HEART ? S.DOMINANT : S.BLEND;
    if (S.INHERIT[i] !== want) return `${S.NAME[i]}（${S.categoryOf(i)}）が ${S.inheritOf(i)}`;
  }
  return true;
});

check('閾値と伸びしろは こころ にだけ「該当なし」（29個）', () => {
  let n = 0;
  for (let i = 0; i < S.COUNT; i++) {
    const noT = S.THRESHOLD[i] === 0, noG = S.GROWTH[i] === 0;
    if (noT !== noG) return `${S.NAME[i]} で閾値と伸びしろの該当なしがずれている`;
    if (noT) {
      n++;
      if (S.CATEGORY[i] !== S.HEART) return `${S.NAME[i]} は${S.categoryOf(i)}なのに該当なし`;
      if (S.thresholdOf(i) !== S.THRESHOLD_NONE) return `${S.NAME[i]} の閾値が数になっている`;
    }
  }
  return eq(n, 29);
});

check('閾値の数が A-5 の刻み（0/15/50/80/95）に乗っている', () => {
  const want = [-1, 0, 15, 50, 80, 95];
  if (S.THRESHOLD_VALUE.join() !== want.join()) return S.THRESHOLD_VALUE.join('/');
  // 「なし」は誰でも積める。「非常に高い」は生まれつき持たない者は一生伸びない
  const none = S.STATS.filter(s => s.threshold === 'なし');
  const vhigh = S.STATS.filter(s => s.threshold === '非常に高い');
  if (!none.every(s => S.canTrain(s.id, 0))) return '「なし」で才能0が積めない';
  if (vhigh.some(s => S.canTrain(s.id, 94))) return '「非常に高い」で才能94が積めている';
  if (!vhigh.every(s => S.canTrain(s.id, 95))) return '「非常に高い」で才能95が積めない';
  return (vhigh.length === 8) || `非常に高いが ${vhigh.length}個（8個のはず）`;
});

check('こころは努力では積まれない（該当なしは才能100でも false）', () => {
  for (const s of S.STATS) {
    if (s.threshold !== '該当なし') continue;
    if (S.canTrain(s.id, 100)) return `${s.name} が積めてしまう`;
  }
  return true;
});

check('性別限定は女3つだけ（お産の軽さ・乳の出・双子の生まれやすさ）', () => {
  const f = S.STATS.filter(s => s.sexLimit === '女のみ').map(s => s.name);
  if (f.length !== 3) return f.join('/');
  for (const n of ['お産の軽さ', '乳の出', '双子の生まれやすさ']) {
    if (!f.includes(n)) return `${n} が入っていない`;
  }
  const id = S.needId('乳の出');
  if (S.appliesToSex(id, 0)) return '男に乳の出が付いている';
  if (!S.appliesToSex(id, 1)) return '女に乳の出が付いていない';
  return true;
});

check('仮の数値の表が壊れていない（伸びしろ・遺伝率・伸びる場所）', () => {
  if (S.GROWTH_ROOM.length !== S.GROWTH_LEVELS.length) return '伸びしろの表の長さが違う';
  if (S.HERITABILITY_VALUE.length !== S.HERITABILITY_LEVELS.length) return '遺伝率の表の長さが違う';
  for (const v of S.HERITABILITY_VALUE) if (!(v > 0 && v < 1)) return `遺伝率 ${v}`;
  for (let i = 1; i < S.GROWTH_ROOM.length; i++) {
    if (!(S.GROWTH_ROOM[i] > S.GROWTH_ROOM[i - 1])) return '伸びしろが単調でない';
  }
  if (S.PLACE_MULTIPLIER.length !== S.PLACE_LEVELS.length) return '伸びる場所の表の長さが違う';
  // 中央で伸びるステは中央のほうが速い。辺境は逆。両方が居ないと選択が消える
  const c = S.PLACE_MULTIPLIER[S.PLACE_CENTER], f = S.PLACE_MULTIPLIER[S.PLACE_FRONTIER];
  if (!(c[S.WHERE_CENTER] > c[S.WHERE_FRONTIER])) return '中央のステが中央で速くない';
  if (!(f[S.WHERE_FRONTIER] > f[S.WHERE_CENTER])) return '辺境のステが辺境で速くない';
  const counts = S.PLACE_LEVELS.map((_, k) => S.PLACE.filter(p => p === k).length);
  return counts.every(n => n > 0) || `伸びる場所の偏り ${counts.join('/')}`;
});

check('生成物が いまの CSV と一致している', () => {
  const csv = join(ROOT, 'docs', 'v3', 'stats_v3.csv');
  let buf;
  try { buf = readFileSync(csv); }
  catch { return `${S.SOURCE} が見つからない`; }
  const sha = createHash('sha256').update(buf).digest('hex');
  return sha === S.SOURCE_SHA256
    ? true
    : 'CSV が変わっている。node game2/tools/gen-stats.mjs を走らせ直すこと';
});

check('STATS（1件ずつの姿）が列と食い違わない', () => {
  if (S.STATS.length !== S.COUNT) return `${S.STATS.length}件`;
  for (const s of S.STATS) {
    if (s.name !== S.NAME[s.id]) return `${s.id} の名前`;
    if (s.chromosome !== S.CHROMOSOME[s.id]) return `${s.name} の染色体`;
    if (s.rarity !== S.rarityOf(s.id)) return `${s.name} のレア度`;
    if (s.pairName !== (s.pair >= 0 ? S.NAME[s.pair] : null)) return `${s.name} の対`;
  }
  try { S.STATS[0].name = 'x'; } catch { /* 凍っているなら投げる */ }
  return (S.STATS[0].name === S.NAME[0]) || '書き換えられてしまった';
});

// ===========================================================================
section('掟（src/ 全体）');
// ===========================================================================

function srcFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}
const FILES = srcFiles(join(GAME2, 'src'));

// コメントを落としてから見る。「Math.random() を使わないこと」と書いた注意書きで
// 赤になっては困る
function code(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

check('Math.random() を1つも書いていない', () => {
  const bad = FILES.filter(f => /Math\.random\s*\(/.test(code(f)));
  return bad.length === 0 || bad.map(f => relative(GAME2, f)).join(' ');
});

check('Date.now() / new Date に依存した挙動が無い', () => {
  const bad = FILES.filter(f => /Date\.now\s*\(|new\s+Date\s*\(/.test(code(f)));
  return bad.length === 0 || bad.map(f => relative(GAME2, f)).join(' ');
});

check('core は上位（world/flow/ui）を import していない', () => {
  const core = FILES.filter(f => f.includes(`${'/'}core${'/'}`));
  for (const f of core) {
    const src = code(f);
    const m = src.match(/from\s+['"]([^'"]+)['"]/g) || [];
    for (const s of m) {
      if (/\/(world|flow|ui)\//.test(s)) return `${relative(GAME2, f)} が ${s}`;
    }
  }
  return true;
});

check('core は DOM も window も知らない', () => {
  const core = FILES.filter(f => f.includes(`${'/'}core${'/'}`));
  const bad = core.filter(f => /\b(document|window|localStorage|requestAnimationFrame)\b/.test(code(f)));
  return bad.length === 0 || bad.map(f => relative(GAME2, f)).join(' ');
});

check('生成物は手で直さない印が入っている', () => {
  const gen = FILES.filter(f => f.endsWith('.gen.js'));
  if (gen.length === 0) return '生成物が無い';
  const bad = gen.filter(f => !readFileSync(f, 'utf8').startsWith('// 自動生成'));
  return bad.length === 0 || bad.map(f => relative(GAME2, f)).join(' ');
});

// ===========================================================================
const total = pass + fail;
console.log(`\n${fail === 0 ? GREEN : RED} ${pass}/${total} 緑`);
process.exit(fail === 0 ? 0 : 1);
