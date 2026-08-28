// 継ぎ目の検査台。node game2/test/check.js
//
// 旧版の教訓：「sim単体とUI単体をいくら検証しても、繋いだ状態は検証されない。
// 13項目が緑のままゲームが起動していなかった」。
// だから検査台を先に作る。中身は旧版の23項目を捨てて、新しく起こす。
//
// いまは土台（core）だけ。world/flow/ui が生えたら、ここに足していく。
// 1項目1行で緑/赤を出し、最後に n/m 緑 を出す。

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RNG, rng } from '../src/core/rng.js';
import * as R from '../src/core/rng.js';
import * as COND from '../src/world/condition.js';
import * as D from '../src/world/desire.js';
import * as REP from '../src/world/reputation.js';
import * as DIS from '../src/world/discontent.js';
import * as C from '../src/core/calendar.js';
import { make, Store, growArray } from '../src/core/arrays.js';
import * as S from '../src/core/stats.js';
import * as P from '../src/world/people.js';
import * as G from '../src/world/genetics.js';
import * as V from '../src/world/village.js';
import * as grow from '../src/world/grow.js';
import * as M from '../src/world/marry.js';
import * as W from '../src/world/world.js';
import * as RUN from '../src/flow/run.js';
import * as GIFT from '../src/world/gifts.js';
import * as GG from '../src/core/gifts.gen.js';

// ★ 検査が「N年生き延びた世界」を要るとき、種を直書きしない。
//   世界は層を足すたびに厳しくなるので、直書きの種はそのたびに絶滅世界に変わり、
//   本題と関係ない検査が3件も4件も赤くなる（今日だけで2度起きた）。
//   **要件のほうを書く。**同じ並びを同じ順で試すので決定的（再現性は落ちない）。
const LIVING_SEEDS = [13, 1, 5, 9, 17, 19, 10, 7, 21, 25, 3, 29];
function livingWorld(years, minPop = 1) {
  for (const seed of LIVING_SEEDS) {
    const w = new W.World(seed).genesis();
    w.runYears(years);
    if (w.population() >= minPop) return w;
  }
  throw new Error(`${years}年 生き延びる種が ${LIVING_SEEDS.length} 通りの中に無い`);
}


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

