// 年代記と因果の台座 ── 正典3-9
//
// > **「可読性が企画の本体」と言いながら、因果を追跡・提示する層が空白だった。**
// > **先に作るのは UI ではなくデータ層。**
//
// > ### ★ 真の原因と、公表された帰属を、別の欄として持つ。これが要点。
// > **この2列が無いと、局長の嘘も、正史の決定も、諜報の仕事も成立しない。**
// > 柱6「事実は常に正確に見える。歪むのは原因と帰属だけ」は、**この2列そのもの。**
//
// ★ **世界に1本の年代記を作らない。ひとつずつが自分の分を持つ。**
//   個人／家／村／街／国 の5段。**同じ出来事は1度だけ保存し、誰の年代記に出すかを索引で持つ。**
//   ★ ここでは索引を**別に持たず、レコードの主体・対象・村を条件に走査して出す。**
//     「何も捨てない」を守りながら索引の爆発を避けるため（10万人で1件のパネルを開くのに
//     数msかかるだけ。索引を持つと 1件×5段 の重複で行が5倍になる）。
// ★ **乱数を1回も引かない。**
import { make } from '../core/arrays.js';
import * as C from '../core/calendar.js';

export const NONE = 0xFFFFFFFF;

// ---- 種別（正典3-9「粛清・戦闘・災害・疫病・任命・産出低下…」）------------
// ★ **全部は載せない。**出生や日々の死まで載せると10万人で行が爆発する。
//   載せるのは「**誰かが年代記を開く動機になるもの**」だけ（正典3-9 の例示そのまま）。
export const EV = {
  NONE: 0,
  災害: 1,        // 嵐・火災・獣害・洪水
  疫病: 2,
  飢饉: 3,        // 村が飢えた月
  戦闘: 4,
  戦死: 5,
  任命: 6,        // 席に就いた
  叙爵: 7,
  粛清: 8,        // 処刑・異端の処分
  宗教: 9,        // 宗派の発起・消滅
  分村: 10,
  開墾: 11,       // 区画が変わった
  産出低下: 12,   // ★ 唯一の崩壊条件（柱7）。年代記を開く動機の一番手
  捕虜: 13,
  婚姻: 14,       // ★ 家の年代記の芯（家督・婚姻・断絶）
  家督: 15,
  断絶: 16,
};
export const EV_NAMES = [];
for (const [k, v] of Object.entries(EV)) EV_NAMES[v] = k;

// ---- 公表された帰属（正典3-9「正史を確定させる」）--------------------------
// > 産出が落ちた。農業局長は「天候のせい」、諜報は「横領」と報告した。**どちらを正史とするか。**
// > **★ 嘘は安いが賭け。真実は高いが確定する。**
export const TOLD = {
  未公表: 0,      // まだ誰も帰属を決めていない
  真実: 1,        // 真の原因をそのまま正史にした。恨みは生まれるが**確定してもう暴かれない**
  天候: 2,        // 「天候のせい」。恨みゼロだが**露見のリスク**
  余所者: 3,      // 「よそ者のせい」
  神罰: 4,        // 「神の罰」。祭祀局が告げる
};
export const TOLD_NAMES = ['未公表', '真実', '天候のせい', 'よそ者のせい', '神の罰'];

const EVENT_SPEC = {
  tick: 'i32',
  kind: 'u8',
  actor: 'u32',        // 主体（個体の添字）。無ければ NONE
  target: 'u32',       // 対象
  village: 'u16',      // どの村で。無ければ 0xFFFF
  house: 'u16',        // どの家で。無ければ 0xFFFF
  // ★★ ここが要点の2列 ★★
  cause: 'u32',        // **真の原因**。上流の事件ID。**システムだけが知っている**
  told: 'u8',          // **公表された帰属**。オーナーが確定させた正史
  exposed: 'u8',       // 嘘が暴かれたか（隠蔽の発覚）
  x: 'f32',            // 影響の大きさ（死者数・落ちた産出・積んだ恨み…）
};

export const NO_VILLAGE16 = 0xFFFF;

export class Chronicle {
  constructor(cap = 1024) {
    this.a = make(cap, EVENT_SPEC);
    this.byKind = new Array(EV_NAMES.length).fill(0);
  }
  get len() { return this.a.len; }

