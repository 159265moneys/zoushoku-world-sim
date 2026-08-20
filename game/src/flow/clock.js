// flow/clock.js — 時間（10-設計-進行ロジック §7）。
//
// 決めること：1世代の実時間、速度、tick を進めてよいかどうか、
// 「あと何分何秒」の換算（R-943 / 07-A-3）。
//
// **時計の持ち主は常に1つ**。`run.stage` が RUNNING_STAGES に入っていないあいだは
// ▶ 進める も ×1〜×8 も効かない（R-956）。「決断待ちのモーダルの裏で時間が進む」は
// 幕の CSS ではなくここで塞ぐ。
//
// 掟：Date.now() も performance.now() も読まない。実時間は UI が測って渡す。
// この層がやるのは「1世代＝何ミリ秒か」と「残りは何ミリ秒か」の換算だけ。

import { GEN_MS, TICKS_PER_GEN, RUNNING_STAGES, STAGE, clamp } from './rules.js';

/** 速度の目盛り。既定は ×1（勝手に変えない・§7-2） */
export const SPEEDS = [1, 2, 4, 8];

/** 1世代の実時間（ミリ秒）。R-960 で core/model.js の GEN_MS が {1:75000, 2:180000} になる */
export function genMs(world) {
  return GEN_MS[world && world.phase ? world.phase : 1] ?? GEN_MS[1];
}

/** 1 tick の実時間（ミリ秒） */
export function tickMs(world) {
  return genMs(world) / TICKS_PER_GEN;
}

/** いま世界の時計が動いてよいか（R-956） */
export function isRunning(run) {
  if (!run || !run.world) return false;
  if (run.paused) return false;
  if (!(run.speed > 0)) return false;
  return RUNNING_STAGES.has(run.stage);
}

/**
 * 動いていない理由。押せないボタンには必ず理由を書く（R-943）。
 * 動いているときは null。
 */
export function stopReason(run) {
  if (!run || !run.world) return '世界がまだ無い';
  switch (run.stage) {
    case STAGE.VILLAGE_FULL:
      return '村は10体でいっぱい。時間も止まっています。次に何かが起きるのは、隣へ行ったときです。';
    case STAGE.ENDED:
      return 'この世界はもう増えません。';
    case STAGE.OPENING:
      return 'まだ世界が始まっていません。';
    default:
      break;
  }
  if (RUNNING_STAGES.has(run.stage)) {
    if (run.paused) return '止めています。';
    if (!(run.speed > 0)) return '速度が 0 です。';
    return null;
  }
  return '戦のあいだ、世界の時間は止まります。';
}

/** 速度を変える。止まっているあいだは受け付けない（受け付けた振りもしない） */
export function setSpeed(run, v) {
  if (!RUNNING_STAGES.has(run.stage)) return false;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return false;
  run.speed = n;
  return true;
}

/**
 * 「あと◯世代」を実時間に直す（R-943：あと2世代は初見に何分か分からない）。
 * いま進んでいる世代の消化ぶんを差し引くので、待っているあいだ数字が動き続ける。
 * @param gens 残り世代数
 */
export function gensToMs(run, gens) {
  const w = run.world;
  const left = Math.max(0, gens * TICKS_PER_GEN - (run.tickInGen ?? 0));
  const speed = run.paused ? 0 : (run.speed || 0);
  if (speed <= 0) return left * tickMs(w);   // 止めているあいだは ×1 換算で出す
  return (left * tickMs(w)) / speed;
}

/** 1世代のうち、いまどこまで来ているか（0..1）。上帯の世代バーが読む */
export function genProgress(run) {
  return clamp((run.tickInGen ?? 0) / TICKS_PER_GEN, 0, 1);
}

/** ミリ秒を「◯分◯秒」に。R-943 が要求する形（分秒） */
export function fmtDuration(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}分${String(s).padStart(2, '0')}秒`;
}