check('速さ：×1で1ヶ月10分・×10で1ヶ月1分', () => {
  if (C.realSecondsPerMonth(1) !== 600) return `×1 ${C.realSecondsPerMonth(1)}秒`;
  if (C.realSecondsPerMonth(10) !== 60) return `×10 ${C.realSecondsPerMonth(10)}秒`;
  if (C.realSecondsPerMonth(10) * 12 !== 720) return '×10 の1年が12分でない';
  if (C.OFFLINE_SPEED !== 1) return `オフラインが ×${C.OFFLINE_SPEED}`;
  if (C.OFFLINE_MAX_HOURS !== 24) return `オフラインの上限が ${C.OFFLINE_MAX_HOURS}時間`;
  return (C.SPEED_MAX_RELEASE === 10 && C.SPEED_MAX_DEBUG === 500)
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
section('106ステ（core/stats.js）');
// ===========================================================================

// ★ N-22（106化）。105個目＝人をまとめる素質（11番A・B）／106個目＝規範意識（14番B・D）
check('106ステある（からだ50・あたま25・こころ31）', () => {
  if (S.COUNT !== 106) return `${S.COUNT}個`;
  if (S.NAME.length !== 106) return `名前が ${S.NAME.length}個`;
  const c = S.BY_CATEGORY.map(a => a.length);
  if (!(c[0] === 50 && c[1] === 25 && c[2] === 31)) return c.join('/');
  // 正典2-1 が名指しした2本が、名指しされた席に居ること
  for (const [name, ch, arm, rar] of [['人をまとめる素質', 11, 0, 'B'], ['規範意識', 14, 1, 'D']]) {
    const i = S.idOf(name);
    if (i < 0) return `${name} が無い`;
    if (S.CHROMOSOME[i] !== ch) return `${name} が ${S.CHROMOSOME[i]}番`;
    if (S.ARM[i] !== arm) return `${name} の腕が違う`;
    if (S.RARITY_LEVELS[S.RARITY[i]] !== rar) return `${name} のレア度が ${S.RARITY_LEVELS[S.RARITY[i]]}`;
    if (S.CATEGORY[i] !== S.HEART) return `${name} が こころ でない`;
  }
  return true;
});

check('名前の重複がゼロ', () => {
  const seen = new Set();
  for (const n of S.NAME) {
    if (!n) return '空の名前がある';
    if (seen.has(n)) return `「${n}」が重複`;
    seen.add(n);
  }
  return eq(seen.size, S.COUNT);
});

// 104ステで52対52。N-22 で 11番A と 14番B に1本ずつ入ったので 53対53
check('腕の数が 53対53', () => {
  let a = 0, b = 0;
  for (let i = 0; i < S.COUNT; i++) (S.ARM[i] === S.ARM_A ? a++ : b++);
  return (a === 53 && b === 53) || `A${a} B${b}`;
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
  // 全部の腕を足すとステの総数になる
  let n = 0;
  for (let c = 1; c <= S.CHROMOSOME_COUNT; c++) n += S.armMembers(c, 0).length + S.armMembers(c, 1).length;
  return eq(n, S.COUNT);
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

check('閾値と伸びしろは こころ にだけ「該当なし」（31個）', () => {
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
  // こころ全部が「該当なし」であること。数を直書きしない（N-22 で29→31に増えた）
  return eq(n, S.BY_CATEGORY[S.HEART].length);
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
//  ここから世界（world/）。個体・家・村・成長・結婚出産・遺伝
// ===========================================================================

// 才能をそろえた1人だけの器。grow の式を素で確かめるのに使う
function loner(talent, ageYears) {
  const p = new P.People(1);
  const i = p.spawn(0);
  for (let s = 0; s < S.COUNT; s++) p.a.gene[s][i] = talent;
  p.a.ageMonths[i] = ageYears * 12;
  p.a.lifespan[i] = 55;
  return p;
}

// 上位20%だけを親にして N 体・G世代まわす。確定事項 A-5／A-18 の実測の再現。
// linked=false にすると対抗アーム予算（＝連鎖群）を外す。外すと世界が終わることを見る。
function selectiveBreed(N, gens, seed, linked, targets = null) {
  const saved = [...G.ARM_EXEMPT];
  // 連鎖ありのときは ARM_EXEMPT に触らない（本物の設定のまま測る）。
  // 連鎖なしのときだけ全染色体を予算の対象外にして、あとで元へ戻す
  if (!linked) for (let c = 1; c <= S.CHROMOSOME_COUNT; c++) G.ARM_EXEMPT.add(c);
  const r = new RNG(seed);
  const p = new P.People(N * (gens + 2));
  const score = (i) => {
    let s = 0;
    if (targets) { for (const t of targets) s += p.a.gene[t][i]; }
    else for (let k = 0; k < S.COUNT; k++) s += p.a.gene[k][i];
    return s;
  };
  let cur = [];
  for (let k = 0; k < N; k++) { const i = p.spawn(0); G.foundGenome(p, i, r); cur.push(i); }
  for (let g = 0; g < gens; g++) {
    const sc = cur.map(i => [i, score(i)]).sort((a, b) => b[1] - a[1]);
    const top = sc.slice(0, Math.max(2, Math.floor(N * 0.2))).map(x => x[0]);
    const next = [];
    for (let k = 0; k < N; k++) {
      const f = top[r.int(top.length)];
      let m = top[r.int(top.length)];
      if (m === f) m = top[(top.indexOf(f) + 1) % top.length];
      const c = p.spawn(0); G.breed(p, c, f, m, r); next.push(c);
    }
    for (const i of cur) p.kill(i, 0);
    cur = next;
  }
  G.ARM_EXEMPT.clear();
  for (const c of saved) G.ARM_EXEMPT.add(c);
  let best = cur[0], bs = -Infinity, popMean = 0;
  for (const i of cur) { const v = score(i); if (v > bs) { bs = v; best = i; } }
  for (const i of cur) { let s = 0; for (let k = 0; k < S.COUNT; k++) s += p.a.gene[k][i]; popMean += s / S.COUNT; }
  popMean /= cur.length;
  const tset = new Set(targets || []);
  let above80 = 0, below40 = 0, tSum = 0, oSum = 0, oN = 0;
  for (let k = 0; k < S.COUNT; k++) {
    const v = p.a.gene[k][best];
    if (v >= 80) above80++;
    if (v < 40) below40++;
    if (tset.has(k)) tSum += v; else { oSum += v; oN++; }
  }
  return {
    above80, below40, popMean,
    targetMean: targets ? tSum / targets.length : null,
    otherMean: oSum / oN,
    bestMean: (tSum + oSum) / S.COUNT,
  };
}

const breedResult = {};
const hundredYear = {};
// ===========================================================================
section('個体（world/people.js）');
// ===========================================================================

check('十匹が立つ。女は5人、家は5軒、うち3人が身ごもっている', () => {
  const w = new W.World(1).genesis();
  const s = w.summary();
  if (s.pop !== 10) return `人口 ${s.pop}`;
  if (s.women !== W.GENESIS_WOMEN) return `女 ${s.women}`;
  if (s.houses !== 5) return `家 ${s.houses}軒`;
  if (s.pregnant !== W.GENESIS_PREGNANT) return `妊娠 ${s.pregnant}人`;
  return true;
});

check('十匹の妊娠は2ヶ月ずつずれている（出産が3回起きる）', () => {
  const w = new W.World(1).genesis();
  const due = [];
  for (const i of w.people.living()) if (w.people.a.pregDue[i] >= 0) due.push(w.people.a.pregDue[i]);
  due.sort((a, b) => a - b);
  if (due.length !== 3) return `${due.length}人`;
  const gap = C.DAYS_PER_MONTH * W.GENESIS_STAGGER_MONTHS;
  if (due[1] - due[0] !== gap || due[2] - due[1] !== gap) return `間隔 ${due.join(',')}`;
  return true;
});

check('歳を取る（1年で12ヶ月ぶん・月齢で持つ）', () => {
  const w = new W.World(1).genesis();
  const i = [...w.people.living()][0];
  const before = w.people.a.ageMonths[i];
  w.runYears(1);
  const got = w.people.a.ageMonths[i] - before;
  return got === 12 ? true : `1年で ${got}ヶ月`;
});

check('死ぬ（100年も回せば創世の十匹は1人も残らない）', () => {
  const w = new W.World(1).genesis();
  w.runYears(100);
  for (let i = 0; i < 10; i++) if (w.people.a.alive[i]) return `${i}番が生きている`;
  for (let i = 0; i < 10; i++) if (w.people.a.deathTick[i] < 0) return `${i}番に死んだ日が無い`;
  return true;
});

check('死んでも添字は動かない（しがらみの辺が壊れない）', () => {
  const w = new W.World(1).genesis();
  const born = [];
  w.runYears(40);
  for (let i = 0; i < w.people.len; i++) born.push(w.people.a.birthTick[i]);
  w.runYears(40);
  for (let i = 0; i < born.length; i++) {
    if (w.people.a.birthTick[i] !== born[i]) return `${i}番の生まれた日が動いた`;
  }
  return true;
});

check('実効値 ＝（才能 ＋ 努力値）× デバフ（A-4）', () => {
  const w = new W.World(1).genesis();
  const i = [...w.people.living()][0];
  const s = S.needId('最大筋力');
  w.people.a.ev[s][i] = 12.5;
  const want = (w.people.a.gene[s][i] + 12.5) * w.people.debuff(i, s);
  const got = w.people.effective(i, s);
  return Math.abs(got - want) < 1e-9 ? true : `${got} ≠ ${want}`;
});

check('デバフは素の値を汚さない（才能は動かない）', () => {
  const w = new W.World(1).genesis();
  const i = [...w.people.living()][0];
  const s = S.needId('持久力');
  const before = w.people.a.gene[s][i];
  w.people.a.state[i] |= P.ST_HUNGRY | P.ST_SICK;
  w.people.effective(i, s);
  return w.people.a.gene[s][i] === before ? true : '才能が動いた';
});

// ★ B-2 は決着した（正典 第7部 §1）。旧 DEBUFF_FLOOR = 0.25 は**廃止**。
//   永続に床は無く、一時7個にだけ枠別のソフト床 f が掛かる。
//   硬い床の代わりに守るのは「**順序がどの深さでも保存される**」こと。
check('床が老人の順序を潰さない（B-2 決着：硬い床0.25の廃止）', () => {
  const w = new W.World(1).genesis();
  const A = w.people.a;
  const s = S.needId('最大筋力');
  const at = (i, opts) => {
    A.ageMonths[i] = 55 * 12; A.lifespan[i] = 55;
    A.state[i] = 0; A.sickStage[i] = 0; A.hurtStage[i] = 0; A.grief[i] = 0;
    if (opts.sick) A.sickStage[i] = opts.sick;
    if (opts.hurt) A.hurtStage[i] = opts.hurt;
    if (opts.grief) A.grief[i] = opts.grief;
    return w.people.debuff(i, s);
  };
  const i = [...w.people.living()][0];
  const healthy = at(i, {});
  const dying = at(i, { sick: 3, hurt: 3, grief: 0.9 });
  if (P.DEBUFF_FLOOR !== undefined) return '旧 DEBUFF_FLOOR がまだ生きている';
  // 硬い床0.30 なら健康な55歳も瀕死の55歳も 0.300 で潰れて区別がつかなくなる
  if (!(dying < healthy)) return `瀕死 ${dying.toFixed(4)} が健康 ${healthy.toFixed(4)} を下回らない`;
  if (Math.abs(dying - healthy) < 0.01) return `${dying.toFixed(4)} と ${healthy.toFixed(4)} が潰れている`;
  // ソフト床は単調なので、深さを増やすほど必ず下がる。
  // ★ 状態ごとに効く枠が違うので、その枠で測る（喪は からだ に×1.00 なので筋力では動かない）
  let prev = healthy;
  for (const k of [1, 2, 3]) {
    const v = at(i, { sick: k });
    if (!(v < prev)) return `病 段${k} で からだ の順序が壊れた`;
    prev = v;
  }
  const amb = S.needId('野心');                    // こころ。喪はここに効く
  at(i, {});
  let prevH = w.people.debuff(i, amb);
  for (const g of [0.3, 0.6, 0.9]) {
    at(i, { grief: g });
    const v = w.people.debuff(i, amb);
    if (!(v < prevH)) return `喪 ${g} で こころ の順序が壊れた（${v.toFixed(4)} ≧ ${prevH.toFixed(4)}）`;
    prevH = v;
  }
  return true;
});

// ★ 老いは からだ だけではなくなった（第7部 §1 永続1）。
//   からだ 1−0.85t^p ／ あたま 1−0.45t^(p+0.8)（遅く始まり浅く落ちる）／ こころ ×1.00
check('老いは こころ に掛からない（長老を抱える国は社会的に強い）', () => {
  const w = new W.World(1).genesis();
  const A = w.people.a;
  const i = [...w.people.living()][0];
  A.ageMonths[i] = 50 * 12; A.lifespan[i] = 55; A.state[i] = 0;
  const body = w.people.debuff(i, S.needId('最大筋力'));
  const mind = w.people.debuff(i, S.needId('論理'));
  const heart = w.people.debuff(i, S.needId('野心'));
  if (heart !== 1) return `こころ ${heart}（1.00 のはず）`;
  if (!(body < mind)) return `からだ ${body.toFixed(3)} があたま ${mind.toFixed(3)} より落ちていない`;
  if (!(mind < 1)) return `あたま ${mind} が落ちていない`;
  return true;
});

// ★ この検査が、状態12個の器が正典どおりであることの証拠（第7部 §1 の検算表そのもの）。
//   赤くなったら、実効値の器が正典から外れている ＝ 産出・国民力・不満の入力が全部ずれている。
check('**状態12個の倍率表が正典の検算9行と一致する**（第7部 §1）', () => {
  const ID = {
    速さ: S.needId('老いの速さ'), 飢: S.needId('飢えへの強さ'), 病: S.needId('病への強さ'),
    走力: S.needId('走力'), 視力: S.needId('視力'),
  };
  const make = (age, life, o = {}) => {
    const pp = new P.People(4); pp.tickNow = 0;
    const i = pp.spawn(0), A = pp.a;
    A.alive[i] = 1; A.ageMonths[i] = Math.round(age * 12); A.lifespan[i] = life;
    for (let k = 0; k < S.COUNT; k++) { A.gene[k][i] = 50; A.ev[k][i] = 0; }
    A.gene[ID.速さ][i] = 34;                      // 母集団の中央。AGE_POW がそのまま出る
    A.gene[ID.飢][i] = 42; A.gene[ID.病][i] = 42;  // レアCの中央（緩和の入力）
    if (o.scar) { A.scarPart[0][i] = o.scar[0]; A.scarW[0][i] = o.scar[1]; }
    if (o.hunger) { A.state[i] |= P.ST_HUNGRY; A.hungerMonths[i] = o.hunger; }
    if (o.sick) A.sickStage[i] = o.sick;
    if (o.hurt) A.hurtStage[i] = o.hurt;
    if (o.fatigue) A.fatigue[i] = o.fatigue;
    if (o.grief) A.grief[i] = o.grief;
    if (o.preg) { A.state[i] |= P.ST_PREGNANT; A.pregDue[i] = Math.round((10 - o.preg) * 30); }
    return [pp, i];
  };
  const out = [0, 0, 0];
  const M = (pp, i) => COND.frames(pp, i, out).slice();
  const near = (a, b) => Math.abs(a - b) < 0.0015;

  const rows = [
    ['健康な30歳・寿命55',  M(...make(30, 55)),                              [0.947, 0.994, 1.000]],
    ['8歳・健康',           M(...make(8, 55)),                               [0.493, 1.000, 1.000]],
    ['45歳・寿命55',        M(...make(45, 55)),                              [0.530, 0.822, 1.000]],
    ['健康な55歳(t=1)',     M(...make(55, 55)),                              [0.150, 0.550, 1.000]],
    ['45歳・眼の古傷w2',    M(...make(45, 55, { scar: [COND.PART_EYE, 2] })), [0.488, 0.790, 1.000]],
    // ★ 正典の検算表はこの行だけ「緩和を からだ にしか当てていない」誤りがあり、
    //   0.753/0.886 と書かれていた。共通の緩和（全枠）で引き直した値が下（2026-08-28 訂正）
    ['30歳・欠乏w2＋疲労w2', M(...make(30, 55, { hunger: 4, fatigue: 7 })),   [0.689, 0.766, 0.894]],
    ['55歳・疫病＋重傷＋喪.9', M(...make(55, 55, { sick: 3, hurt: 3, grief: 0.9 })), [0.062, 0.404, 0.743]],
  ];
  for (const [name, got, want] of rows) {
    for (let k = 0; k < 3; k++) {
      if (!near(got[k], want[k])) {
        return `${name} の${['からだ', 'あたま', 'こころ'][k]} が ${got[k].toFixed(4)}（正典 ${want[k]}）`;
      }
    }
  }
  // 例外倍率（M[枠] の外に掛かる）
  let [pp, i] = make(45, 55, { scar: [COND.PART_EYE, 2] });
  if (!near(pp.debuff(i, ID.視力), 0.309)) return `眼の古傷w2 の視力 ${pp.debuff(i, ID.視力).toFixed(4)}（正典 0.309）`;
  [pp, i] = make(30, 55, { preg: 9 });
  if (!near(pp.debuff(i, ID.走力), 0.530)) return `妊娠後期の走力 ${pp.debuff(i, ID.走力).toFixed(4)}（正典 0.530）`;
  return true;
});

// ★ 柱7の当たりと塞ぎ1：疲労は働いた月にしか溜まらず、負荷1.0 が中央値の均衡点。
//   実効値を最大化する配置（低負荷）と産出を最大化する配置（高負荷）が同じ手にならない。
check('疲労は負荷1.0 が中央値の均衡点（壊れるのは眠りの浅い者だけ）', () => {
  const ID = { 抜け: S.needId('疲労の抜けやすさ'), 睡眠: S.needId('必要睡眠') };
  const net = (drainStat, sleep, load) => {
    const pp = new P.People(2); pp.tickNow = 0;
    const i = pp.spawn(0), A = pp.a;
    A.alive[i] = 1; A.ageMonths[i] = 30 * 12; A.lifespan[i] = 55;
    for (let k = 0; k < S.COUNT; k++) { A.gene[k][i] = 50; A.ev[k][i] = 0; }
    A.gene[ID.抜け][i] = drainStat; A.gene[ID.睡眠][i] = sleep;
    A.fatigue[i] = 6;                      // 床にも天井にも当たらない位置から測る
    COND.fatigueMonth(pp, i, load);
    return A.fatigue[i] - 6;
  };
  // 中央（抜けやすさ34=B／必要睡眠48=D）。正典「抜けは 2.656/月・負荷1.0 で net −0.056」
  const idle = net(34, 48, 0);
  if (Math.abs(idle + 2.656) > 0.002) return `中央の抜けが ${(-idle).toFixed(3)}（正典 2.656）`;
  const mid = net(34, 48, COND.LOAD_NORMAL);
  if (Math.abs(mid + 0.056) > 0.002) return `中央・負荷1.0 の net が ${mid.toFixed(3)}（正典 −0.056）`;
  // 帯の下端（抜けやすさ15・必要睡眠66）は負荷1.0 でも +0.91/月 で壊れる
  const weak = net(15, 66, COND.LOAD_NORMAL);
  if (Math.abs(weak - 0.907) > 0.003) return `眠りの浅い者の net が ${weak.toFixed(3)}（正典 +0.91）`;
  // 非番なら誰でも抜ける（働いた月にしか溜まらない）
  if (!(net(15, 66, COND.LOAD_IDLE) < 0)) return '非番なのに疲労が溜まる';
  // 段の切れ目は 3/6/10
  if (COND.fatigueStage(2.9) !== 0 || COND.fatigueStage(3) !== 1
      || COND.fatigueStage(6) !== 2 || COND.fatigueStage(10) !== 3) return '段の切れ目が 3/6/10 でない';
  return true;
});

// ★ 12枠のうち、供給源が在るものが実際に発火していること。
//   器だけ作って誰も書かない状態（ST_SICK・ST_GRIEF・scar が長らくそうだった）を二度と作らない
check('状態に供給源が繋がっている（器が空回りしていない）', () => {
  const w = livingWorld(60, 5);
  const A = w.people.a;
  let defect = 0, grief = 0, fatigue = 0, barren = 0;
  for (let i = 0; i < A.len; i++) {
    if (A.defectType[i]) defect++;
    if (A.state[i] & P.ST_BARREN) barren++;
    if (!A.alive[i]) continue;
    if (A.grief[i] > 0) grief++;
    if (A.fatigue[i] > 0) fatigue++;
  }
  if (!defect) return '先天障害が60年で1件も出ない（永続3の供給源が無い）';
  if (!fatigue) return '疲労が1人も溜まらない（一時9の供給源が無い）';
  // ★ 喪は瞬間で数えない。τ≈5.8ヶ月で薄れるので、ある月に生きている者を見ても0のことがある。
  //   供給源が在るかを見たいのだから、**のべ回数**で見る
  if (!w.counters.mourned) return '喪が1件も立たない（一時12の供給源が無い）';
  void grief;
  // ★ 病と負傷は、まだ供給源が無い（厄災 #9 と戦争が入る日に生きる）。器は在る
  return true;
});

check('年齢曲線が A-6 の表7点に合う（ピーク26歳固定）', () => {
  // 確定事項 A-6 の表。誤差2%まで。老いの速さ34（母集団の中央）で引く
  const out = [0, 0, 0];
  const table = [
    [40, 35, 0.54], [55, 35, 0.83], [70, 35, 0.91],
    [55, 45, 0.53], [70, 45, 0.74],
    [55, 55, 0.15], [70, 55, 0.53],
  ];
  for (const [life, age, want] of table) {
    const got = COND.aging(age, life, 34, out)[0];
    if (Math.abs(got - want) > 0.02) return `寿命${life}・${age}歳 → ${got.toFixed(3)}（表は${want}）`;
  }
  for (const life of [40, 55, 70]) {
    if (Math.abs(COND.aging(26, life, 34, out)[0] - 1) > 1e-9) return `寿命${life}の26歳が100%でない`;
  }
  // 老いの速さは 34 で AGE_POW ちょうど。0（ゆっくり）と100（急）で挟む
  const slow = COND.aging(45, 55, 0, out)[0], mid = COND.aging(45, 55, 34, out)[0];
  const fast = COND.aging(45, 55, 100, out)[0];
  if (!(fast < mid && mid < slow)) return `速さの向きが逆（${fast.toFixed(3)}/${mid.toFixed(3)}/${slow.toFixed(3)}）`;
  return true;
});

check('寿命は40〜70・平均55（乱数ではなく寿命ステから出る）', () => {
  const w = new W.World(7).genesis();
  const R = new RNG(99);
  const base = [], real = [];
  for (let k = 0; k < 600; k++) {
    const i = w.people.spawn(0);
    G.foundGenome(w.people, i, R);
    base.push(P.baseLifespanOf(w.people, i));
    real.push(P.lifespanOf(w.people, i));
  }
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const lo = Math.min(...base), hi = Math.max(...base);
  if (lo < P.LIFESPAN_MIN || hi > P.LIFESPAN_MAX) return `幅 ${lo}〜${hi}`;
  if (Math.abs(mean - 55) > 2) return `平均 ${mean.toFixed(1)}`;
  // 遺伝的荷重は寿命を縮めることしかしない
  for (let k = 0; k < base.length; k++) if (real[k] > base[k]) return '荷重で寿命が伸びた';
  return true;
});

check('死亡率の表が確定事項のまま入っている（中世並）', () => {
  const want = [[0, 0.20], [2, 0.06], [10, 0.012], [25, 0.010], [45, 0.020], [60, 0.050]];
  for (const [age, r] of want) {
    if (P.annualDeathRate(age) !== r) return `${age}歳 ${P.annualDeathRate(age)} ≠ ${r}`;
  }
  // 月率を12回かけると年率に戻る
  const m = P.monthlyDeathRate(0);
  const y = 1 - Math.pow(1 - m, 12);
  return Math.abs(y - 0.20) < 1e-9 ? true : `12ヶ月で ${y}`;
});

// ===========================================================================
section('遺伝（world/genetics.js）');
// ===========================================================================

check('からだ・あたま＝中間遺伝、こころ＝優劣（A-5／A-20）', () => {
  for (let s = 0; s < S.COUNT; s++) {
    const want = S.CATEGORY[s] === S.HEART ? S.DOMINANT : S.BLEND;
    if (S.INHERIT[s] !== want) return `${S.NAME[s]}`;
    if (G.isDominantMode(s) !== (want === S.DOMINANT)) return `${S.NAME[s]} の判定`;
  }
  return true;
});

check('対抗アーム予算（平均A＋平均B＝100）が中間遺伝の染色体で厳密に成立する', () => {
  // からだ・あたま（1〜9番・全部中間遺伝）。表現型が(a+b)/2なので予算が素通りする。
  // seed を1つだけで測ると、たまたま綺麗な世界を引いて緑になる。6通り回す。
  // ★ 平均のずれで見る。個体ごとの厳密さは下の検査が「張り付きの有無」で切り分ける
  let sum = 0, n = 0;
  for (const seed of [3, 4, 5, 6, 7, 8]) {
    const w = new W.World(seed).genesis();
    w.runYears(60);
    const A = w.people.a;
    for (const i of w.people.living()) {
      for (let c = 1; c <= S.CHROMOSOME_COUNT; c++) {
        const a = S.BY_ARM[c][0], b = S.BY_ARM[c][1];
        if (!a.length || !b.length) continue;
        if (a.concat(b).some(s => S.INHERIT[s] === S.DOMINANT)) continue;  // こころは下で別に測る
        let ma = 0, mb = 0;
        for (const s of a) ma += A.gene[s][i];
        for (const s of b) mb += A.gene[s][i];
        sum += Math.abs(ma / a.length + mb / b.length - G.ARM_BUDGET); n++;
      }
    }
  }
  const mean = n ? sum / n : 0;
  return mean < 0.05 ? true : `平均で ${mean.toFixed(4)} ずれている（${n}組）`;
});

// ★ 2026-08-28。上の検査は「たまたま張り付きの無い種を引いていたから」緑だった。
//   予算の等式は **normalizeArms の clampV（0〜100に収める）に負ける。**
//   スケールを掛けたあと天井/床に当たった座位があると、その染色体だけ等式が崩れる。
//   実測（6種×60年・個体×染色体 1,215組）：
//     張り付きが無い染色体 … 最大ずれ **0.000003**（浮動小数点の精度そのもの＝厳密に成立）
//     張り付きがある染色体 … 最大ずれ **1.62**
//   本当の不変条件はこちら。係数を緩めるのではなく、条件を正しく書く。
check('対抗アーム予算は厳密に成立する。**崩れるのは0/100に張り付いた染色体だけ**', () => {
  let worstFree = 0, worstPinned = 0, whereFree = '';
  for (const seed of [3, 4, 5, 6, 7, 8]) {
    const w = new W.World(seed).genesis();
    w.runYears(60);
    const A = w.people.a;
    for (const i of w.people.living()) {
      for (let c = 1; c <= S.CHROMOSOME_COUNT; c++) {
        const a = S.BY_ARM[c][0], b = S.BY_ARM[c][1];
        if (!a.length || !b.length) continue;
        const loci = a.concat(b);
        if (loci.some(s => S.INHERIT[s] === S.DOMINANT)) continue;
        let ma = 0, mb = 0;
        for (const s of a) ma += A.gene[s][i];
        for (const s of b) mb += A.gene[s][i];
        const d = Math.abs(ma / a.length + mb / b.length - G.ARM_BUDGET);
        const pinned = loci.some(s => {
          for (const h of [0, 1]) {
            const q = G.getAllele(w.people, i, s, h);
            if (q >= 99.999 || q <= 0.001) return true;
          }
          return false;
        });
        if (pinned) { if (d > worstPinned) worstPinned = d; }
        else if (d > worstFree) { worstFree = d; whereFree = `seed${seed} 染色体${c}`; }
      }
    }
  }
  // 張り付きが無ければ、等式は浮動小数点の精度で成立していなければならない
  if (worstFree > 1e-4) return `張り付きが無いのに ${worstFree.toFixed(6)} ずれた（${whereFree}）`;
  // 張り付きがあっても、崩れ方には天井がある（青天井なら連鎖群の仕掛けが効かなくなる）
  if (worstPinned > 5) return `張り付きのある染色体で ${worstPinned.toFixed(3)} ずれた（3以内のはず）`;
  return true;
});

check('こころ（優劣）の腕は予算からずれる。ただし小さい', () => {
  // 優劣は表現型が「片方を選ぶ」ので、対立遺伝子に掛けた予算が平均として残らない。
  // 連鎖群（対になるステが逆の腕）は対立遺伝子の段階で効いているので、
  // これは収束を止める仕掛けを壊してはいない。**ずれの大きさだけを見張る。**
  let worst = 0;
  for (const seed of [3, 4, 5, 6, 7, 8]) {
    const w = new W.World(seed).genesis();
    w.runYears(60);
    const A = w.people.a;
    for (const i of w.people.living()) {
      for (let c = 1; c <= S.CHROMOSOME_COUNT; c++) {
        const a = S.BY_ARM[c][0], b = S.BY_ARM[c][1];
        if (!a.length || !b.length) continue;
        if (!a.concat(b).every(s => S.INHERIT[s] === S.DOMINANT)) continue;
        let ma = 0, mb = 0;
        for (const s of a) ma += A.gene[s][i];
        for (const s of b) mb += A.gene[s][i];
        worst = Math.max(worst, Math.abs(ma / a.length + mb / b.length - G.ARM_BUDGET));
      }
    }
  }
  return worst < 8 ? true : `ずれが大きすぎる ${worst.toFixed(3)}（8未満のはず）`;
});

check('集団平均は50前後で動かない（200年・下方ドリフトが無い）', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const w = new W.World(seed).genesis();
    w.runYears(200);
    if (w.people.aliveCount() < 20) continue;
    const sp = W.spread(w.people);
    return Math.abs(sp.mean - 50) < 2 ? true : `種${seed} で平均 ${sp.mean.toFixed(2)}`;
  }
  return '200年で20人以上残った世界が無い';
});

check('劣性が潜伏する（保因者がいて、劣性ホモで表に出る）', () => {
  const w = new W.World(5).genesis();
  w.runYears(60);
  let carriers = 0, homo = 0;
  for (const i of w.people.living()) {
    if (G.carriers(w.people, i).length) carriers++;
    if (G.recessiveHomo(w.people, i).length) homo++;
  }
  if (!carriers) return '保因者が1人もいない';
  if (!homo) return '劣性ホモが1人もいない';
  return true;
});

check('遺伝的荷重で生存力が落ちる（近親交配の罰）', () => {
  if (G.vitalityOf(0) !== 1) return '荷重0で生存力1でない';
  if (!(G.vitalityOf(2) < 1)) return '荷重があっても落ちない';
  if (G.vitalityOf(100) !== G.LOAD_FLOOR) return '床が効いていない';
  const w = livingWorld(80, 3);
  let load = 0, n = 0;
  for (const i of w.people.living()) { load += G.geneticLoad(w.people, i); n++; }
  return n && load > 0 ? true : '閉じた村なのに荷重が溜まらない';
});

check('可塑が交叉率を決める（旧版と同じ式）', () => {
  if (G.crossoverRate(0) !== G.CROSSOVER_MIN) return '可塑0';
  if (Math.abs(G.crossoverRate(1) - G.CROSSOVER_MAX) > 1e-12) return '可塑1';
  const mid = G.crossoverRate(0.5);
  return mid > G.CROSSOVER_MIN && mid < G.CROSSOVER_MAX ? true : `中間 ${mid}`;
});

check('**連鎖群が効いている。全ステ最強が出ない**（A-5）', () => {
  const r = selectiveBreed(300, 60, 1, true);
  breedResult.linked = r;
  if (r.above80 > 40) return `80以上が ${r.above80}/${S.COUNT} 個`;
  if (r.popMean > 60) return `集団平均が ${r.popMean.toFixed(1)} まで上がった`;
  if (r.popMean < 45) return `集団平均が ${r.popMean.toFixed(1)} まで下がった（下方ドリフト）`;
  return true;
});

check('連鎖を外すと世界が終わる（この検査が本物である証拠）', () => {
  const r = selectiveBreed(300, 60, 1, false);
  breedResult.unlinked = r;
  if (r.above80 < 80) return `外しても ${r.above80}/${S.COUNT} しか上がらない`;
  if (r.popMean < 80) return `外しても平均 ${r.popMean.toFixed(1)}`;
  return true;
});

check('育種そのものに代償がある（欲張るほど酷くなる・A-18）', () => {
  const one = selectiveBreed(200, 40, 2, true, [0]);
  const ten = selectiveBreed(200, 40, 2, true, [0, 9, 18, 27, 36, 51, 60, 69, 80, 95]);
  breedResult.one = one; breedResult.ten = ten;
  if (!(one.targetMean > 90)) return `1つ狙って ${one.targetMean.toFixed(1)}`;
  if (!(ten.otherMean < one.otherMean)) {
    return `10個狙っても他が落ちない（1つ:${one.otherMean.toFixed(1)} 10個:${ten.otherMean.toFixed(1)}）`;
  }
  if (!(ten.below40 > one.below40)) return `40未満が増えない（${one.below40} → ${ten.below40}）`;
  return true;
});

// ===========================================================================
section('家と村（world/house.js／world/village.js）');
// ===========================================================================

check('**村ごとに**30軒で止まる（A-19b＋正典1-4 の分村）', () => {
  // ★ 2026-08-28：正典1-4「30軒が埋まると自動で隣に新しい村ができる」を実装したので、
  //   総人口は200を超える。**上限は村ごとに掛かる。**全部の村を見る（旧版は村0しか見ていなかった）
  let filled = 0, maxPop = 0, splits = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const w = new W.World(seed).genesis();
    let worst = 0;
    for (let y = 0; y < 300; y++) {
      w.runYears(1);
      for (let v = 0; v < w.villages.len; v++) {
        const h = w.villages.a.houses[v];
        if (h > worst) worst = h;
        if (h > V.HOUSES_PER_VILLAGE) return `種${seed} の村${v} で ${h}軒まで建った`;
        if (w.houses.countIn(v) !== h) return `種${seed} の村${v} で家の数の勘定が合わない`;
      }
      if (w.people.aliveCount() > maxPop) maxPop = w.people.aliveCount();
      if (w.people.aliveCount() === 0) break;
    }
    splits += w.counters.split;
    if (worst === V.HOUSES_PER_VILLAGE) {
      filled++;
      if (!w.counters.blocked) return `種${seed} は30軒に届いたのに溢れが数えられていない`;
    }
  }
  if (filled < 3) return `8通り試して30軒まで埋まったのが ${filled} だけ`;
  if (splits === 0) return '8通り300年で分村が一度も起きていない（正典1-4）';
  hundredYear.maxPop = maxPop;
  hundredYear.filled = filled;
  return true;
});

check('家が空になったら畳まれる（家系が1本消える）', () => {
  const w = new W.World(1).genesis();
  w.runYears(120);
  const HA = w.houses.a;
  const inside = new Map();
  for (const i of w.people.living()) {
    const h = w.people.a.house[i];
    if (h !== P.NO_HOUSE) inside.set(h, (inside.get(h) || 0) + 1);
  }
  for (let h = 0; h < HA.len; h++) {
    if (HA.alive[h] && !inside.has(h)) return `${h}番の家が空なのに畳まれていない`;
    if (!HA.alive[h] && inside.has(h)) return `${h}番の家が畳まれたのに人がいる`;
  }
  return true;
});

check('冬は作物ができない（A-11）', () => {
  const w = new W.World(1).genesis();
  w.runYears(30);
  w.villages.a.food[0] = 0;
  const spring = V.produceAndEat(w.people, w.villages, C.tickOf(31, 5, 1))[0];
  w.villages.a.food[0] = 0;
  const winter = V.produceAndEat(w.people, w.villages, C.tickOf(31, 11, 1))[0];
  if (!winter.winter || spring.winter) return '季節の判定が違う';
  if (!(winter.produced < spring.produced * 0.3)) {
    return `冬 ${winter.produced.toFixed(1)} ／ 春 ${spring.produced.toFixed(1)}`;
  }
  return true;
});

check('配給は創世から10年ちょうどで切れる（A-10）', () => {
  const w = new W.World(1).genesis();
  for (const i of w.people.living()) w.people.a.job[i] = V.AREA_TRAIN;  // 誰も食べ物を作らない
  w.villages.a.food[0] = 0;
  const during = V.produceAndEat(w.people, w.villages, 0)[0];
  if (during.shortage !== 0) return `配給中なのに ${during.shortage} 足りない`;
  if (!(during.rationed > 0)) return '配給が足されていない';
  w.villages.a.food[0] = 0;
  const last = V.produceAndEat(w.people, w.villages, V.RATION_YEARS * C.DAYS_PER_YEAR - 1)[0];
  if (last.shortage !== 0) return '10年目の最後の日に切れてしまった';
  w.villages.a.food[0] = 0;
  const after = V.produceAndEat(w.people, w.villages, V.RATION_YEARS * C.DAYS_PER_YEAR)[0];
  if (!(after.shortage > 0)) return '10年を過ぎても守られている';
  return true;
});

check('創世から10年のあいだは1人も飢え死にしない（10通り）', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const w = new W.World(seed).genesis();
    w.runYears(10);
    if (w.counters.byCause[P.DEATH_HUNGER] > 0) return `種${seed} で餓死`;
  }
  return true;
});

check('家長が死んだら誰かが継ぐ', () => {
  const w = new W.World(1).genesis();
  w.runYears(80);
  const members = w.houses.index(w.people);
  const HA = w.houses.a;
  for (let h = 0; h < HA.len; h++) {
    if (!HA.alive[h]) continue;
    const head = HA.head[h];
    if (head < 0) return `${h}番の家に家長がいない`;
    if (!w.people.a.alive[head]) return `${h}番の家長が死んだまま`;
    const list = members.get(h) || [];
    if (!list.includes(head)) return `${h}番の家長が家の中にいない`;
  }
  return true;
});

// ===========================================================================
section('成長（world/grow.js）');
// ===========================================================================

check('才能 < 閾値 なら何年やっても積まれない（A-4）', () => {
  const s = S.BY_CATEGORY[S.BODY].find(k => S.thresholdOf(k) >= 50 && S.growthRoomOf(k) > 0);
  if (s === undefined) return '閾値50以上のステが無い';
  const th = S.thresholdOf(s);
  if (grow.evGain(loner(th - 1, 20), 0, s, 1, 0) !== 0) return '閾値の下でも積まれた';
  if (!(grow.evGain(loner(th + 1, 20), 0, s, 1, 0) > 0)) return '閾値の上でも積まれない';
  // 20年やっても1つも積まれないこと
  const p = loner(th - 1, 20);
  for (let m = 0; m < 240; m++) p.a.ev[s][0] += grow.evGain(p, 0, s, 1, 0);
  return p.a.ev[s][0] === 0 ? true : `20年で ${p.a.ev[s][0]} 積まれた`;
});

check('こころ31個には努力値が積まれない（閾値が原理的に無い）', () => {
  for (const s of S.BY_CATEGORY[S.HEART]) {
    if (S.thresholdOf(s) !== S.THRESHOLD_NONE) return `${S.NAME[s]} に閾値がある`;
    if (grow.evGain(loner(100, 20), 0, s, 1, 0) !== 0) return `${S.NAME[s]} が積まれた`;
  }
  return true;
});

check('才能が努力値の基準そのもの（正典 O-34）', () => {
  // ★ 2026-08-28：旧検査は「才能ボーナス0.80〜0.90（ほぼ効かない）」を見ていた。
  //   正典 O-34「才能が基準そのもの。才能10なら1年で基準10。
  //   旧『1.0 ×（才能倍率＝才能÷50）』は誤りで、**50倍縮んでいた**」により、逆になった。
  //   才能100 は 才能50 の**ちょうど2倍**積む。1.125倍ではない
  const perYear = grow.EV_PER_MONTH_PER_TALENT * 12;
  if (Math.abs(perYear - 1) > 1e-12) return `1年の係数が ${perYear}（才能そのものが基準なら1）`;
  if (typeof grow.talentBonus === 'function') return '才能ボーナスが残っている（O-34 で廃止）';
  // 7→70歳の積分 28.3年ぶん × 才能 ＝ 正典の表と合うか
  let sum = 0; for (let y = 7; y < 70; y += 0.001) sum += grow.evDecay(y) * 0.001;
  const t100 = 100 * sum, t50 = 50 * sum;
  if (Math.abs(t100 - 2826) > 30) return `才能100 の積算 ${t100.toFixed(0)}（正典は2,826）`;
  if (Math.abs(t50 - 1413) > 15) return `才能50 の積算 ${t50.toFixed(0)}（正典は1,413）`;
  if (Math.abs(t100 / t50 - 2) > 1e-9) return `才能100/50 が ${(t100 / t50).toFixed(3)}倍（2.000であるべき）`;
  return true;
});

check('年齢減衰。若いほど積まれ、下げ止まりは0.25', () => {
  if (grow.evDecay(6) !== 0) return '働き始める前に積まれた';
  if (Math.abs(grow.evDecay(7) - 1) > 1e-12) return `7歳 → ${grow.evDecay(7)}`;
  for (let a = 8; a < 70; a++) if (grow.evDecay(a) > grow.evDecay(a - 1)) return `${a}歳で増えた`;
  if (grow.evDecay(70) !== grow.EV_DECAY_FLOOR) return `70歳 → ${grow.evDecay(70)}`;
  // ★ 2026-08-28：オーナー裁定「このほぼ伸びなくなるラインは50にして」により
  //   時定数 22 → 31。正典の表は 30歳 0.48（旧0.35）／50歳 0.25 で下げ止まり（旧37.5歳）
  const at30 = grow.evDecay(30);
  if (!(at30 > 0.44 && at30 < 0.52)) return `30歳 → ${at30.toFixed(3)}（正典は0.48）`;
  if (Math.abs(grow.evDecay(50) - grow.EV_DECAY_FLOOR) > 0.005) return `50歳 → ${grow.evDecay(50).toFixed(3)}（正典は0.25で下げ止まり）`;
  if (grow.evDecay(49) <= grow.EV_DECAY_FLOOR) return '50歳より前に下げ止まっている';
  // 7→70歳の積分が正典の「実効28.3年ぶん」になるか
  let sum = 0; for (let y = 7; y < 70; y += 0.001) sum += grow.evDecay(y) * 0.001;
  return Math.abs(sum - 28.3) < 0.2 ? true : `7→70歳の積分 ${sum.toFixed(2)}（正典は28.3）`;
});

check('伸びる場所で向きが変わる（A-21：全部が都会有利ではない）', () => {
  let center = 0, frontier = 0;
  for (let s = 0; s < S.COUNT; s++) {
    const c = S.placeMultiplier(s, V.WHERE_CENTER), f = S.placeMultiplier(s, V.WHERE_FRONTIER);
    if (c > f) center++; else if (f > c) frontier++;
  }
  if (!center) return '中央が有利なステが1つも無い';
  if (!frontier) return '辺境が有利なステが1つも無い';
  // あたま は中央、野外の からだ は辺境
  if (!(S.placeMultiplier(S.needId('論理'), V.WHERE_CENTER) > S.placeMultiplier(S.needId('論理'), V.WHERE_FRONTIER))) {
    return '論理が中央で伸びない';
  }
  if (!(S.placeMultiplier(S.needId('持久力'), V.WHERE_FRONTIER) > S.placeMultiplier(S.needId('持久力'), V.WHERE_CENTER))) {
    return '持久力が辺境で伸びない';
  }
  return true;
});

check('職に就いていると努力値が積まれる（100年で実際に増える）', () => {
  const w = livingWorld(100, 3);
  let best = 0, who = -1;
  for (const i of w.people.living()) {
    for (let s = 0; s < S.COUNT; s++) if (w.people.a.ev[s][i] > best) { best = w.people.a.ev[s][i]; who = i; }
  }
  if (!(best > 5)) return `いちばん積んだ者で ${best.toFixed(2)}`;
  // こころ には1つも積まれていないこと
  for (const i of w.people.living()) {
    for (const s of S.BY_CATEGORY[S.HEART]) if (w.people.a.ev[s][i] !== 0) return `${S.NAME[s]} に積まれた`;
  }
  return true;
});

// ===========================================================================
section('欲7つ（world/desire.js・#3）');
// ===========================================================================

// ★ この検査が、欲の器が正典どおりである証拠（#3 §5 の検算表そのもの）。
//   g 7本・U 7本・X 7本・Σg・ΣX の21個＋2個を、実装そのもので突き合わせる。
check('**欲7つが正典 #3 の検算表と一致する**（中央値の平民）', () => {
  // 正典 #3 §1 の「実効値の実測中央（帯なし・n=10,782）」
  const MED = {
    誇り: 50.68, 野心: 48.74, 貪欲: 49.26, 嫉妬: 50.43, 序列意識: 50.56, 他責: 50.06,
    色欲: 50.12, 繁殖力: 40.42, 体重: 35.96, 勤勉: 50.14, 気分の振れ幅: 48.99,
  };
  const pp = new P.People(4); pp.tickNow = 0;
  const i = pp.spawn(0), A = pp.a;
  // 26歳・健康なら M[枠] は3枠とも 1.000 なので、実効値＝才能で置ける
  A.alive[i] = 1; A.ageMonths[i] = 26 * 12; A.lifespan[i] = 55;
  for (let k = 0; k < S.COUNT; k++) { A.gene[k][i] = 0; A.ev[k][i] = 0; }
  for (const [n, v] of Object.entries(MED)) A.gene[S.needId(n)][i] = v;
  const M = [0, 0, 0];
  COND.frames(pp, i, M);
  for (let f = 0; f < 3; f++) if (Math.abs(M[f] - 1) > 1e-9) return `26歳・健康の M[${f}] が ${M[f]}`;

  const g = new Float64Array(7);
  D.strength(pp, i, g);
  // 正典の姿：配給100%・伴侶あり子なし・無役・評判20・通年労働・財は村の中央値
  A.ref[D.REF_GREED][i] = 50; A.ref[D.REF_GLUTTONY][i] = 100; A.ref[D.REF_ENVY][i] = 50;
  const u = new Float64Array(7);
  u[D.GREED]    = D.unmetA(pp, i, D.REF_GREED,    D.supplyGreed(100, 100), false);
  u[D.GLUTTONY] = D.unmetA(pp, i, D.REF_GLUTTONY, D.supplyGluttony(1.0, 1.0), false);
  u[D.ENVY]     = D.unmetA(pp, i, D.REF_ENVY,     D.supplyEnvy(0.5), false);
  u[D.PRIDE]    = D.unmetPride(0, 0, 20, false);
  u[D.WRATH]    = D.unmetWrath(0, 0, 0, 0, false);
  u[D.LUST]     = D.unmetLust(true, false);
  u[D.SLOTH]    = D.unmetSloth(30);

  const wantG = [0.2445, 0.4876, 0.2524, 0.4955, 0.2005, 0.3560, 0.4936];
  const wantU = [0.895, 0.231, 0.231, 1.000, 0.300, 0.000, 1.000];
  const wantX = [0.0657, 0.0338, 0.0175, 0.1487, 0.0180, 0.0000, 0.1481];
  let sum = 0;
  for (let k = 0; k < 7; k++) {
    const x = g[k] * u[k] * D.C_SCALE; sum += x;
    if (Math.abs(g[k] - wantG[k]) > 0.0006) return `${D.DESIRE_NAMES[k]} の g が ${g[k].toFixed(4)}（正典 ${wantG[k]}）`;
    if (Math.abs(u[k] - wantU[k]) > 0.0006) return `${D.DESIRE_NAMES[k]} の U が ${u[k].toFixed(4)}（正典 ${wantU[k]}）`;
    if (Math.abs(x - wantX[k]) > 0.0002) return `${D.DESIRE_NAMES[k]} の X が ${x.toFixed(4)}（正典 ${wantX[k]}）`;
  }
  const sg = g.reduce((a, b) => a + b, 0);
  if (Math.abs(sg - 2.5302) > 0.001) return `Σg が ${sg.toFixed(4)}（正典 2.5302）`;
  if (Math.abs(sum - 0.4316) > 0.0005) return `ΣX が ${sum.toFixed(4)}／月（正典 0.4316）`;
  return true;
});

check('傲慢の検算11通りが正典 #3 §2 の表と一致する', () => {
  // [爵位の段, 役職の段, 評判, U]
  const table = [
    [0, 0,   0, 1.000], [0, 0,  20, 0.895], [0, 1,  10, 0.789], [0, 0,  25, 0.868],
    [1, 1,  10, 0.684], [3, 2,  45, 0.132], [5, 0,  45, 0.237], [5, 3,  60, 0.000],
    [0, 0, 100, 0.474], [3, 2, -40, 0.579],
  ];
  for (const [t, q, r, want] of table) {
    const got = D.unmetPride(t, q, r, false);
    if (Math.abs(got - want) > 0.0006) return `爵位${t}・役職${q}・評判${r} → ${got.toFixed(4)}（正典 ${want}）`;
  }
  // ★ 内発なら爵位も評判も効かず、役職の段だけが残る
  for (const [q, want] of [[0, 1], [1, 2 / 3], [2, 1 / 3], [3, 0]]) {
    const got = D.unmetPride(5, q, 100, true);
    if (Math.abs(got - want) > 1e-9) return `内発・役職${q} → ${got.toFixed(4)}（${want.toFixed(3)} のはず）`;
  }
  return true;
});

check('境界が正典 #3 §6 の8行どおり（ゼロ割も発散も起きない）', () => {
  // 要求はゼロにならない（下駄30）
  const pp = new P.People(2); const i = pp.spawn(0);
  pp.a.alive[i] = 1; pp.a.ref[D.REF_GREED][i] = 0;
  const u0 = D.unmetA(pp, i, D.REF_GREED, 0, false);
  if (!Number.isFinite(u0)) return '要求がゼロになってゼロ割した';
  // 村の財の中央値が0でも発散しない。財≥1 で S=100 に飽和
  if (D.supplyGreed(0, 0) !== 50) return `中央値0・財0 で S=${D.supplyGreed(0, 0)}`;
  if (D.supplyGreed(1, 0) !== 100) return `中央値0・財1 で S=${D.supplyGreed(1, 0)}`;
  // 村の全員が同じ国民力 → 上の者0割 → S=100 → 平等な村では嫉妬が消える
  if (D.supplyEnvy(0) !== 100) return '全員同じなのに嫉妬の供給が100でない';
  // 傲慢の上端と下端。U>1 も U<0 も構造的に起きない
  if (D.unmetPride(5, 3, 60, false) !== 0) return '公爵の局長の傲慢が満ちない';
  if (D.unmetPride(0, 0, -100, false) !== 1) return '評判−100の無役で U>1 になった';
  if (Math.abs(D.unmetPride(5, 3, -100, false) - 0.526) > 0.0006) return '評判−100の高位者が clamp を割った';
  // 労働日数が31以上でも怠惰 U は1止まり
  if (D.unmetSloth(45) !== 1) return '労働日数45で怠惰 U が1を超えた';
  // 全員の欲が0 → ΣX も出力も0（不満ゼロと産出ゼロが同じUの表と裏）
  if (D.outputOf(0, 0, false) !== 0) return '欲0なのに出力が出た';
  // 最悪（g=1.5×7・U=1×7）→ 3.15／月
  if (Math.abs(1.5 * 1.0 * D.C_SCALE * 7 - 3.15) > 1e-9) return '最悪値が 3.15／月 でない';
  return true;
});

check('評判は0へ戻る（#6-A。評判100を維持する道は存在しない）', () => {
  const pp = new P.People(2); const i = pp.spawn(0);
  pp.a.alive[i] = 1; pp.a.ageMonths[i] = 30 * 12;
  REP.award(pp, i, 100);
  if (pp.a.rep[i] !== 100) return `+100 が乗らない（${pp.a.rep[i]}）`;
  REP.award(pp, i, 50);
  if (pp.a.rep[i] !== 100) return `上限100を超えた（${pp.a.rep[i]}）`;
  for (let m = 0; m < 12 * 100; m++) REP.reputationMonth(pp, m * 30);
  if (Math.abs(pp.a.rep[i]) > 1e-6) return `100年経っても ${pp.a.rep[i].toFixed(3)} 残っている`;
  // 0を跨いで振動しない
  REP.award(pp, i, -0.02);
  REP.reputationMonth(pp, 0);
  if (pp.a.rep[i] > 0) return `負から正へ跨いだ（${pp.a.rep[i]}）`;
  // 死者の評判は凍結する
  const j = pp.spawn(0); pp.a.alive[j] = 1;
  REP.award(pp, j, 30); pp.kill(j, 0);
  REP.award(pp, j, 50);
  if (pp.a.rep[j] !== 30) return `死者の評判が動いた（${pp.a.rep[j]}）`;
  return true;
});

check('欲が世界の中で動いている（器が空回りしていない）', () => {
  const w = new W.World(13).genesis();
  w.runYears(40);
  if (!(w.counters.pressure > 0)) return '日常の基底圧がゼロ';
  const A = w.people.a;
  let anyOut = 0, refSet = 0;
  for (const i of w.people.living()) {
    if ((A.ageMonths[i] / 12 | 0) < 12) continue;
    if (A.ref[D.REF_GREED][i] > 0) refSet++;
    for (let k = 0; k < 7; k++) if (A.desireOut[k][i] > 0) { anyOut++; break; }
  }
  if (!refSet) return '12歳を過ぎても参照点が置かれていない';
  if (!anyOut) return '出力が1人も出ていない';
  // ★ 傲慢・憤怒 は供給源がまだ無いので U=1.000 ＝ 出力0 のはず（正典の検算と同じ姿）
  for (const i of w.people.living()) {
    if ((A.ageMonths[i] / 12 | 0) < 12) continue;
    if (A.desireOut[D.WRATH][i] !== 0) return '憤怒に供給源が無いのに出力が出た';
  }
  return true;
});

// ===========================================================================
section('不満6本（world/discontent.js・第7部 §2・#4）');
// ===========================================================================

// ★ 配分の器が正典どおりである証拠（第7部 §2 の検算表そのもの）。
//   ★ 極端の2行（他責0／他責100）は**正典側の誤り**を訂正した値で見る。
//     本文が「Σ = X' で保存される」と明記しているのに、旧記載は保存則を破っていた
//     （他責0 の ④40.8 を出すには share④ = 1.122 が要る。割合が1を超える＝ありえない）
check('**配分が正典 第7部 §2 の検算表と一致する**', () => {
  const pp = new P.People(4); pp.tickNow = 0;
  const i = pp.spawn(0), A = pp.a;
  A.alive[i] = 1; A.ageMonths[i] = 26 * 12; A.lifespan[i] = 55;
  for (let k = 0; k < S.COUNT; k++) { A.gene[k][i] = 0; A.ev[k][i] = 0; }
  const put = (o) => { for (const [n, v] of Object.entries(o)) A.gene[S.needId(n)][i] = v; };
  put({ 他責: 55, 郷土愛: 66, 序列意識: 60, 信心: 60, 誇り: 60, 図太さ: 48 });   // 中央値の個体

  // 重み
  const w = [
    [DIS.W_GROUP_BASE + DIS.W_GROUP_HOME * (100 - 66), 30.4],
    [DIS.W_RULE_BASE  + DIS.W_RULE_ORDER * (100 - 60), 48.0],
    [DIS.W_GOD_BASE   + DIS.W_GOD_FAITH * 60,          38.0],
    [DIS.W_OUT_BASE   + DIS.W_OUT_PRIDE * 60,          33.0],
  ];
  for (const [got, want] of w) if (Math.abs(got - want) > 0.05) return `重みが ${got}（正典 ${want}）`;

  const ALL5 = [DIS.D_PERSON, DIS.D_GROUP, DIS.D_RULE, DIS.D_GOD, DIS.D_OUT];
  const run = (X, set, t, gate) => {
    const o = new Float64Array(6); DIS.allocate(pp, i, X, set, t, gate, o); return o;
  };
  const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
  const rows = [
    ['名指しなし X=10 t=0', run(10, ALL5, 0, DIS.GATE_ON),            [0, 0.98, 1.55, 3.27, 1.22, 1.06]],
    ['同上 t=1',            run(10, ALL5, 1, DIS.GATE_ON),            [1.53, 0.67, 1.05, 3.27, 0.83, 0.73]],
    ['憤怒 X=1 t=1',        run(1, [DIS.D_PERSON, DIS.D_OUT], 1, DIS.GATE_ALL_OUT), [0.549, 0, 0, 0, 0, 0.259]],
    ['憤怒 X=1 t=0',        run(1, [DIS.D_PERSON, DIS.D_OUT], 0, DIS.GATE_ALL_OUT), [0, 0, 0, 0, 0, 0.808]],
    ['嫉妬 X=0.5 t=0',      run(0.5, [DIS.D_PERSON], 0, DIS.GATE_ON), [0, 0, 0, 0.404, 0, 0]],
  ];
  for (const [name, got, want] of rows) {
    for (let d = 0; d < 6; d++) {
      if (!near(got[d], want[d])) return `${name} の${DIS.DIR_MARK[d]} が ${got[d].toFixed(3)}（正典 ${want[d]}）`;
    }
  }
  // 左遷・罷免（X=30 S={①} t=1 ＋ X=15 S={③}）。他責を振って3通り
  for (const [blame, want] of [[55, [14.42, 7.21, 14.73]], [0, [2.42, 1.21, 32.72]], [100, [23.03, 11.51, 1.82]]]) {
    put({ 他責: blame });
    const o = new Float64Array(6);
    DIS.allocate(pp, i, 30, [DIS.D_PERSON], 1, DIS.GATE_ON, o);
    DIS.allocate(pp, i, 15, [DIS.D_RULE], 0, DIS.GATE_ON, o);
    if (!near(o[0], want[0], 0.02) || !near(o[2], want[1], 0.02) || !near(o[3], want[2], 0.02)) {
      return `左遷・他責${blame} が ${o[0].toFixed(2)}/${o[2].toFixed(2)}/${o[3].toFixed(2)}（正典 ${want.join('/')}）`;
    }
    // ★ 本文が明記している保存則。X' = 45 × 段0
    const Xp = 45 * (0.60 + 0.40 * (100 - 48) / 100);
    const sum = o.reduce((a, b) => a + b, 0);
    if (!near(sum, Xp, 0.01)) return `他責${blame} で Σ=${sum.toFixed(3)} が X'=${Xp.toFixed(3)} と合わない`;
  }
  return true;
});

check('日常は ① に1点も入らない（全員が100に張り付かない唯一の防波堤）', () => {
  const w = new W.World(13).genesis();
  w.runYears(80);
  const A = w.people.a;
  for (const i of w.people.living()) {
    if (A.dis[DIS.D_PERSON][i] !== 0) return `①に日常が入った（${A.dis[DIS.D_PERSON][i]}）`;
    if (A.dis[DIS.D_GROUP][i] !== 0) return `②に日常が入った（${A.dis[DIS.D_GROUP][i]}）`;
    // 日常は恨みには一切入らない（#4-(b)）
    for (let d = 0; d < 6; d++) if (A.grudge[d][i] !== 0) return `恨み${DIS.DIR_MARK[d]}に日常が入った`;
  }
  return true;
});

// ★ 正典の主張は「**中央値の平民**の定常が 27.0 で、怠業の閾値45 の下」。
//   個体の散らばりは別の話なので、中央値で測る。**尾は測って記録する**（黙って隠さない）。
check('定常が閾値の下で止まる（③の中央値は怠業45 の下・④は自暴自棄65 のはるか下）', () => {
  const v3 = [], v4 = [];
  for (const seed of [1, 5, 7, 9, 13, 17]) {
    const w = new W.World(seed).genesis();
    w.runYears(150);
    const A = w.people.a;
    for (const i of w.people.living()) {
      if ((A.ageMonths[i] / 12 | 0) < 26) continue;
      v3.push(A.dis[DIS.D_RULE][i]); v4.push(A.dis[DIS.D_SELF][i]);
    }
  }
  if (v3.length < 50) return `26歳以上が ${v3.length}人しかいない`;
  const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length * p)]; };
  const m3 = q(v3, 0.5), m4 = q(v4, 0.5);
  if (m3 >= 45) return `不満③ の中央が ${m3.toFixed(1)}（怠業の閾値45 に届いた）`;
  if (m4 >= 65) return `不満④ の中央が ${m4.toFixed(1)}（自暴自棄の閾値65 に届いた）`;
  // ★ 慰霊のない国でも③は止まる。ゼロにもならない（日常は潮、火をつけるのは事件）
  if (!(m3 > 5)) return `不満③ の中央が ${m3.toFixed(2)}（日常の潮が立っていない）`;
  // 尾。怠業が「慢性」になる者が population を食い尽くさないこと
  const chronic = v3.filter(v => v >= 45).length / v3.length;
  if (chronic > 0.10) return `不満③ が45以上の者が ${(chronic * 100).toFixed(1)}%（慢性の怠業が広がっている）`;
  // ④の閾値65 には誰も届かない（#5 の「集団自殺は伝播なしには起きない」の前提）
  if (v4.some(v => v >= 65)) return `不満④ が65に届いた者がいる（${Math.max(...v4).toFixed(1)}）`;
  return true;
});