  /**
   * 出来事を1件足す。**追記型。何も捨てない。**
   * @param cause 上流の事件ID（真の原因）。無ければ NONE
   * @returns 事件ID（＝行の添字）
   */
  add(tick, kind, { actor = NONE, target = NONE, village = NO_VILLAGE16,
                    house = NO_VILLAGE16, cause = NONE, x = 0 } = {}) {
    const i = this.a.alloc();
    const A = this.a;
    A.tick[i] = tick; A.kind[i] = kind;
    A.actor[i] = actor >>> 0; A.target[i] = target >>> 0;
    A.village[i] = village & 0xFFFF; A.house[i] = house & 0xFFFF;
    A.cause[i] = cause >>> 0;
    A.told[i] = TOLD.未公表; A.exposed[i] = 0;
    A.x[i] = x;
    this.byKind[kind]++;
    return i;
  }

  /**
   * 正史を確定させる（正典3-9「決める」の一種として畳む。**新しい動詞は作らない**）。
   * ★ 真実を選べば恨みが生まれるが確定する。嘘を選べば恨みゼロだが露見のリスクが残る。
   */
  tell(id, told) { if (id < this.a.len) this.a.told[id] = told; }
  /** 嘘が暴かれた（隠蔽の発覚）。★ 露見の判定そのものは #13 諜報が持つ */
  expose(id) { if (id < this.a.len) this.a.exposed[id] = 1; }

  // ---- 5段の年代記（正典3-9）----------------------------------------------
  //   個人 … その人に起きたこと ／ 家 … 家督・婚姻・断絶
  //   村   … その村で起きたこと ／ 街・国 … 村をまたぐ／国の出来事だけ
  /** その個体の一生 */
  ofPerson(i, limit = 200) { return this._pick((k) => this.a.actor[k] === i || this.a.target[k] === i, limit); }
  /** その家の年代記（家督・婚姻・断絶） */
  ofHouse(h, limit = 200) {
    return this._pick((k) => this.a.house[k] === h
      && (this.a.kind[k] === EV.婚姻 || this.a.kind[k] === EV.家督 || this.a.kind[k] === EV.断絶), limit);
  }
  /** その村の歴史 */
  ofVillage(v, limit = 200) { return this._pick((k) => this.a.village[k] === v, limit); }
  /** 国の出来事だけ（村をまたぐもの） */
  ofNation(limit = 200) {
    return this._pick((k) => this.a.village[k] === NO_VILLAGE16
      || this.a.kind[k] === EV.戦闘 || this.a.kind[k] === EV.宗教 || this.a.kind[k] === EV.叙爵, limit);
  }

  /** ★ 真の原因をたどる（3世代あとの謀反から、原因の粛清まで遡る） */
  traceCause(id, max = 16) {
    const out = [];
    let k = id;
    for (let n = 0; n < max && k !== NONE && k < this.a.len; n++) {
      out.push(k);
      k = this.a.cause[k];
    }
    return out;
  }

  /** 表示用に1件を平たくする */
  row(k) {
    const A = this.a, d = C.dateOf(A.tick[k]);
    return {
      id: k, tick: A.tick[k], year: d.year, month: d.month,
      kind: A.kind[k], kindName: EV_NAMES[A.kind[k]] ?? '?',
      actor: A.actor[k] === NONE ? -1 : A.actor[k],
      target: A.target[k] === NONE ? -1 : A.target[k],
      village: A.village[k] === NO_VILLAGE16 ? -1 : A.village[k],
      house: A.house[k] === NO_VILLAGE16 ? -1 : A.house[k],
      cause: A.cause[k] === NONE ? -1 : A.cause[k],     // ★ システムだけが知っている
      told: A.told[k], toldName: TOLD_NAMES[A.told[k]] ?? '?',
      exposed: !!A.exposed[k],
      x: A.x[k],
    };
  }

  _pick(match, limit) {
    const out = [];
    for (let k = this.a.len - 1; k >= 0 && out.length < limit; k--) if (match(k)) out.push(this.row(k));
    return out;
  }

  bytes() { return this.a.bytes(); }
}
