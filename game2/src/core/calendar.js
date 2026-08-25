// 暦。tick ↔ 日・月・年・季節。
//
// 確定事項 A-11 / 骨組み 3 より：
//   1日 = 1tick / 1ヶ月 = 30日 / 1年 = 12ヶ月 = 360日
//   1倍 = 1日1分 / 本番の上限 60倍 / デバッグ 500倍
//   冬は作物ができない
//
// 掟：Date.now() に依存した挙動をここに書かない。時間は tick でしか進まない。
//     壁時計を触るのは「1tick を何ミリ秒で刻むか」という UI 側の都合だけで、
//     世界の中身は tick の整数だけを見る。

export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR; // 360

// tick=0 は 1年1月1日。年も月も日も 1 から数える（住人に見せる数なので）
export const EPOCH_YEAR = 1;

// ---- 季節 ----------------------------------------------------------------
// 1年を4つに割る。1〜3月が春、10〜12月が冬。年の頭が春。
export const SPRING = 0, SUMMER = 1, AUTUMN = 2, WINTER = 3;
export const SEASON_NAMES = ['春', '夏', '秋', '冬'];
export const MONTHS_PER_SEASON = MONTHS_PER_YEAR / 4; // 3

// ---- 速さ ----------------------------------------------------------------
// 1倍 = 1日1分。倍率 r のとき 1tick = 60000/r ミリ秒。
// 速さは1本のスケール（正典3-1・絶対固定ルール）。
//   ×1（基本）  … 1ヶ月＝10分。オフライン進行もこの速さ
//   ×10（最速） … 1ヶ月＝1分
// 1ヶ月＝30日なので、×1 の1日は 10分/30 ＝ 20秒。
export const MS_PER_TICK_AT_1X = 20000;
export const SPEED_MAX_RELEASE = 10;  // 本番の上限（×10＝1ヶ月1分・1年12分）
export const SPEED_MAX_DEBUG = 500;   // 収束計を回すため。開発用UIに隔離する
// オフラインは ×1 で進む。ただし進むのは24時間ぶん＝12年まで（正典3-1）
export const OFFLINE_SPEED = 1;
export const OFFLINE_MAX_HOURS = 24;

// ---- tick → 日付 ---------------------------------------------------------

// 通算の月（0起点）。状態異常・産出・消費・成長はこの単位で回す
export function monthOf(tick) { return Math.floor(tick / DAYS_PER_MONTH); }
// 通算の年（0起点）
export function yearOf(tick) { return Math.floor(tick / DAYS_PER_YEAR); }

// 見せる用の年（1起点）
export function year(tick) { return EPOCH_YEAR + yearOf(tick); }
// 見せる用の月（1〜12）
export function month(tick) { return monthOf(tick) % MONTHS_PER_YEAR + 1; }
// 見せる用の日（1〜30）
export function day(tick) { return tick % DAYS_PER_MONTH + 1; }

export function season(tick) {
  return Math.floor((monthOf(tick) % MONTHS_PER_YEAR) / MONTHS_PER_SEASON);
}
export function seasonName(tick) { return SEASON_NAMES[season(tick)]; }

// 冬は作物ができない（確定事項 A-11）
export function isWinter(tick) { return season(tick) === WINTER; }
export function cropsGrow(tick) { return !isWinter(tick); }

// 年月日をまとめて取る。UI の表示用
export function dateOf(tick) {
  const s = season(tick);
  return {
    tick,
    year: year(tick),
    month: month(tick),
    day: day(tick),
    season: s,
    seasonName: SEASON_NAMES[s],
    winter: s === WINTER,
  };
}

export function formatDate(tick) {
  const d = dateOf(tick);
  return `${d.year}年${d.month}月${d.day}日（${d.seasonName}）`;
}