check('⑤は薄れない・⑥は年末に落ちる（正典3-5 の消え方の表）', () => {
  const pp = new P.People(2); const i = pp.spawn(0);
  const A = pp.a;
  A.alive[i] = 1; A.ageMonths[i] = 26 * 12; A.lifespan[i] = 55;
  for (let k = 0; k < S.COUNT; k++) { A.gene[k][i] = 50; A.ev[k][i] = 0; }
  for (let d = 0; d < 6; d++) A.dis[d][i] = 50;
  for (let m = 0; m < 120; m++) DIS.decayMonth(pp, i);
  if (A.dis[DIS.D_GOD][i] !== 50) return `⑤が薄れた（${A.dis[DIS.D_GOD][i]}）`;   // 溜め池
  if (A.dis[DIS.D_OUT][i] !== 50) return `⑥が率で薄れた（${A.dis[DIS.D_OUT][i]}）`;
  if (!(A.dis[DIS.D_SELF][i] < A.dis[DIS.D_RULE][i])) return '④が③より速く薄れていない';
  if (!(A.dis[DIS.D_RULE][i] < A.dis[DIS.D_PERSON][i])) return '③が①より速く薄れていない';
  DIS.yearEndPeace(pp, i);
  if (Math.abs(A.dis[DIS.D_OUT][i] - 44) > 1e-6) return `年末の⑥が ${A.dis[DIS.D_OUT][i]}（50−6 のはず）`;
  // 相手が死ねば ① のその枠だけ0（正典3-5）
  const j = pp.spawn(0); A.alive[j] = 1;
  DIS.addGrudge1(pp, i, j, 40);
  if (DIS.value1(pp, i) !== 40) return `①の枠に入らない（${DIS.value1(pp, i)}）`;
  pp.kill(j, 0); DIS.clearDeadTargets(pp, i);
  if (DIS.value1(pp, i) !== 0) return `相手が死んでも①が残った（${DIS.value1(pp, i)}）`;
  return true;
});

