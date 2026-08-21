// 列ごとの型付き配列（SoA）を作る道具。
//
// 確定事項 A-2 より：10万人で 型付き配列 86MB/8.1ms、辞書＋オブジェクト 526MB/18.2ms。
// **オブジェクトの配列にしない。** 1つの項目につき1本の配列を持ち、i 番目の人の
// 年齢は age[i] で取る。
//
//   const people = make(1024, { age:'u16', sex:'u8', gene:'f32*104' });
//   people.age[i]        Uint16Array
//   people.sex[i]        Uint8Array
//   people.gene[s][i]    Float32Array が104本（骨組みの gene[stat][i] の形）
//
// 添字は寿命のあいだ動かない。死んだ者は alive[i]=0 にするだけで詰めない。
// 詰めるとしがらみ（辺のリスト）の from/to が全部ずれる。

const CTORS = {
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
};

// 'f32*104' → { kind:'f32', width:104 } ／ 'u16' → { kind:'u16', width:1 }
function parseType(t) {
  const m = /^([a-z0-9]+)(?:\*(\d+))?$/.exec(t);
  if (!m) throw new Error(`arrays: 型の書き方が違う「${t}」`);
  const kind = m[1];
  if (!CTORS[kind]) {
    throw new Error(`arrays: 知らない型「${kind}」。使えるのは ${Object.keys(CTORS).join(' ')}`);
  }
  const width = m[2] ? parseInt(m[2], 10) : 1;
  if (width < 1) throw new Error(`arrays: 幅が0以下「${t}」`);
  return { kind, width, ctor: CTORS[kind] };
}

/**
 * 列ごとの型付き配列の束を作る。
 * @param {number} cap  最初に確保する人数（足りなくなれば勝手に倍に伸びる）
 * @param {object} spec {列名: 型} の表。型は 'u8'|'u16'|'u32'|'i8'|'i16'|'i32'|'f32'|'f64'、
 *                      '*N' を付けると N 本まとまった列になる（gene[s][i]）
 */
export function make(cap, spec) {
  return new Store(cap, spec);
}

export class Store {
  constructor(cap, spec) {
    if (!Number.isInteger(cap) || cap < 0) throw new Error('arrays: cap が整数でない');
    this.spec = { ...spec };
    this.cap = Math.max(1, cap);
    this.len = 0;               // いま使っている数（＝これまでに配った添字の数）
    this.cols = [];             // 列の情報。伸ばすときと数えるときに使う

    for (const name of Object.keys(spec)) {
      const { kind, width, ctor } = parseType(spec[name]);
      this.cols.push({ name, kind, width, ctor });
      if (width === 1) {
        this[name] = new ctor(this.cap);
      } else {
        const bank = new Array(width);
        for (let k = 0; k < width; k++) bank[k] = new ctor(this.cap);
        this[name] = bank;
      }
    }
  }

  // n 人ぶんの席を確保する。足りなければ伸ばす
  ensure(n) {
    if (n <= this.cap) return this;
    let next = this.cap;
    while (next < n) next *= 2;
    return this.grow(next);
  }

  // 席を newCap まで伸ばす。中身は writing 済みのぶんがそのまま残る
  grow(newCap) {
    if (newCap <= this.cap) return this;
    for (const c of this.cols) {
      if (c.width === 1) {
        const old = this[c.name];
        const arr = new c.ctor(newCap);
        arr.set(old);
        this[c.name] = arr;
      } else {
        const bank = this[c.name];
        for (let k = 0; k < c.width; k++) {
          const old = bank[k];
          const arr = new c.ctor(newCap);
          arr.set(old);
          bank[k] = arr;
        }
      }
    }
    this.cap = newCap;
    return this;
  }

  // 席を1つ（または k 個）取って、その先頭の添字を返す。中身は0で始まる
  alloc(k = 1) {
    const at = this.len;
    this.ensure(at + k);
    this.len = at + k;
    return at;
  }

  // i 番の行を全部0に戻す
  clear(i) {
    for (const c of this.cols) {
      if (c.width === 1) this[c.name][i] = 0;
      else { const b = this[c.name]; for (let k = 0; k < c.width; k++) b[k][i] = 0; }
    }
    return this;
  }

  // src 行の中身を dst 行へ写す
  copyRow(dst, src) {
    for (const c of this.cols) {
      if (c.width === 1) this[c.name][dst] = this[c.name][src];
      else { const b = this[c.name]; for (let k = 0; k < c.width; k++) b[k][dst] = b[k][src]; }
    }
    return this;
  }

  // いま何バイト持っているか（cap ぶん）。収束計と実測の報告に使う
  bytes() {
    let n = 0;
    for (const c of this.cols) n += c.ctor.BYTES_PER_ELEMENT * c.width * this.cap;
    return n;
  }
  // 1人あたり何バイトか
  bytesPerRow() {
    let n = 0;
    for (const c of this.cols) n += c.ctor.BYTES_PER_ELEMENT * c.width;
    return n;
  }

  columnNames() { return this.cols.map(c => c.name); }

  // --- セーブ（B-7：型付き配列をそのまま IndexedDB へ） -------------------
  // 使っている len ぶんだけを切り出す。ここでは形を作るだけで、書き込みはしない
  save() {
    const data = {};
    for (const c of this.cols) {
      if (c.width === 1) data[c.name] = this[c.name].slice(0, this.len);
      else {
        const b = this[c.name];
        const bank = new Array(c.width);
        for (let k = 0; k < c.width; k++) bank[k] = b[k].slice(0, this.len);
        data[c.name] = bank;
      }
    }
    return { spec: { ...this.spec }, len: this.len, data };
  }

  static load(saved) {
    const s = new Store(Math.max(1, saved.len), saved.spec);
    s.len = saved.len;
    for (const c of s.cols) {
      const src = saved.data[c.name];
      if (!src) continue;
      if (c.width === 1) s[c.name].set(src);
      else for (let k = 0; k < c.width; k++) s[c.name][k].set(src[k]);
    }
    return s;
  }
}

// 幅のある列（gene のような）を1本だけ作りたいとき用
export function bank(width, cap, kind = 'f32') {
  const { ctor } = parseType(kind);
  const b = new Array(width);
  for (let k = 0; k < width; k++) b[k] = new ctor(cap);
  return b;
}

// 型付き配列を1本だけ伸ばす
export function growArray(arr, newCap) {
  if (newCap <= arr.length) return arr;
  const next = new arr.constructor(newCap);
  next.set(arr);
  return next;
}
