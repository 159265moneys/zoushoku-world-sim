// 決定的乱数。ヘッドレステストで同じ種から同じ歴史を再現するために必須。
// Math.random() はコード中どこでも使わないこと。

export class RNG {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 1;
  }
  // xorshift32
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  int(n) { return Math.floor(this.next() * n); }
  range(a, b) { return a + this.next() * (b - a); }
  pick(arr) { return arr[this.int(arr.length)]; }
  bool(p = 0.5) { return this.next() < p; }
  // 平均mu、標準偏差sigmaの正規乱数（Box-Muller）
  normal(mu = 0, sigma = 1) {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  clampNormal(mu, sigma, lo, hi) {
    return Math.max(lo, Math.min(hi, this.normal(mu, sigma)));
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  fork(tag = 0) { return new RNG((this.s ^ (tag * 2654435761)) >>> 0); }
}