// ★ #5 §3 の月次上限が、④の張り付きを止める本体
check('④の月次上限0.80点が効いている（#5 §3。超えた分は捨てる）', () => {
  if (DIS.SELF_DAILY_CAP !== 0.80) return `上限が ${DIS.SELF_DAILY_CAP}`;
  // 平衡 = min(0.80, 月次流入) ÷ (rD④ × k)。正典 §3 の表と突き合わせる
  const eq = (inflow, tough) => Math.min(DIS.SELF_DAILY_CAP, inflow) / (DIS.RD[DIS.D_SELF] * DIS.toughMul(tough));
  const table = [
    [0.08, 31, 9.9], [0.08, 48, 8.2], [0.08, 66, 6.9],
    [0.10, 48, 10.2], [0.25, 48, 25.5], [0.50, 48, 51.0],
    [0.80, 31, 98.8], [0.80, 48, 81.6], [0.80, 66, 69.0],
    [99.0, 48, 81.6],                                  // 上限を超えても平衡は動かない
  ];
  for (const [inflow, tough, want] of table) {
    const got = eq(inflow, tough);
    if (Math.abs(got - want) > 0.1) return `流入${inflow}・図太さ${tough} → ${got.toFixed(1)}（正典 ${want}）`;
  }
  // 恨み④ の天井40。★ 不満④が0でも恨みだけで発火することを構造的に禁じる
  const pp = new P.People(2); const i = pp.spawn(0); pp.a.alive[i] = 1;
  DIS.addGrudge4(pp, i, 100);
  if (pp.a.grudge[DIS.D_SELF][i] !== DIS.GRUDGE4_CAP) return `恨み④ の天井が ${pp.a.grudge[DIS.D_SELF][i]}`;
  // 飽和合成 V = a + b − ab/100 で a=0・b=40 なら V=40。集団自殺の閾値75/80/85 のどれにも届かない
  const V = 0 + 40 - 0 * 40 / 100;
  if (V >= 75) return `恨みだけで V④=${V} が閾値に届く`;
  return true;
});