// ---- 日付 → tick ---------------------------------------------------------
// y は1起点の年、m は1〜12、d は1〜30
export function tickOf(y, m = 1, d = 1) {
  return (y - EPOCH_YEAR) * DAYS_PER_YEAR + (m - 1) * DAYS_PER_MONTH + (d - 1);
}
// 通算の月（0起点）の頭の tick
export function tickOfMonth(m) { return m * DAYS_PER_MONTH; }
// 通算の年（0起点）の頭の tick
export function tickOfYear(y) { return y * DAYS_PER_YEAR; }

// ---- 節目 ----------------------------------------------------------------
// 「この tick に入った瞬間が月の頭か」。run.js が月次処理を呼ぶ合図に使う
export function isMonthStart(tick) { return tick % DAYS_PER_MONTH === 0; }
export function isYearStart(tick) { return tick % DAYS_PER_YEAR === 0; }
export function isSeasonStart(tick) {
  return isMonthStart(tick)
    && monthOf(tick) % MONTHS_PER_SEASON === 0;
}

// from から to へ進むあいだに何回 月/年 をまたいだか。
// オフライン進行でまとめて飛ばすときに、月次を何回回せばいいかを出す
export function monthsBetween(from, to) { return monthOf(to) - monthOf(from); }
export function yearsBetween(from, to) { return yearOf(to) - yearOf(from); }

// ---- 年齢 ----------------------------------------------------------------
// 年齢は月齢で持つ（Uint16 で 5461歳まで入る。人は 70 年 = 840ヶ月）。
// 歳に直すのは見せるときだけ。

export function ageMonths(tick, birthTick) {
  return Math.floor((tick - birthTick) / DAYS_PER_MONTH);
}
export function ageYears(tick, birthTick) {
  return Math.floor((tick - birthTick) / DAYS_PER_YEAR);
}
// 月齢 → 歳
export function monthsToYears(m) { return Math.floor(m / MONTHS_PER_YEAR); }
// 歳 → 月齢
export function yearsToMonths(y) { return y * MONTHS_PER_YEAR; }
// 誕生日（その年の月日）が来たか
export function isBirthday(tick, birthTick) {
  return (tick - birthTick) % DAYS_PER_YEAR === 0 && tick >= birthTick;
}

// ---- 速さの換算（UI 用。世界の中身はこれを見ない） ----------------------
// 倍率 r のときの 1tick のミリ秒
export function msPerTick(speed) { return MS_PER_TICK_AT_1X / speed; }
// 倍率 r で 1ヶ月にかかる実時間（秒）。60倍で30秒
export function realSecondsPerMonth(speed) {
  return DAYS_PER_MONTH * msPerTick(speed) / 1000;
}

// ---- 時計 ----------------------------------------------------------------
// tick を数えるだけの入れ物。壁時計は持たない。
// 進めるのは呼ぶ側（flow/run.js）の仕事で、ここは「いま何tickか」だけを知っている。
export class Calendar {
  constructor(tick = 0) { this.tick = tick | 0; }

  // 1日進める。月/年をまたいだかを返すので、呼ぶ側が月次・年次を呼べる
  step() {
    this.tick++;
    return {
      tick: this.tick,
      monthStart: isMonthStart(this.tick),
      yearStart: isYearStart(this.tick),
      seasonStart: isSeasonStart(this.tick),
    };
  }
  // n日まとめて進める。またいだ回数を返す（オフライン進行用）
  advance(n) {
    const from = this.tick;
    this.tick += n | 0;
    return {
      tick: this.tick,
      months: monthsBetween(from, this.tick),
      years: yearsBetween(from, this.tick),
    };
  }

  get year() { return year(this.tick); }
  get month() { return month(this.tick); }
  get day() { return day(this.tick); }
  get season() { return season(this.tick); }
  get winter() { return isWinter(this.tick); }
  get totalMonths() { return monthOf(this.tick); }
  get totalYears() { return yearOf(this.tick); }

  date() { return dateOf(this.tick); }
  toString() { return formatDate(this.tick); }

  save() { return this.tick; }
  load(tick) { this.tick = tick | 0; return this; }
}
