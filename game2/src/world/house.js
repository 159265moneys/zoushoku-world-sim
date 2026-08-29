// 家。**箱1つ＝1家系**（A-19）。
//
// 確定事項より：
//   A-12  世代は世界の単位ではなく家族の単位
//   A-19  家（＝1家族・1つの箱）→ 村 → 街 → 国
//         家は家庭の数だけ描く。箱1つ＝1家族
//   A-19  家＝世代の単位。「世代は家族単位」と噛み合う
//   A-19b 1村 ＝ 30世帯 ＝ 約100人。村の上限は「30軒が埋まったら」
//   A-19b 家長は家の采配。誰を何に出すか
//
// 家の中身は 家長／伴侶／子。誰がどの家かは people.house[i] が持っていて、
// ここは逆引き（家 → 誰がいるか）と、家系の数を持つ。

import { NO_HOUSE, NO_ONE } from './people.js';
import { make } from '../core/arrays.js';

export const HOUSE_SPEC = {
  village: 'u16',
  head: 'i32',        // 家長
  prevHead: 'i32',    // 前の家長。★身分の世襲（#10-F）の元。継いだ瞬間にしか読まない
  mate: 'i32',        // 伴侶
  founded: 'i32',     // 建った tick
  ended: 'i32',       // 絶えた tick（絶えていなければ -1）
  alive: 'u8',
  size: 'u16',        // いま何人いるか（月ごとに数え直す）
  line: 'u16',        // 家系。創世の十匹のどこから来たか（収束計に使う）
  gen: 'u16',         // 何代目の家か
};

export class Houses {
  constructor(cap = 64) {
    this.a = make(cap, HOUSE_SPEC);
    this.count = 0;
  }
  get len() { return this.a.len; }
  get village() { return this.a.village; }
  get head() { return this.a.head; }
  get mate() { return this.a.mate; }
  get alive() { return this.a.alive; }
  get size() { return this.a.size; }
  get line() { return this.a.line; }

  /** 家を建てる。家長と伴侶を入れて、村に1軒足す */
  found(P, village, head, mate, tick, line = 0xFFFF, gen = 0) {
    const h = this.a.alloc();
    this.a.clear(h);
    const A = this.a;
    A.village[h] = village;
    A.head[h] = head;
    A.mate[h] = mate;
    A.founded[h] = tick;
    A.ended[h] = -1;
    A.alive[h] = 1;
    A.line[h] = line;
    A.gen[h] = gen;
    A.size[h] = 0;
    this.count++;
    if (head >= 0) { P.a.house[head] = h; P.a.village[head] = village; A.size[h]++; }
    if (mate >= 0) { P.a.house[mate] = h; P.a.village[mate] = village; A.size[h]++; }
    return h;
  }

  /** 誰かを家に入れる */
  join(P, h, i) {
    const old = P.a.house[i];
    if (old !== NO_HOUSE && old < this.a.len && this.a.size[old] > 0) this.a.size[old]--;
    P.a.house[i] = h;
    P.a.village[i] = this.a.village[h];
    this.a.size[h]++;
  }

  leave(P, i) {
    const h = P.a.house[i];
    if (h === NO_HOUSE) return;
    if (h < this.a.len && this.a.size[h] > 0) this.a.size[h]--;
    P.a.house[i] = NO_HOUSE;
  }

  /** 誰もいなくなった家を畳む。家系が1本消える */
  end(h, tick) {
    if (!this.a.alive[h]) return false;
    this.a.alive[h] = 0;
    this.a.ended[h] = tick;
    this.count--;
    return true;
  }

  /** 家 → その家の生きている者の一覧。月に1度作り直す */
  index(P) {
    const m = new Map();
    const A = P.a;
    for (let i = 0; i < A.len; i++) {
      if (!A.alive[i]) continue;
      const h = A.house[i];
      if (h === NO_HOUSE) continue;
      let list = m.get(h);
      if (!list) { list = []; m.set(h, list); }
      list.push(i);
    }
    return m;
  }

  /** 人数を数え直して、空になった家を畳む。@returns 畳んだ数 */
  recount(P, tick) {
    const A = this.a, PA = P.a;
    for (let h = 0; h < A.len; h++) A.size[h] = 0;
    for (let i = 0; i < PA.len; i++) {
      if (!PA.alive[i]) continue;
      const h = PA.house[i];
      if (h !== NO_HOUSE && h < A.len) A.size[h]++;
    }
    let ended = 0;
    for (let h = 0; h < A.len; h++) {
      if (!A.alive[h]) continue;
      // 家長が死んだか、家を出て（＝所帯を持って）いたら空ける。
      // 空いた席は succeed() が中にいる者から埋める（A-21b：長男は継ぐしかない）
      const hd = A.head[h];
      if (hd >= 0 && (!PA.alive[hd] || PA.house[hd] !== h)) { A.prevHead[h] = hd; A.head[h] = NO_ONE; }
      const mt = A.mate[h];
      if (mt >= 0 && (!PA.alive[mt] || PA.house[mt] !== h)) A.mate[h] = NO_ONE;
      if (A.size[h] === 0) { this.end(h, tick); ended++; }
    }
    return ended;
  }

  /** 家長が空いている家に、中にいる者から立てる */
  succeed(P, members) {
    const A = this.a, PA = P.a;
    const succeeded = [];
    for (let h = 0; h < A.len; h++) {
      if (!A.alive[h] || A.head[h] >= 0) continue;
      const list = members.get(h);
      if (!list || !list.length) continue;
      let best = -1, bestAge = -1;
      for (const i of list) {
        // 長男がいれば長男。いなければいちばん年上
        const score = PA.ageMonths[i] + (PA.sex[i] === 0 ? 10000 : 0);
        if (score > bestAge) { bestAge = score; best = i; }
      }
      A.head[h] = best;
      // 評判 +8 と 身分の世襲（#10-F）の入口。award は world.js が呼ぶ
      if (best >= 0) succeeded.push({ heir: best, from: A.prevHead[h] });
    }
    return succeeded;
  }

  /** その村の生きている家の数（＝30軒の上限を見る数） */
  countIn(village) {
    const A = this.a;
    let n = 0;
    for (let h = 0; h < A.len; h++) if (A.alive[h] && A.village[h] === village) n++;
    return n;
  }

  /** 生きている家系の数。収束計「血統の生き残り数」に使う */
  livingLines() {
    const A = this.a, set = new Set();
    for (let h = 0; h < A.len; h++) if (A.alive[h] && A.line[h] !== 0xFFFF) set.add(A.line[h]);
    return set;
  }
}