check('④の出口（結婚と初就労）が効く。生涯ひとりの者ほど④が高い（#5 §4）', () => {
  const wed = [], single = [];
  for (const seed of [1, 5, 7, 9, 13, 17, 21, 25]) {
    const w = new W.World(seed).genesis();
    w.runYears(150);
    const A = w.people.a;
    for (const i of w.people.living()) {
      if ((A.ageMonths[i] / 12 | 0) < 30) continue;
      const ever = A.spouse[i] !== P.NO_ONE || A.births[i] > 0;
      (ever ? wed : single).push(A.dis[DIS.D_SELF][i]);
    }
  }
  if (wed.length < 30) return `伴侶か子がいる者が ${wed.length}人しかいない`;
  if (single.length < 3) return `生涯ひとりの者が ${single.length}人しかいない`;
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  const mw = med(wed), ms = med(single);
  // ★ 正典：「生涯独身かつ無役で終わる者は残る。その者は④が高いのが正しい」
  if (!(ms > mw)) return `生涯ひとりの者の④ ${ms.toFixed(1)} が、伴侶ありの ${mw.toFixed(1)} を上回らない`;
  return true;
});

// ===========================================================================
section('結婚と出産（world/marry.js）');
// ===========================================================================

check('妊娠はちょうど10ヶ月（300日）で終わる', () => {
  if (M.PREGNANCY_DAYS !== 10 * C.DAYS_PER_MONTH) return `${M.PREGNANCY_DAYS}日`;
  const w = new W.World(13).genesis();
  const start = new Map();      // 誰が、いつ身ごもったか
  // 創世の3人は最初から身ごもっている（残り6・8・10ヶ月）ので数から外す
  for (const i of w.people.living()) if (w.people.a.state[i] & P.ST_PREGNANT) start.set(i, null);
  let checked = 0;
  for (let d = 0; d < C.DAYS_PER_YEAR * 50; d++) {
    const b = w.stepDay();
    for (const c of b.babies) {
      const m = w.people.a.mother[c];
      if (!start.has(m)) continue;
      const from = start.get(m);
      start.delete(m);
      if (from === null) continue;            // 創世ぶん
      const took = w.tick - from;
      if (took !== M.PREGNANCY_DAYS) return `${took}日かかった`;
      checked++;
    }
    for (const i of w.people.living()) {
      if ((w.people.a.state[i] & P.ST_PREGNANT) && !start.has(i)) start.set(i, w.tick);
    }
  }
  return checked > 20 ? true : `確かめられたのが ${checked} 件だけ`;
});

check('出産は18〜40歳のあいだだけ（A-12）', () => {
  const w = new W.World(13).genesis();
  w.runYears(150);
  const A = w.people.a;
  for (let i = 0; i < w.people.len; i++) {
    const m = A.mother[i];
    if (m < 0) continue;
    const age = (A.birthTick[i] - A.birthTick[m]) / C.DAYS_PER_YEAR;
    // 身ごもるのが18〜40歳のあいだなので、産むのは18歳10ヶ月〜40歳10ヶ月
    if (age < M.BIRTH_MIN_AGE) return `${age.toFixed(2)}歳で産んだ`;
    if (age > M.BIRTH_MAX_AGE + 10 / 12 + 1e-6) return `${age.toFixed(2)}歳で産んだ`;
  }
  return true;
});

