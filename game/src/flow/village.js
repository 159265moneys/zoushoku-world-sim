// flow/village.js — 村の人口上限（§3）と、上限に着いたときの凍結（§4）。
//
// ここが「10体で止まりますと言いながら13体になる」を潰す本体（R-954 / R-955 / R-956）。
//
// sim の `world.js:457` がやっているのは旗を立てることだけで、繁殖を止める行が
// 1行もない。実際に効く天井は MAX_POP=400 と 土地×2.6≒117 の2つで、どちらも 10 と
// 無関係。MAX_POP は constants.js の export const なので外から差し替えられない。
// だから「sim の内側で止める」は sim を書き換えない限り不可能で、進行層でやる。
//
// 2段構え：
//   段A　世代の直前に fertBias を絞る（近づいたら細くする）
//   段B　世代の直後に、あふれた分だけ **その世代の新生児だけ** を村から出す
//
// 絶対規則：**切り詰めるのは必ずその世代の新生児だけ。すでに村にいる住人には決して
// 触らない。** オーナーは10体全員の名前を知っている（R-110）。名前を知っている個体が
// 上限のせいで消えるのは、P1の体験そのものの破壊になる。

import * as sim from '../sim/index.js';
import {
  PHASE, VILLAGE_CAP, FERT_DIVISOR, CAUSE_LEAVE,
  VILLAGE_TRANSPARENCY, clamp,
} from './rules.js';

/**
 * 上限がまだ効いているか。
 *
 * **初戦を終えた（`firstWarDone`）ら、上限はもう役目を終えている。**
 * 上限の目的は「10を超えて増え続けないこと」ではなく、
 * 「先へ進む道は戦いだけ」（R-104）を成立させることにある。初戦が終わった時点で
 * その扉は開いていて、次の `advanceGeneration` の中で phase は必ず TRIBE に上がる
 * （sim の world.js 段8：`reachedThreshold && firstWarDone` なら無条件）。
 *
 * ここで上限を掛け続けると、**戦後から部族までのちょうど1世代だけ出生がゼロになる**
 * （人口10〜11なので fertBias が 0 になる）。この1世代は R-302「P2は外来血の流入で
 * 幕を開ける」の当の世代で、そこで産ませないのは誰も決めていない副作用でしかない。
 * 実測：老いた村（村が埋まるのに8世代かかった種）が、この1世代を失ったせいで
 * P2に入ってから老衰の連鎖で人口1まで落ちた（20種のうち1件）。外すと 0件になる。
 *
 * 外しても「村の見た目で人口が10を超える」ことは起きない。上限を外した世代の
 * 終わりには phase が既に TRIBE になっているため（20種148観測で 0件。
 * 11体に見えるのは捕虜が入国した直後の WAR_DONE ＝ 戦後のまとめ画面だけ）。
 */
function capApplies(w) {
  return w.phase === PHASE.VILLAGE && !w.firstWarDone;
}

/**
 * 段A：世代を進める直前。
 * 乱数を1つも引かないので決定性（R-001）に触らない。
 */
export function beforeGeneration(run) {
  const w = run.world;
  if (capApplies(w)) {
    // 10に近づくほど産みにくくする。実測（20種）で /3 が
    // 「10体到達 20/20・平均4.1世代・最遅6・到達時ちょうど10が20/20」で最良（§3-2）
    w.fertBias = clamp((VILLAGE_CAP - w.people.size) / FERT_DIVISOR, 0, 1);
    // P1のあいだは家柄が存在しない（全員が創世2体の子）ので適性で配役される（R-957）
    w.transparency = VILLAGE_TRANSPARENCY;
  } else {
    w.fertBias = 1;
    // 部族の透過率は hereditary カードが握る（enterTribe が 0.5 に戻す）
  }
}

/**
 * 段B：世代を進めた直後。あふれた分だけ切り詰める。
 * 乱数を引かない（生まれ順の後ろから ＝ id の大きい順）。
 * @returns {Array} 追加のイベント（年代記に残る）
 */
export function afterGeneration(run) {
  const w = run.world;
  const events = [];
  if (!capApplies(w)) return events;   // 初戦を終えたら切り詰めない（capApplies の註）

  let over = w.people.size - VILLAGE_CAP;
  if (over <= 0) return events;

  const newborns = [...w.people.values()]
    .filter((p) => p.born === w.gen)        // その世代に生まれた子だけ
    .sort((a, b) => b.id - a.id);           // 遅く生まれた順

  const left = [];
  for (const p of newborns) {
    if (over <= 0) break;
    over--;
    const ev = sim.kill(w, p, CAUSE_LEAVE);
    if (ev) {
      // R-955 の文。飢えさせない（備蓄は実測36〜75で余っている＝嘘になる）し、
      // 生まれないことにもしない（10を跨ぐ世代を止められない）
      ev.text = `${p.name}は生まれてすぐ村を出て行った`;
      events.push(ev);
    }
    p.leftVillage = true;                   // 盤面が「死んだ」と描かないための印
    left.push({ id: p.id, name: p.name, gen: w.gen });
  }

  if (left.length) {
    // 画面に出す1行（R-955）。数字は世界から読む。固定文にしない（R-988）
    run.notices.push({
      kind: '旅立ち', gen: w.gen, people: left,
      text: `村の畑は${VILLAGE_CAP}人ぶんしかない。`
        + `${left.map((x) => x.name).join('と')}は生まれてすぐ村を出て行った。`,
    });
    sim.recomputeAggregates(w);
  }
  if (over > 0) {
    // ここに来たら段Aが効いていない（新生児より多くあふれた＝既存の住人を消すしかない）。
    // 既存の住人には触らないと決めているので、握りつぶさずに記録して先へ進む。
    run.faults.push({
      gen: w.gen, where: 'village.afterGeneration',
      message: `新生児だけでは ${over} 体ぶん足りず、人口が ${w.people.size} 体になった（R-954）`,
    });
  }
  return events;
}

/** 村がいっぱいか（＝時計を止める合図）。sim が立てた旗をそのまま読む */
export function isFull(world) {
  return !!world && world.phase === PHASE.VILLAGE && !!world.pendingFirstWar;
}

/**
 * 上限の合図に出す材料（R-988：固定文の数字を全廃する）。
 * 「10体になった」と書かず、いま何体かを世界から読んで出す。
 */
export function fullNotice(world) {
  return {
    kind: '上限', gen: world.gen,
    pop: world.people.size,
    cap: VILLAGE_CAP,
    food: world.food,
    // 1画面に1つの用件（R-904）。中身は3つだけ
    lines: [
      `村は${world.people.size}体になりました。`,
      `村の畑は${VILLAGE_CAP}人ぶんしかありません。これ以上は増えません。`,
      '時間も止まっています。次に何かが起きるのは、隣へ行ったときです。',
    ],
  };
}