check('双子5%・三つ子0.1%（A-12。四つ子以上は無い）', () => {
  if (M.TWIN_P !== 0.05 || M.TRIPLET_P !== 0.001) return `${M.TWIN_P} / ${M.TRIPLET_P}`;
  const w = new W.World(13).genesis();
  w.runYears(200);
  const A = w.people.a;
  const sameDay = new Map();
  for (let i = 0; i < w.people.len; i++) {
    const m = A.mother[i];
    if (m < 0) continue;
    const k = m + ':' + A.birthTick[i];
    sameDay.set(k, (sameDay.get(k) || 0) + 1);
  }
  let single = 0, twin = 0, triple = 0, more = 0;
  for (const n of sameDay.values()) {
    if (n === 1) single++; else if (n === 2) twin++; else if (n === 3) triple++; else more++;
  }
  if (more) return `四つ子以上が ${more} 件`;
  const total = single + twin + triple;
  if (total < 50) return `件数が ${total} 件しかない`;
  const rate = twin / total;
  return rate > 0.01 && rate < 0.12 ? true : `双子率 ${(rate * 100).toFixed(1)}%（${twin}/${total}）`;
});

check('きょうだい・親子とは結ばれない', () => {
  const w = new W.World(13).genesis();
  w.runYears(150);
  const A = w.people.a;
  for (let i = 0; i < w.people.len; i++) {
    const sp = A.spouse[i];
    if (sp < 0) continue;
    if (M.tooClose(w.people, i, sp)) return `${i} と ${sp}`;
  }
  return true;
});

check('原則1対1（伴侶は必ず両思い）', () => {
  const w = new W.World(13).genesis();
  w.runYears(150);
  const A = w.people.a;
  for (let i = 0; i < w.people.len; i++) {
    if (!A.alive[i]) continue;
    const sp = A.spouse[i];
    if (sp < 0) continue;
    if (A.spouse[sp] !== i) return `${i} → ${sp} → ${A.spouse[sp]}`;
  }
  return true;
});

check('1組6人前後で産む（B-11）', () => {
  // ★ 1つの種で測らない。B-11 は集団の主張なので、1世界の当たり外れで振れる
  //   （実測：種7で5.86・種17で8.14。同じコードで帯の外に片側ずつ出る）。
  //   許容幅は動かさず、標本を束ねる（6種・約670人）
  let n = 0, sum = 0;
  for (const seed of [13, 1, 5, 7, 9, 17]) {
    const w = new W.World(seed).genesis();
    w.runYears(200);
    const A = w.people.a;
    for (let i = 0; i < w.people.len; i++) {
      if (A.sex[i] !== P.SEX_FEMALE) continue;
      const end = A.alive[i] ? A.ageMonths[i] / 12 : (A.deathTick[i] - A.birthTick[i]) / C.DAYS_PER_YEAR;
      if (end < M.BIRTH_MAX_AGE) continue;         // 産み終わるまで生きた女だけ
      if (A.spouse[i] < 0 && A.births[i] === 0) continue;
      n++; sum += A.births[i];
    }
  }
  if (n < 100) return `数えられた女が ${n} 人`;
  const mean = sum / n;
  return mean > 4.5 && mean < 8 ? true : `1組 ${mean.toFixed(2)} 人（${n}人）`;
});

// ===========================================================================
section('世界（world/world.js）');
// ===========================================================================

check('**同じ種から同じ歴史が出る**（人口・食料・誰がいつ何で死んだか）', () => {
  const trace = (seed) => {
    const w = new W.World(seed).genesis();
    const t = [];
    for (let y = 0; y < 80; y++) {
      w.runYears(1);
      t.push(`${w.tick}:${w.people.aliveCount()}:${w.houses.count}:${w.villages.a.food[0].toFixed(4)}`);
    }
    const A = w.people.a;
    for (let i = 0; i < w.people.len; i++) {
      if (!A.alive[i]) t.push(`d${i}@${A.deathTick[i]}/${A.deathCause[i]}`);
    }
    for (let i = 0; i < w.people.len; i++) t.push(`g${i}=${A.gene[0][i].toFixed(5)}`);
    return t.join('|');
  };
  const a = trace(12345), b = trace(12345);
  if (a !== b) {
    for (let k = 0; k < Math.max(a.length, b.length); k++) {
      if (a[k] !== b[k]) return `${k}文字目で食い違う`;
    }
    return '長さが違う';
  }
  return true;
});

// ★ この検査が、12ストリームに割った理由そのもの（#17 §10-3）。
//   これが赤くなったら分割が壊れており、機能を1つ足すたびに基準線が全損する状態に戻っている。
check('**ストリームを1本使っても、他の11本は1ビットも動かない**（#17 §10-3）', () => {
  const trace = (burn) => {
    const w = new W.World(12345).genesis();
    // まだ誰も使っていないストリーム（厄災・狩り・宗教・犯罪・戦闘）を先に回しておく。
    // これは「あとで厄災を実装して乱数を引き始めた」状態と同じことを意味する
    for (const k of [R.STREAM.DISASTER, R.STREAM.HUNT, R.STREAM.RELIGION,
                     R.STREAM.CRIME, R.STREAM.BATTLE]) {
      for (let n = 0; n < burn; n++) w.R[k].next();
    }
    const t = [];
    for (let y = 0; y < 80; y++) {
      w.runYears(1);
      t.push(`${w.tick}:${w.people.aliveCount()}:${w.houses.count}:${w.villages.a.food[0].toFixed(4)}`);
    }
    const A = w.people.a;
    for (let i = 0; i < w.people.len; i++) {
      if (!A.alive[i]) t.push(`d${i}@${A.deathTick[i]}/${A.deathCause[i]}`);
    }
    for (let i = 0; i < w.people.len; i++) t.push(`g${i}=${A.gene[0][i].toFixed(5)}`);
    return t.join('|');
  };
  const none = trace(0);
  for (const burn of [1, 997, 100000]) {
    if (trace(burn) !== none) return `未使用ストリームを${burn}回引いたら歴史が変わった`;
  }
  // 逆向きの確認：使っているストリームを動かせば、ちゃんと別世界になる
  //（これが無いと「そもそも乱数が効いていない」でも緑になってしまう）
  const w1 = new W.World(12345).genesis();
  w1.R[R.STREAM.DEATH].next();
  const t1 = (() => { w1.runYears(80); return `${w1.people.aliveCount()}:${w1.houses.count}`; })();
  const w0 = new W.World(12345).genesis();
  const t0 = (() => { w0.runYears(80); return `${w0.people.aliveCount()}:${w0.houses.count}`; })();
  if (t1 === t0) return '死亡ストリームを動かしても何も変わらない（乱数が効いていない）';
  return true;
});

check('違う種なら違う歴史になる', () => {
  const pop = (seed) => {
    const w = new W.World(seed).genesis();
    w.runYears(80);
    return `${w.people.aliveCount()}/${w.houses.count}/${w.people.born}/${w.people.dead}`;
  };
  return pop(1) !== pop(2) ? true : '種を変えても同じ歴史になった';
});

check('**人口が爆発も絶滅もしない**（100年・20通り）', () => {
  const pops = [];
  for (let seed = 1; seed <= 20; seed++) {
    const w = new W.World(seed).genesis();
    w.runYears(100);
    pops.push(w.people.aliveCount());
    if (w.villages.a.houses[0] > V.HOUSES_PER_VILLAGE) return `種${seed} で家が ${w.villages.a.houses[0]}軒`;
  }
  hundredYear.pops = pops.slice();
  const ext = pops.filter(x => x === 0).length;
  const max = Math.max(...pops);
  const sorted = pops.slice().sort((a, b) => a - b);
  hundredYear.median = sorted[10];
  hundredYear.extinct = ext;
  if (max > 250) return `いちばん増えた世界で ${max} 人（爆発）`;
  if (ext > 6) return `20通り中 ${ext} が絶滅`;
  if (sorted[10] < 5) return `中央値が ${sorted[10]} 人`;
  return true;
});

check('絶滅率が実測（創世十匹で10%）と近い（120年・40通り）', () => {
  let ext = 0; const pops = [];
  for (let seed = 1; seed <= 40; seed++) {
    const w = new W.World(seed).genesis();
    w.runYears(120);
    const n = w.people.aliveCount();
    pops.push(n);
    if (n === 0) ext++;
  }
  const rate = ext / 40;
  hundredYear.ext120 = rate;
  hundredYear.mean120 = pops.reduce((a, b) => a + b, 0) / pops.length;
  return rate >= 0.02 && rate <= 0.25 ? true : `絶滅率 ${(rate * 100).toFixed(0)}%`;
});

check('NaN が1つも出ない（200年）', () => {
  const w = new W.World(13).genesis();
  w.runYears(200);
  const A = w.people.a;
  for (let i = 0; i < w.people.len; i++) {
    for (let s = 0; s < S.COUNT; s++) {
      if (!Number.isFinite(A.gene[s][i])) return `gene[${S.NAME[s]}][${i}]`;
      if (!Number.isFinite(A.ev[s][i])) return `ev[${S.NAME[s]}][${i}]`;
    }
    if (!Number.isFinite(A.vitality[i]) || !Number.isFinite(A.wealth[i])) return `個体 ${i}`;
  }
  for (let v = 0; v < w.villages.len; v++) if (!Number.isFinite(w.villages.a.food[v])) return `村 ${v} の食料`;
  return true;
});

check('血統の生き残り数が数えられる（収束計・A-14）', () => {
  // 創世の十匹には10本の旗が立っていて、子は父と母の旗を両方受け継ぐ。
  // 減ることはあっても増えることは無い
  let checked = 0;
  for (let seed = 1; seed <= 12 && checked < 3; seed++) {
    const w = new W.World(seed).genesis();
    if (W.lineages(w.people).size !== 10) return `種${seed} の創世で ${W.lineages(w.people).size} 家系`;
    let prev = 10;
    for (let y = 0; y < 200; y++) {
      w.runYears(1);
      if (w.people.aliveCount() === 0) break;
      const n = W.lineages(w.people).size;
      if (n > prev) return `種${seed}・${y}年目に血統が ${prev} → ${n} と増えた`;
      prev = n;
    }
    if (w.people.aliveCount() >= 10) checked++;
  }
  return checked >= 3 ? true : `200年生き延びた世界が ${checked} しか無い`;
});

check('収束計4つのうち3つが出る（ステの分散／全ステ最強／血統）', () => {
  const w = new W.World(3).genesis();
  w.runYears(150);
  const c = W.converge(w);
  if (!(c.sdOfStats > 3)) return `ばらつきが ${c.sdOfStats.toFixed(2)} まで潰れた`;
  if (!(c.bestAbove80 >= 0 && c.bestAbove80 < 60)) return `最良個体の80超が ${c.bestAbove80}`;
  if (!(c.lineages >= 1)) return '血統が数えられない';
  return true;
});

check('UI も flow も知らない（world は core しか import しない）', () => {
  const world = FILES.filter(f => f.includes(`${'/'}world${'/'}`));
  if (!world.length) return 'world にファイルが無い';
  for (const f of world) {
    const src = code(f);
    const m = src.match(/from\s+['"]([^'"]+)['"]/g) || [];
    for (const s of m) {
      if (/\/(flow|ui)\//.test(s)) return `${relative(GAME2, f)} が ${s}`;
    }
    if (/\b(document|window|localStorage|requestAnimationFrame)\b/.test(src)) {
      return `${relative(GAME2, f)} が DOM を触っている`;
    }
  }
  return true;
});

// ===========================================================================
section('進行（flow/run.js）');
// ===========================================================================
// flow は「いつ進めるか」だけを持つ。世界の中身には一切触らない。
// UI が世界を覗く穴もここしかない（UI は world を直接呼ばない）。

check('同じ種から同じ歴史が出る（flow を通しても）', () => {
  const a = new RUN.Run({ seed: 4242 });
  const b = new RUN.Run({ seed: 4242 });
  a.advance(360 * 20);
  b.advance(360 * 20);
  const x = a.view(), y = b.view();
  if (x.pop !== y.pop) return `人口 ${x.pop} ≠ ${y.pop}`;
  if (x.houses !== y.houses) return `家 ${x.houses} ≠ ${y.houses}`;
  if (x.born !== y.born || x.died !== y.died) return '生き死にが食い違う';
  const ca = a.converge(), cb = b.converge();
  if (ca.meanOfStats !== cb.meanOfStats) return 'ステの平均が食い違う';
  return true;
});

check('倍速でも早送りでも、同じ日数なら同じ歴史', () => {
  // 60倍で刻んだ世界と、一息で飛ばした世界が一致すること。
  // 「倍速の役割は短い時間の制御だけ」（A-11）を壊さないための綱
  const a = new RUN.Run({ seed: 77 });
  a.setSpeed(60); a.play();
  let guard = 0;
  while (a.view().tick < 1800 && guard++ < 200000) a.pump(16);
  const days = a.view().tick;
  const b = new RUN.Run({ seed: 77 });
  b.advance(days);
  if (a.view().pop !== b.view().pop) return `${days}日で 人口 ${a.view().pop} ≠ ${b.view().pop}`;
  if (a.view().born !== b.view().born) return '生まれた数が食い違う';
  return true;
});

check('×1は1ヶ月10分（正典3-1）', () => {
  const r = new RUN.Run({ seed: 1 });
  r.play();
  if (r.msPerTick() !== 20000) return `1tick が ${r.msPerTick()}ms`;
  // 頁は16msごとに刻む。20秒ぶん渡すと、ちょうど1日だけ進むこと
  let days = 0;
  for (let ms = 0; ms < 20000; ms += 16) days += r.pump(16);
  if (days !== 1) return `20秒で ${days}日進んだ`;
  for (let ms = 0; ms < 19000; ms += 16) days += r.pump(16);
  return days === 1 ? true : `さらに19秒で ${days}日になった`;
});

check('×10で1ヶ月1分・1年12分（正典3-1）', () => {
  const r = new RUN.Run({ seed: 1 });
  r.setSpeed(10);
  const sec = 30 * r.msPerTick() / 1000;
  if (Math.abs(sec - 60) > 1e-9) return `1ヶ月 ${sec}秒`;
  return Math.abs(sec * 12 - 720) < 1e-9 ? true : `1年 ${sec * 12}秒`;
});

check('本番の上限は×10。500倍は ?dev=1 のときだけ（正典3-1）', () => {
  const rel = new RUN.Run({ seed: 1 });
  rel.setSpeed(500);
  if (rel.speed !== 10) return `本番で ×${rel.speed} まで上がった`;
  if (rel.speedChoices().some(s => s > 10)) return '本番の選択肢に10超が出ている';
  const dev = new RUN.Run({ seed: 1, dev: true });
  dev.setSpeed(500);
  if (dev.speed !== 500) return `デバッグで ×${dev.speed} までしか上がらない`;
  if (!dev.speedChoices().includes(500)) return 'デバッグの選択肢に500が無い';
  return true;
});

check('止まっているあいだは1日も進まない', () => {
  const r = new RUN.Run({ seed: 1 });
  r.setSpeed(60);
  const t0 = r.view().tick;
  for (let k = 0; k < 100; k++) r.pump(1000);
  return r.view().tick === t0 ? true : `${r.view().tick - t0}日進んでしまった`;
});

check('裏タブで溜まった壁時計を一気に流し込まない', () => {
  const r = new RUN.Run({ seed: 1, dev: true });
  r.setSpeed(500); r.play();
  const n = r.pump(60 * 60 * 1000);       // 1時間ぶん渡す
  return n <= RUN.MAX_TICKS_PER_PUMP ? true : `1回で ${n}日進んだ`;
});

check('flow は壁時計を持たない（何ミリ秒経ったかは頁が渡す）', () => {
  // コメントは落としてから見る。「持たない」と書いた注意書きで赤になっては困る
  const src = code(join(GAME2, 'src/flow/run.js'));
  const bad = /Date\.now|performance\.now|requestAnimationFrame|setInterval|setTimeout/.exec(src);
  return bad ? `${bad[0]} を呼んでいる` : true;
});

check('十匹が立っている。家5軒・身ごもり3人（A-10）', () => {
  const r = new RUN.Run({ seed: 5 });
  const s = r.snapshot();
  if (s.bar.pop !== 10) return `${s.bar.pop}体`;
  if (s.homes.length !== 5) return `家が ${s.homes.length}軒`;
  if (s.bar.pregnant !== 3) return `身ごもりが ${s.bar.pregnant}人`;
  if (s.folk.length !== 10) return `地図に出るのが ${s.folk.length}体`;
  return true;
});

check('地図に出る家の数と、世界の家の数が合う', () => {
  const r = new RUN.Run({ seed: 9 });
  for (let y = 0; y < 60; y++) {
    r.advance(360);
    const s = r.snapshot();
    if (s.homes.length !== s.bar.houses) return `${y}年目 ${s.homes.length} ≠ ${s.bar.houses}`;
  }
  return true;
});

check('住居の枠は30。家は必ずどれかの枠に入る（A-19b）', () => {
  const r = new RUN.Run({ seed: 3 });
  for (let y = 0; y < 120; y++) {
    r.advance(360);
    const s = r.snapshot();
    const used = new Set();
    for (const h of s.homes) {
      if (h.slot < 0 || h.slot >= RUN.HOUSES_PER_VILLAGE) return `枠 ${h.slot} が範囲の外`;
      if (used.has(`${h.v}/${h.slot}`)) return `${y}年目に枠がぶつかった`;
      used.add(`${h.v}/${h.slot}`);
    }
  }
  return true;
});

check('家の枠は畳まれるまで動かない（箱が飛び回らない）', () => {
  const r = new RUN.Run({ seed: 12 });
  r.advance(360 * 8);
  const before = new Map(r.snapshot().homes.map(h => [h.h, h.slot]));
  for (let k = 0; k < 40; k++) {
    r.advance(90);
    for (const h of r.snapshot().homes) {
      if (before.has(h.h) && before.get(h.h) !== h.slot) return `${h.h}の家が枠を移った`;
    }
  }
  return true;
});

check('地図に出る人数と、生きている人数が合う', () => {
  const r = new RUN.Run({ seed: 21 });
  for (let y = 0; y < 40; y++) {
    r.advance(360);
    const s = r.snapshot();
    if (s.folk.length !== s.bar.pop) return `${y}年目 ${s.folk.length} ≠ ${s.bar.pop}`;
    if (s.bar.adults + s.bar.children !== s.bar.pop) return '大人と子どもの和が人口に合わない';
  }
  return true;
});

check('誰がどこにいるかが、村の勘定と合う（A-19）', () => {
  const r = new RUN.Run({ seed: 8 });
  r.advance(360 * 30);
  const s = r.snapshot();
  if (!s.villages.length) return '村が無い';
  const sum = s.villages[0].byArea.reduce((a, b) => a + b, 0);
  return sum === s.villages[0].pop ? true : `${sum} ≠ ${s.villages[0].pop}`;
});

check('身重の女は畑にも森にも出ない。居場所も家に寄る', () => {
  const r = new RUN.Run({ seed: 6 });
  r.advance(360 * 20);
  const s = r.snapshot();
  const bad = s.folk.filter(p => p.pregnant && p.at !== RUN.AREA_HOME);
  return bad.length === 0 ? true : `${bad.length}人が外に立っている`;
});

check('色相は血統だけ。同じ血なら同じ色相（A-4/A-5）', () => {
  const one = RUN.hueOfBlood(1 << 3);
  const same = RUN.hueOfBlood(1 << 3);
  if (one.hue !== same.hue) return '同じ血で色が違う';
  if (Math.abs(one.pure - 1) > 1e-6) return '1家系なのに混ざった扱いになっている';
  const two = RUN.hueOfBlood((1 << 3) | (1 << 4));
  if (two.lines !== 2) return '家系の数が数えられない';
  if (!(two.pure < one.pure)) return '混ざっても色が抜けない';
  if (RUN.hueOfBlood(1 << 0).hue === RUN.hueOfBlood(1 << 5).hue) return '別の家系が同じ色';
  return true;
});

check('大きさ＝身長は18歳で頭打ち（正典1-2⑤）', () => {
  const r = new RUN.Run({ seed: 31 });
  r.advance(360 * 40);
  let big = 0, small = 0;
  for (const p of r.snapshot().folk) {
    if (p.grow < 0 || p.grow > 1) return `大きさが ${p.grow}`;
    if (p.age < 3 && p.grow > 0.3) return `${p.age}歳が大きすぎる（${p.grow.toFixed(2)}）`;
    if (p.age >= 18) { big++; if (p.grow > 0.62) small++; }   // 大人は身長で散る
  }
  if (big > 20 && small === 0) return '大人が全員おなじ大きさ（身長が効いていない）';
  return true;
});

check('粒（細胞）は撤廃されている（正典1-2⑤）', () => {
  if (RUN.cellsOf !== undefined) return 'cellsOf がまだ生きている';
  const r = new RUN.Run({ seed: 41 });
  r.advance(360 * 40);
  for (const p of r.snapshot().folk) if (p.cells !== undefined) return '盤面にまだ細胞が出ている';
  return true;
});

check('明度＝年齢。1歳が最も明るく、老衰間際が最も暗い（正典1-2⑤）', () => {
  const r = new RUN.Run({ seed: 43 });
  r.advance(360 * 40);
  let young = null, old = null;
  for (const p of r.snapshot().folk) {
    if (p.dark === undefined) return '明度が出ていない';
    if (p.dark < 0 || p.dark > 1) return `明度が ${p.dark}`;
    if (p.age <= 2 && (young === null || p.dark < young)) young = p.dark;
    if (p.age >= 45 && (old === null || p.dark > old)) old = p.dark;
  }
  if (young !== null && old !== null && !(young < old)) return `幼${young} 老${old}`;
  return true;
});

check('年輪＝年齢。歳を取るほど増える', () => {
  if (!(RUN.ringsOf(0) < RUN.ringsOf(30))) return '若者と年寄りで年輪が同じ';
  if (RUN.ringsOf(999) > 5) return '年輪が増え続ける';
  return true;
});

check('弔いの印が、死んだ日から少しのあいだ残る（A-10：死は永久に戻らない）', () => {
  const r = new RUN.Run({ seed: 2 });
  let found = false;
  for (let k = 0; k < 4000 && !found; k++) {
    r.advance(1);
    if (r.snapshot().gone.length > 0) found = true;
  }
  if (!found) return '200年近く回しても誰も死ななかった';
  const s = r.snapshot();
  for (const d of s.gone) {
    if (d.fade < 0 || d.fade > 1) return `濃さが ${d.fade}`;
    if (!d.causeName) return '死因が読めない';
  }
  return true;
});

check('個体票は106ステ全部を返す（A-7：オーナーは全部見える）', () => {
  const r = new RUN.Run({ seed: 1 });
  const p = r.person(0);
  if (!p) return '0番が取れない';
  if (p.stats.length !== S.COUNT) return `${p.stats.length}本しか返らない`;
  if (p.top.length !== 8) return '上位8つが出ない';
  for (const s of p.stats) {
    const want = (s.talent + s.ev) * s.debuff;
    if (Math.abs(s.eff - want) > 1e-6) return `${s.name} の実効値が式と違う`;
    if (!Number.isFinite(s.eff)) return `${s.name} が NaN`;
  }
  return true;
});

check('伸びない理由が日本語で返る（才能が閾値に届いていない）', () => {
  const r = new RUN.Run({ seed: 15 });
  const p = r.person(0);
  const stuck = p.stats.filter(s => !s.canTrain && s.reason);
  if (!stuck.length) return '理由が1つも付かない';
  const heart = p.stats.filter(s => s.catName === 'こころ');
  if (heart.some(s => s.canTrain)) return 'こころに努力値が積める扱いになっている';
  return true;
});

check('家票は顔ぶれを返す。家長がひとり立つ', () => {
  const r = new RUN.Run({ seed: 1 });
  r.advance(360 * 12);
  const s = r.snapshot();
  for (const hm of s.homes) {
    const h = r.house(hm.h);
    if (!h) return `${hm.h}の家が取れない`;
    if (h.members.length !== h.size) return `${hm.h}の家 ${h.members.length} ≠ ${h.size}`;
    if (h.members.filter(m => m.head).length > 1) return `${hm.h}の家に家長が2人`;
  }
  return true;
});

check('年代記の初出（A-10 の「これは初めてか」がそのまま出てくる）', () => {
  const r = new RUN.Run({ seed: 1 });
  if (!r.notices.length) return '創世が載っていない';
  if (r.notices[0].what !== '創世') return `最初が「${r.notices[0].what}」`;
  r.advance(360 * 40);
  const what = r.notices.map(n => n.what);
  if (new Set(what).size !== what.length) return '同じ節目が2回載っている';
  if (!what.includes('初めての子')) return '40年回して出産が載らない';
  for (const n of r.notices) if (!/年.*月.*日/.test(n.date)) return '日付が読めない';
  return true;
});

check('人が多すぎたら箱だけにする（A-19：降りたら中が見える）', () => {
  return RUN.MAX_FOLK > 0 && RUN.MAX_FOLK <= 10000
    ? true : `一体ずつ描く上限が ${RUN.MAX_FOLK}`;
});

check('snapshot は同じ tick なら作り直さない（毎フレーム呼んでよい）', () => {
  const r = new RUN.Run({ seed: 1 });
  const a = r.snapshot(), b = r.snapshot();
  if (a !== b) return '同じ日で作り直している';
  r.advance(1);
  return r.snapshot() !== a ? true : '日が変わっても古いままになる';
});

// ===========================================================================
section('画面（src/ui）');
// ===========================================================================

check('UI は world を直接 import していない（flow を通す）', () => {
  const ui = FILES.filter(f => f.includes(`${'/'}ui${'/'}`));
  if (!ui.length) return 'ui にファイルが無い';
  for (const f of ui) {
    const m = code(f).match(/from\s+['"]([^'"]+)['"]/g) || [];
    for (const s of m) if (/\/world\//.test(s)) return `${relative(GAME2, f)} が ${s}`;
  }
  return true;
});

check('flow は ui を import していない（向きは一方向）', () => {
  const flow = FILES.filter(f => f.includes(`${'/'}flow${'/'}`));
  if (!flow.length) return 'flow にファイルが無い';
  for (const f of flow) {
    const m = code(f).match(/from\s+['"]([^'"]+)['"]/g) || [];
    for (const s of m) if (/\/ui\//.test(s)) return `${relative(GAME2, f)} が ${s}`;
  }
  return true;
});

check('flow は DOM を知らない', () => {
  const flow = FILES.filter(f => f.includes(`${'/'}flow${'/'}`));
  const bad = flow.filter(f => /\b(document|window|localStorage|requestAnimationFrame)\b/.test(code(f)));
  return bad.length === 0 || bad.map(f => relative(GAME2, f)).join(' ');
});

check('src の js が全部そのまま構文として通る（頁が黙って落ちない）', () => {
  for (const f of FILES) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) {
      return `${relative(GAME2, f)}：${(r.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' / ')}`;
    }
  }
  return true;
});

check('地図が画像アセットを使っていない（線画と塗り分けだけ）', () => {
  // 禁じたいのは**外部の画像ファイルを読み込むこと**（07 A-1「スプライトは入れない」）。
  // canvas → canvas の転送は画像素材ではないので通す（旧15-設計-描画.md §13-0 が名指しで
  // 「これはスプライトではない」と書いている）。drawImage を一律で禁じると、
  // 肖像や、村を箱にして焼くズームアウト（A-19）が作れなくなる。
  const ui = FILES.filter(f => f.includes(`${'/'}ui${'/'}`));
  for (const f of ui) {
    // 拡張子は語末でだけ拾う。`p.gifts` の `.gif` に当たると誤検知する
    if (/new\s+Image\s*\(|createImageBitmap\s*\(|\.(png|jpe?g|gif|webp|svg)\b(?!\w)/.test(code(f))) {
      return `${relative(GAME2, f)} が外部の画像を読んでいる`;
    }
  }
  return true;
});

check('地図が家とエリアを両方描いている（A-19 の要件）', () => {
  const src = code(join(GAME2, 'src/ui/map.js'));
  if (!/AREA_RECT/.test(src)) return 'エリアの区画が無い';
  if (!/HOUSES_PER_VILLAGE/.test(src)) return '30枠を知らない';
  if (!/_houseBox/.test(src)) return '家の箱を描いていない';
  if (!/_person/.test(src)) return '個体を描いていない';
  return true;
});

check('地図の位置は乱数ではなく、i から必ず同じ場所が出る', () => {
  const M = readFileSync(join(GAME2, 'src/ui/map.js'), 'utf8');
  if (/Math\.random/.test(M)) return 'Math.random を使っている';
  if (!/function hash01/.test(M)) return '決まった散らしが無い';
  return true;
});

// ===========================================================================
section('繋いだ状態（index.html）');
// ===========================================================================
// 旧版の教訓そのもの：「13項目が緑のままゲームが起動していなかった」。
// 中身をいくら検査しても、頁が構文で落ちていたら誰も気づかない。

const PAGE = readFileSync(join(GAME2, 'index.html'), 'utf8');
const PAGE_SCRIPT = (PAGE.match(/<script type="module">([\s\S]*?)<\/script>/) || [])[1];

check('index.html に起動するスクリプトが入っている', () => {
  if (!PAGE_SCRIPT) return '<script type="module"> が見つからない';
  return /import\s/.test(PAGE_SCRIPT) ? true : 'import が1つも無い';
});

check('index.html のスクリプトが構文として通る（頁が黙って落ちない）', () => {
  if (!PAGE_SCRIPT) return 'スクリプトが無い';
  const tmp = join(tmpdir(), `zoushoku-page-${process.pid}.mjs`);
  writeFileSync(tmp, PAGE_SCRIPT);
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  rmSync(tmp, { force: true });
  if (r.status !== 0) return (r.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' / ');
  return true;
});

check('index.html から辿れるファイルが全部実在して、world まで届く', () => {
  if (!PAGE_SCRIPT) return 'スクリプトが無い';
  const seeds = [...PAGE_SCRIPT.matchAll(/['"](\.\/[^'"]+\.js)['"]/g)].map(m => m[1]);
  if (!seeds.length) return 'import しているファイルが1つも無い';
  // 推移的に辿る。頁 → ui → flow → world → core が1本で繋がっていること
  const seen = new Set();
  const stack = seeds.map(p => join(GAME2, p));
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!existsSync(f)) return `${relative(GAME2, f)} が無い`;
    const dir = dirname(f);
    for (const m of code(f).matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      stack.push(join(dir, m[1]));
    }
  }
  const rels = [...seen].map(f => relative(GAME2, f));
  for (const layer of ['ui/', 'flow/', 'world/', 'core/']) {
    if (!rels.some(r => r.includes(layer))) return `${layer} に届いていない`;
  }
  return true;
});

check('index.html が style.css を読んでいて、それが実在する', () => {
  const m = PAGE.match(/href="([^"]+\.css)"/);
  if (!m) return 'style.css を読んでいない';
  return existsSync(join(GAME2, m[1])) ? true : `${m[1]} が無い`;
});

check('画面が探す id が、頁に全部ある（旧版で踏んだ「黙って落ちる」）', () => {
  // ui/main.js の $('xxx') と index.html の id="xxx" を突き合わせる。
  // 1つでも欠けると頁は例外で止まり、検査だけが緑のままになる
  const src = readFileSync(join(GAME2, 'src/ui/main.js'), 'utf8');
  const want = [...src.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
  if (!want.length) return '$() を1つも使っていない';
  const have = new Set([...PAGE.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const missing = [...new Set(want)].filter(id => !have.has(id));
  return missing.length === 0 ? true : `頁に無い id: ${missing.join(' ')}`;
});

// ---- 実測の控え（検査ではない。報告のために出す） ------------------------
console.log('');
console.log('── 実測 ──');
if (breedResult.linked) {
  console.log(`  上位20%だけを親に60世代（300体）  連鎖あり：最良の80以上 ${breedResult.linked.above80}/${S.COUNT}・集団平均 ${breedResult.linked.popMean.toFixed(1)}`);
}
if (breedResult.unlinked) {
  console.log(`                                    連鎖なし：最良の80以上 ${breedResult.unlinked.above80}/${S.COUNT}・集団平均 ${breedResult.unlinked.popMean.toFixed(1)}`);
}
if (breedResult.one && breedResult.ten) {
  console.log(`  育種の代償  狙い1つ：他が ${breedResult.one.otherMean.toFixed(1)}・40未満 ${breedResult.one.below40}個 ／ バラバラ10個：他が ${breedResult.ten.otherMean.toFixed(1)}・40未満 ${breedResult.ten.below40}個`);
}
if (hundredYear.pops) {
  const s = hundredYear.pops.slice().sort((a, b) => a - b);
  console.log(`  100年・20通りの人口  ${s.join(',')}`);
  console.log(`    絶滅 ${hundredYear.extinct}/20 ／ 中央値 ${hundredYear.median}`);
}
if (hundredYear.filled !== undefined) {
  console.log(`  300年・8通り  30軒まで埋まった世界 ${hundredYear.filled}／いちばん増えた人口 ${hundredYear.maxPop}人（30世帯＝約100人）`);
}
if (hundredYear.ext120 !== undefined) {
  console.log(`  120年・40通り  絶滅率 ${(hundredYear.ext120 * 100).toFixed(0)}%（確定事項の実測は10%）／ 平均人口 ${hundredYear.mean120.toFixed(1)}（実測は56）`);
}
{
  const w = new W.World(13).genesis();
  console.log(`  1人あたり ${w.people.bytesPerRow()} バイト（10万人で ${(w.people.bytesPerRow() * 1e5 / 1e6).toFixed(1)}MB）`);
}

// ── 授かりもの（S以上・world/gifts.js）──────────────────────────────
section('授かりもの（S以上・A-23）');

check('10個・S3 SS3 SSS2 G2・全部が劣性', () => {
  if (GG.COUNT !== 10) return `${GG.COUNT}個しかない`;
  const byTier = {};
  for (let g = 1; g <= GG.COUNT; g++) byTier[GG.TIERS[GG.TIER[g]]] = (byTier[GG.TIERS[GG.TIER[g]]] || 0) + 1;
  if (byTier.S !== 3 || byTier.SS !== 3 || byTier.SSS !== 2 || byTier.G !== 2) return JSON.stringify(byTier);
  // 顕性は小集団で暴走する。繁栄を顕性にしたら村の6割を占めた（実測）ので全部劣性にした
  const dom = [];
  for (let g = 1; g <= GG.COUNT; g++) if (GG.DOMINANT[g]) dom.push(GG.NAME[g]);
  return dom.length === 0 ? true : `顕性が残っている: ${dom.join('・')}`;
});

check('**2つ同時に発現することは構造上ありえない**（全121通り総当たり）', () => {
  for (let a = 0; a <= GG.COUNT; a++) {
    for (let b = 0; b <= GG.COUNT; b++) {
      const on = [];
      if (a !== 0 && GG.DOMINANT[a]) on.push(a);
      if (b !== 0 && GG.DOMINANT[b] && b !== a) on.push(b);
      if (a === b && a !== 0 && !GG.DOMINANT[a]) on.push(a);
      if (on.length > 1) return `${GG.NAME[a]}と${GG.NAME[b]}が同時に出た`;
    }
  }
  return true;
});

check('劣性ホモでのみ出る（1本だけでは隠れたまま）', () => {
  const mir = GG.OF.miracle, pro = GG.OF.prosper;
  if (GG.express(mir, 0) !== 0) return '奇跡がヘテロで出てしまった';
  if (GG.express(mir, mir) !== mir) return '奇跡が劣性ホモで出ない';
  if (GG.express(pro, 0) !== 0) return '繁栄がヘテロで出てしまった';
  if (GG.express(pro, mir) !== 0) return '違う2本が揃って何かが出た';
  if (GG.carried(pro, mir).length !== 2) return '2本とも隠れていない';
  return true;
});

check('授かりものは遺伝しない。出生ごとの抽選（正典3-5）', () => {
  // 親を一切見ない。同じ親から続けて生んでも、親の授かりものは伝わらない
  const w = new W.World(3).genesis();
  const pp = w.people;
  for (const i of pp.living()) {
    if (GIFT.giftsCarried(pp, i).length !== 0) return '保因という状態が残っている';
    if (pp.a.gift1[i] !== 0) return '2本目の対立遺伝子が残っている';
  }
  if (GIFT.breedGift.length !== 5) return 'breedGift の形が変わっている';
  return true;
});

check('素の確率が正典3-5の表と合う。天井は上乗せ（ソシャゲと同じ）', () => {
  // 表の値＝素の確率。S級1個 1/1万、G級1個 1/10万
  if (Math.round(1 / GIFT.baseRateOf(1)) !== 10000) return `S級 1/${Math.round(1 / GIFT.baseRateOf(1))}`;
  if (Math.round(1 / GIFT.baseRateOf(9)) !== 100000) return `G級 1/${Math.round(1 / GIFT.baseRateOf(9))}`;
  // 天井は素の確率の逆数
  if (GIFT.pityOf(1) !== 10000 || GIFT.pityOf(9) !== 100000) return '天井が確率の逆数になっていない';
  // 実際に手に入る速さは、天井のぶん 1.58倍くらい速い（(1−e⁻¹) 分の1）
  const P = {}, rng = new RNG(11), N = 2000000;
  const by = new Float64Array(GG.COUNT + 1);
  let any = 0;
  for (let k = 0; k < N; k++) {
    const g = GIFT.drawGift(P, rng);
    if (g !== 0) { any++; by[g]++; }
  }
  for (const [g, base] of [[1, 10000], [9, 100000]]) {
    const got = N / by[g], want = base * (1 - Math.exp(-1));
    if (!(got > want * 0.75 && got < want * 1.25)) return `${GG.NAME[g]} 実効 1/${Math.round(got)}（読み 1/${Math.round(want)}）`;
  }
  const all = N / any;                       // 素 1/1,887 → 実効 1/1,200 くらい
  return (all > 950 && all < 1500) || `何か持っている率 1/${Math.round(all)}`;
});

check('天井：その段が出ないまま続いたら、確定で出る（正典3-5）', () => {
  const P = {}, rng = new RNG(13);
  const need = GIFT.pityOf(9);               // 天賦（G級）の天井
  if (need !== 100000) return `G級の天井が ${need}`;
  GIFT.drawGift(P, rng);                     // カウンタを作らせる
  P._giftPity[9] = need - 1;                 // あと1回で天井
  if (GIFT.drawGift(P, rng) !== 9) return '天井に届いても出なかった';
  if (P._giftPity[9] !== 0) return '出たのに天井がリセットされていない';
  // S級のほうが天井は近い（重みが大きい＝出やすい）
  return GIFT.pityOf(1) < GIFT.pityOf(9) ? true : 'S級の天井がG級より遠い';
});

check('長寿は寿命70で確定・奇跡は老衰以外で死なない', () => {
  const w = new W.World(3).genesis();
  const pp = w.people, i = [...pp.living()][0];
  const g0 = pp.a.gift0[i], g1 = pp.a.gift1[i];
  pp.a.gift0[i] = pp.a.gift1[i] = GG.OF.long_life;
  const got = P.lifespanOf(pp, i);
  if (got !== 70) return `長寿なのに ${got}歳`;
  pp.a.gift0[i] = pp.a.gift1[i] = GG.OF.miracle;
  if (!GIFT.deathless(pp, i)) return '奇跡が効いていない';
  pp.a.gift0[i] = g0; pp.a.gift1[i] = g1;
  return true;
});

check('成長率の倍率（天賦1.3／剛健1.2はからだだけ）', () => {
  const w = new W.World(3).genesis();
  const pp = w.people, i = [...pp.living()][0];
  const body = S.BY_CATEGORY[S.BODY][0], head = S.BY_CATEGORY[S.MIND][0];
  pp.a.gift0[i] = pp.a.gift1[i] = GG.OF.gifted;
  if (GIFT.growthMul(pp, i, body) !== 1.3 || GIFT.growthMul(pp, i, head) !== 1.3) return '天賦が全部に効いていない';
  pp.a.gift0[i] = pp.a.gift1[i] = GG.OF.sturdy;
  if (GIFT.growthMul(pp, i, body) !== 1.2) return '剛健がからだに効いていない';
  if (GIFT.growthMul(pp, i, head) !== 1) return '剛健があたまにも効いてしまっている';
  return true;
});

check('**循環参照が無い**（import の順番に助けられていない）', () => {
  // UI班が踏んだ事故：looks.js が people.js から ST_HUNGRY を引き、
  // people.js は looks.js から LOOK_SPEC を引いていた。
  // それでも検査は緑だった。import の順番がたまたま逃げていただけで、
  // flow/run.js を直に叩くと 'Cannot access LOOK_SPEC before initialization' で落ちる。
  const edges = new Map();
  for (const f of FILES) {
    if (!f.endsWith('.js')) continue;
    const from = relative(GAME2, f);
    const outs = [];
    for (const m of code(f).matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      outs.push(relative(GAME2, join(dirname(f), spec)));
    }
    edges.set(from, outs);
  }
  const state = new Map();   // 0=未訪問 1=訪問中 2=済
  let cycle = null;
  const walk = (n, path) => {
    if (state.get(n) === 2) return false;
    if (state.get(n) === 1) { cycle = path.slice(path.indexOf(n)).concat(n); return true; }
    state.set(n, 1);
    for (const m of (edges.get(n) || [])) if (walk(m, path.concat(n))) return true;
    state.set(n, 2);
    return false;
  };
  for (const n of edges.keys()) if (walk(n, [])) break;
  return cycle ? `循環している: ${cycle.join(' → ')}` : true;
});

check('入口（flow/run.js）を直に読み込んでも落ちない', () => {
  // 循環参照は「どこから読み始めたか」で落ちたり落ちなかったりする。
  // 検査が world から読み始めているせいで逃げていた事故があったので、UI と同じ入口からも試す。
  const r = spawnSync(process.execPath,
    ['--input-type=module', '-e',
     `import * as R from ${JSON.stringify(join(GAME2, 'src', 'flow', 'run.js'))};` +
     `const run = new R.Run({dev:true}); run.fastForwardYears(5);` +
     `if (!run.person(0)) throw new Error('person(0) が null');`],
    { encoding: 'utf8' });
  return r.status === 0 ? true : (r.stderr || '').split('\n').slice(0, 3).join(' / ');
});

// ===========================================================================
const total = pass + fail;
console.log(`\n${fail === 0 ? GREEN : RED} ${pass}/${total} 緑`);
process.exit(fail === 0 ? 0 : 1);
