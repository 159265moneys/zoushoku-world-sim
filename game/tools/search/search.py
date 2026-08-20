#!/usr/bin/env python3
"""search.py — 「増殖」の方針空間を探索する。

  段階1  ランダムサーチ（広く当たりを付ける）        …少数種でふるい落とす
  段階2  局所探索（(mu+lambda)-ES ＋ 差分進化）        …中数種で磨く
  段階3  検証（探索種の全数）→ ホールドアウト（別種）  …最終判定はここだけ

過適合対策（SEARCH.md の作法）：
  * 探索用の種とホールドアウトの種を最初に分け、**混ぜない**
  * 最終判定は最低30種。平均とブートストラップ信頼区間で比べる
  * 「たまたま良かった1本」を最適解と呼ばない（上位は必ず再測定する）

評価器は黒箱。Python はゲームのルールを一切持たない。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import shlex
import statistics
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from space import (CARDS, CARD_IDS, CAPTIVE_AXES, BORDERS, PROMOTES, DIM,  # noqa: E402
                   Evaluator, decode, canonical, key_of)

GAME_ROOT = HERE.parent.parent          # .../game
CACHE_PATH = HERE / "cache.jsonl"


def sim_fingerprint(root=None):
    """src/sim・src/core・tools/eval.js の内容ハッシュ（先頭8桁）。

    探索中に sim が書き換わることがある（実際に起きた：創世の spread、
    カードの配線）。**版が違う測定値を1つの平均に混ぜると、方針の差ではなく
    実装の差を最適化する。** キャッシュの鍵に版を入れて、混ざらないようにする。
    """
    import hashlib
    root = Path(root or GAME_ROOT)
    h = hashlib.sha256()
    files = sorted(list((root / "src" / "sim").glob("*.js"))
                   + list((root / "src" / "core").glob("*.js"))
                   + [root / "tools" / "eval.js"])
    for f in files:
        if f.exists():
            h.update(f.name.encode())
            h.update(f.read_bytes())
    return h.hexdigest()[:8]

# 絶滅の扱い：power は0として平均に入れ、絶滅率がこの値を超えたら失格。
EXTINCT_GATE = 0.25

# 探索で最大化する読み。評価器が powerTail（末尾世代の平均国力）を出していれば
# そちらを使う——最終世代の1点は分散が大きすぎて、方針の差がノイズに埋もれるため。
# 最終判定は必ず契約どおりの power（raw_power）も併記する。
OBJECTIVE = "power"

# sim の版。探索中に sim が書き換わった測定値を混ぜないための鍵。
SIM_VER = "unknown"

# 探索空間から外すカード（評価器の meta.inertCards ＝ どこからも読まれていない次元）。
# 空間には残すが既定値に固定する。動かしても結果がビット一致する次元を動かすと、
# 実質の探索次元が減るうえ、上位方針が「死んだ次元だけ違う別物」に見えてしまう。
FROZEN = {}


# ---------------------------------------------------------------------------
# 評価のとりまとめ（キャッシュつき）
# ---------------------------------------------------------------------------
class Runner:
    def __init__(self, ev: Evaluator, opponents, use_cache=True, batch=400, verbose=True,
                 cache_path=None):
        # 評価器ごとにキャッシュを分ける。別の評価器の行を混ぜたら別のゲームを最適化する
        self.cache_path = Path(cache_path or CACHE_PATH)
        self.ev = ev
        self.opponents = list(opponents)
        self.cache = {}
        self.verbose = verbose
        self.batch = batch
        self.use_cache = use_cache
        self.sim_versions = [SIM_VER]
        self.cache_file = None
        if use_cache:
            self._load_cache()
            self.cache_file = open(self.cache_path, "a", encoding="utf-8")

    def _ck(self, pkey, seed, opp):
        return f"{SIM_VER}|{self.ev.gens}|{opp}|{seed}|{pkey}"

    def _load_cache(self):
        if not self.cache_path.exists():
            return
        n = 0
        with open(self.cache_path, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                self.cache[rec["k"]] = rec["v"]
                n += 1
        if self.verbose:
            print(f"[cache] {n} 行を読み込み", file=sys.stderr)

    def run(self, vecs, seeds, opponents=None, tag=""):
        """vecs: list[np.ndarray] → list[dict(集計)]  （同じ順で返す）"""
        opponents = opponents or self.opponents
        pkeys = [key_of(v) for v in vecs]
        need = []           # (pkey, policy_dict)
        need_seeds = set()
        for pkey, v in zip(pkeys, vecs):
            missing = [(s, o) for s in seeds for o in opponents
                       if self._ck(pkey, s, o) not in self.cache]
            if missing:
                need.append((pkey, decode(v)))
                need_seeds.update(s for s, _ in missing)
        if need:
            self._evaluate(need, sorted(need_seeds), opponents, tag)
        return [self._aggregate(pkey, seeds, opponents) for pkey in pkeys]

    def _check_sim(self):
        """呼び出しのたびに sim の版を見る。探索中に sim が書き換わることがある。

        版が変わったら鍵を切り替える（古い測定値と新しい測定値が同じ平均に
        入らないようにする）。混ぜたら方針ではなく実装の差を最適化してしまう。
        """
        global SIM_VER
        cur = sim_fingerprint()
        if cur != SIM_VER:
            print(f"\n*** sim が探索中に変わった: {SIM_VER} → {cur} ***\n"
                  f"    これ以降の測定は新しい鍵で貯める（古い行とは混ざらない）",
                  file=sys.stderr)
            self.sim_versions.append(cur)
            SIM_VER = cur

    def _evaluate(self, need, seeds, opponents, tag):
        self._check_sim()
        for i in range(0, len(need), self.batch):
            chunk = need[i:i + self.batch]
            policies = []
            id_of = {}
            for j, (pkey, pol) in enumerate(chunk):
                pid = f"p{i + j:05d}"
                id_of[pid] = pkey
                policies.append({"id": pid, **pol})
            t0 = time.time()
            rows = self.ev.evaluate(policies, seeds, opponents)
            for r in rows:
                pkey = id_of.get(r.get("id"))
                if pkey is None:
                    continue
                v = {"power": float(r.get("power", 0) or 0),
                     # 低分散の読み（評価器が出していれば探索の目的関数に使う）
                     "powerTail": float(r.get("powerTail", r.get("power", 0)) or 0),
                     "powerMean": float(r.get("powerMean", r.get("power", 0)) or 0),
                     "extinct": bool(r.get("extinct")),
                     "pop": float(r.get("pop", 0) or 0),
                     "wins": float(r.get("wins", 0) or 0),
                     "losses": float(r.get("losses", 0) or 0),
                     "admixture": float(r.get("admixture", 0) or 0),
                     "morale": float(r.get("morale", 0) or 0),
                     "gens": r.get("gens")}
                k = self._ck(pkey, r["seed"], r.get("opponent", opponents[0]))
                self.cache[k] = v
                if self.cache_file:
                    self.cache_file.write(json.dumps({"k": k, "v": v}, ensure_ascii=False) + "\n")
            if self.cache_file:
                self.cache_file.flush()
            if self.verbose:
                print(f"[eval:{tag}] {len(chunk)}方針 × {len(seeds)}種 × {len(opponents)}相手"
                      f" = {len(rows)}本 / {time.time() - t0:.1f}s"
                      f" （累計 {self.ev.runs}本）", file=sys.stderr)

    def _aggregate(self, pkey, seeds, opponents):
        per_seed, per_opp = [], {o: [] for o in opponents}
        raw_power, win_rate = [], []
        ext = 0
        n = 0
        for s in seeds:
            vals = []
            for o in opponents:
                v = self.cache.get(self._ck(pkey, s, o))
                if v is None:
                    continue
                p = 0.0 if v["extinct"] else v.get(OBJECTIVE, v["power"])
                vals.append(p)
                per_opp[o].append(p)
                raw_power.append(0.0 if v["extinct"] else v["power"])
                # 判定器と同じ定義：絶滅＝0、一度も戦わなかった＝0
                w, l = v.get("wins", 0), v.get("losses", 0)
                win_rate.append(0.0 if (v["extinct"] or w + l == 0) else w / (w + l))
                ext += 1 if v["extinct"] else 0
                n += 1
            if vals:
                per_seed.append(sum(vals) / len(vals))
        if not per_seed:
            return {"power": 0.0, "raw_power": 0.0, "win_rate": 0.0,
                    "extinct_rate": 1.0, "n": 0, "per_seed": [], "per_opp": {}}
        return {
            "power": float(np.mean(per_seed)),
            "raw_power": float(np.mean(raw_power)),
            "win_rate": float(np.mean(win_rate)) if win_rate else 0.0,
            "sd": float(np.std(per_seed, ddof=1)) if len(per_seed) > 1 else 0.0,
            "extinct_rate": ext / max(1, n),
            "n": n,
            "per_seed": per_seed,
            "per_opp": {o: float(np.mean(v)) if v else 0.0 for o, v in per_opp.items()},
        }


def fitness(agg):
    """絶滅は失格。それ以外は power の平均。"""
    if agg["extinct_rate"] > EXTINCT_GATE:
        return -1.0 * (agg["extinct_rate"] * 1e6)     # 失格でも順序は付ける
    return agg["power"]


# ---------------------------------------------------------------------------
# 統計
# ---------------------------------------------------------------------------
def bootstrap_ci(xs, iters=4000, alpha=0.05, rng=None):
    xs = np.asarray(xs, dtype=float)
    if len(xs) < 2:
        return (float(xs.mean()) if len(xs) else 0.0,) * 2
    rng = rng or np.random.default_rng(12345)
    idx = rng.integers(0, len(xs), size=(iters, len(xs)))
    means = xs[idx].mean(axis=1)
    return float(np.quantile(means, alpha / 2)), float(np.quantile(means, 1 - alpha / 2))


def paired_diff_ci(a, b, iters=4000, rng=None):
    """同じ種で測った2方針の差。対応のあるブートストラップ。"""
    a, b = np.asarray(a, float), np.asarray(b, float)
    n = min(len(a), len(b))
    d = a[:n] - b[:n]
    lo, hi = bootstrap_ci(d, iters=iters, rng=rng)
    return float(d.mean()), lo, hi


# ---------------------------------------------------------------------------
# 探索
# ---------------------------------------------------------------------------
def latin_hypercube(n, dim, rng):
    out = np.empty((n, dim))
    for j in range(dim):
        cuts = (np.arange(n) + rng.random(n)) / n
        rng.shuffle(cuts)
        out[:, j] = cuts
    return out


def apply_frozen(v):
    if not FROZEN:
        return v
    v = np.asarray(v, float).copy()
    for i, (cid, lo, hi, _s) in enumerate(CARDS):
        if cid in FROZEN:
            v[i] = (FROZEN[cid] - lo) / (hi - lo)
    return v


def mutate(vec, sigma, rng, p=0.45):
    v = vec.copy()
    mask = rng.random(len(v)) < p
    if not mask.any():
        mask[rng.integers(0, len(v))] = True
    v[mask] += rng.normal(0, sigma, mask.sum())
    return np.clip(v, 0.0, 1.0)


def dedup(vecs):
    seen, out = set(), []
    for v in vecs:
        k = key_of(v)
        if k in seen:
            continue
        seen.add(k)
        out.append(v)
    return out


def parallel_hill_climb(runner, starts, seeds, rng, iters=8, lam=5, sigma0=0.16,
                        tag="phc", opponents=None):
    """複数の出発点を**同時に**登る。

    1反復あたりの評価器呼び出しを1回にまとめるのが肝。eval.js は種ごとに
    10国のロスターを作り直すので、小さい呼び出しを何十回も投げると固定費で潰れる。
    """
    cur = [np.asarray(v, float) for v in starts]
    aggs = runner.run(cur, seeds, opponents=opponents, tag=f"{tag}init")
    fit = [fitness(a) for a in aggs]
    sigma = [sigma0] * len(cur)
    traces = [[f] for f in fit]
    for it in range(iters):
        kids, owner = [], []
        for i, v in enumerate(cur):
            if sigma[i] < 0.015:
                continue
            for _ in range(lam):
                kids.append(mutate(v, sigma[i], rng))
                owner.append(i)
        if not kids:
            break
        kaggs = runner.run(kids, seeds, opponents=opponents, tag=f"{tag}{it}")
        kfits = [fitness(a) for a in kaggs]
        for i in range(len(cur)):
            mine = [j for j, o in enumerate(owner) if o == i]
            if not mine:
                continue
            b = max(mine, key=lambda j: kfits[j])
            if kfits[b] > fit[i]:
                cur[i], fit[i] = kids[b], kfits[b]
                sigma[i] = min(0.30, sigma[i] * 1.25)
            else:
                sigma[i] *= 0.72
            traces[i].append(fit[i])
        print(f"[HC{it}] best={max(fit):.0f} "
              f"（各点 {' '.join(f'{f:.0f}' for f in fit)}）", file=sys.stderr)
    return cur, fit, traces


def hill_climb(runner, seed_vec, seeds, rng, iters=12, lam=8, sigma0=0.16, tag="hc",
               opponents=None):
    """(1+lambda)-ES。sigma は改善が無ければ縮める。"""
    cur = np.asarray(seed_vec, float)
    cur_agg = runner.run([cur], seeds, opponents=opponents, tag=tag)[0]
    cur_fit = fitness(cur_agg)
    sigma = sigma0
    trace = [cur_fit]
    for it in range(iters):
        kids = dedup([mutate(cur, sigma, rng) for _ in range(lam)])
        aggs = runner.run(kids, seeds, opponents=opponents, tag=f"{tag}{it}")
        fits = [fitness(a) for a in aggs]
        b = int(np.argmax(fits))
        if fits[b] > cur_fit:
            cur, cur_fit, cur_agg = kids[b], fits[b], aggs[b]
            sigma = min(0.30, sigma * 1.25)
        else:
            sigma *= 0.72
            if sigma < 0.015:
                break
        trace.append(cur_fit)
    return cur, cur_fit, cur_agg, trace


def differential_evolution(runner, pop, seeds, rng, gens=8, F=0.6, CR=0.85, tag="de",
                           opponents=None):
    pop = [np.asarray(p, float) for p in pop]
    aggs = runner.run(pop, seeds, opponents=opponents, tag=tag)
    fits = [fitness(a) for a in aggs]
    trace = [max(fits)]
    n = len(pop)
    for g in range(gens):
        trials = []
        for i in range(n):
            a, b, c = rng.choice([j for j in range(n) if j != i], 3, replace=False)
            mutant = pop[a] + F * (pop[b] - pop[c])
            cross = rng.random(DIM) < CR
            cross[rng.integers(0, DIM)] = True
            trial = np.where(cross, mutant, pop[i])
            trials.append(apply_frozen(np.clip(trial, 0.0, 1.0)))
        tagg = runner.run(trials, seeds, opponents=opponents, tag=f"{tag}{g}")
        for i in range(n):
            f = fitness(tagg[i])
            if f > fits[i]:
                pop[i], fits[i], aggs[i] = trials[i], f, tagg[i]
        trace.append(max(fits))
        print(f"[DE] 世代{g + 1}/{gens}  best={max(fits):.1f}  "
              f"median={statistics.median(fits):.1f}", file=sys.stderr)
    order = np.argsort(fits)[::-1]
    return [pop[i] for i in order], [fits[i] for i in order], [aggs[i] for i in order], trace


# ---------------------------------------------------------------------------
# クラスタリング（勝ち筋の本数）
# ---------------------------------------------------------------------------
def agglomerate(vecs, threshold):
    """平均連結の階層クラスタリング。距離が threshold を超えたら止める。"""
    X = np.array([canonical(v) for v in vecs], dtype=float)
    clusters = [[i] for i in range(len(X))]

    def dist(ci, cj):
        return float(np.mean([np.linalg.norm(X[a] - X[b]) for a in ci for b in cj]))

    while len(clusters) > 1:
        best, bi, bj = 1e18, -1, -1
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                d = dist(clusters[i], clusters[j])
                if d < best:
                    best, bi, bj = d, i, j
        if best > threshold:
            break
        clusters[bi] = clusters[bi] + clusters[bj]
        clusters.pop(bj)
    return clusters, X


# ---------------------------------------------------------------------------
# 段階的なふるい落とし（successive halving）
# ---------------------------------------------------------------------------
def successive_halving(runner, cands, seed_pool, opponents, schedule, tag="sh"):
    """schedule = [(残す数, 使う種数), ...]。生き残りだけ種を増やして測り直す。

    ノイズが方針差より大きい世界では、少数種の argmax は「運の良かった1本」に
    しかならない。段階的に種を増やしながら絞ると、同じ予算で選択の質が上がる。
    """
    cur = list(cands)
    log = []
    for r, (keep, nseeds) in enumerate(schedule):
        seeds = seed_pool[:nseeds]
        aggs = runner.run(cur, seeds, opponents=opponents, tag=f"{tag}{r}")
        fits = np.array([fitness(a) for a in aggs])
        order = np.argsort(fits)[::-1]
        log.append({
            "round": r, "candidates": len(cur), "seeds": nseeds, "keep": keep,
            "best": float(fits[order[0]]), "median": float(np.median(fits)),
            "disqualified": int((fits < 0).sum()),
        })
        print(f"[SH{r}] {len(cur)}点 × {nseeds}種 → 上位{keep}本  "
              f"best={fits[order[0]]:.0f} median={np.median(fits):.0f} "
              f"失格={int((fits < 0).sum())}", file=sys.stderr)
        cur = [cur[i] for i in order[:keep]]
        if len(cur) <= 1:
            break
    seeds = seed_pool[:schedule[-1][1]]
    aggs = runner.run(cur, seeds, opponents=opponents, tag=f"{tag}fin")
    return cur, [fitness(a) for a in aggs], log


# ---------------------------------------------------------------------------
# 代理モデル（応答曲面）。ノイズ > 信号のときは argmax より回帰のほうが強い
# ---------------------------------------------------------------------------
def features(vec):
    p = decode(vec)
    f = []
    for cid, lo, hi, _s in CARDS:
        x = (p["cards"][cid] - lo) / (hi - lo)
        f += [x, x * x]
    for opt in CAPTIVE_AXES:
        f.append(1.0 if p["captiveAxis"] == opt else 0.0)
    for opt in BORDERS:
        f.append(1.0 if p["border"] == opt else 0.0)
    for opt in PROMOTES:
        f.append(1.0 if p["promote"] == opt else 0.0)
    w = p["warAppetite"]
    f += [w, w * w, 1.0]
    return f


FEATURE_NAMES = (
    [f"{c[0]}" for c in CARDS for _ in (0,)] and
    [n for c in CARDS for n in (c[0], c[0] + "^2")]
    + [f"axis={a}" for a in CAPTIVE_AXES]
    + [f"border={b}" for b in BORDERS]
    + [f"promote={p}" for p in PROMOTES]
    + ["warAppetite", "warAppetite^2", "const"]
)


def fit_surrogate(vecs, ys, weights=None, lam=1.0):
    X = np.array([features(v) for v in vecs], dtype=float)
    y = np.asarray(ys, dtype=float)
    w = np.ones(len(y)) if weights is None else np.asarray(weights, float)
    Xw = X * w[:, None] ** 0.5
    yw = y * w ** 0.5
    A = Xw.T @ Xw + lam * np.eye(X.shape[1])
    b = Xw.T @ yw
    beta = np.linalg.solve(A, b)
    pred = X @ beta
    ss_res = float(((y - pred) ** 2 * w).sum())
    ss_tot = float(((y - np.average(y, weights=w)) ** 2 * w).sum())
    return beta, (1 - ss_res / ss_tot if ss_tot > 0 else 0.0)


def surrogate_best(beta, rng, n=150000, k=3):
    cands = np.array([apply_frozen(v) for v in rng.random((n, DIM))])
    X = np.array([features(v) for v in cands], dtype=float)
    pred = X @ beta
    order = np.argsort(pred)[::-1]
    out, seen = [], set()
    for i in order:
        kk = key_of(cands[i])
        if kk in seen:
            continue
        seen.add(kk)
        out.append((cands[i], float(pred[i])))
        if len(out) >= k:
            break
    return out


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
DEFAULT_CARDS = {"deploy_top": 40, "spare_old": 7, "raise_young": 20, "guards": 0,
                 "drill": 10, "surrender_at": 0, "hunt_ratio": 30, "stockpile": 15,
                 "frontier": 20, "ration_equal": 50, "hereditary": 50, "mix_policy": 50}


def default_policy_vec():
    """カード既定値（cards.js の def）＋中立な選択。素人の基準線。"""
    defs = DEFAULT_CARDS
    v = np.zeros(DIM)
    for i, (cid, lo, hi, _s) in enumerate(CARDS):
        v[i] = (defs[cid] - lo) / (hi - lo)
    v[12] = 0.0                                  # 総合
    v[13] = 0.0                                  # accept
    v[14] = PROMOTES.index("merit") / len(PROMOTES) + 1e-6
    v[15] = 0.5
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", default="eval",
                    help="'eval'（tools/eval.js）/ 'stub' / 'local' / 任意のコマンド")
    ap.add_argument("--workers", type=int, default=0, help="eval.js の --workers")
    ap.add_argument("--serve", action="store_true", default=True,
                    help="評価器を常駐させる（相手国ロスターを使い回す）")
    ap.add_argument("--no-serve", dest="serve", action="store_false")
    ap.add_argument("--gens", type=int, default=200, help="最終判定の世代数")
    ap.add_argument("--screen-gens", type=int, default=0, help="段階1の世代数（0で --gens）")
    ap.add_argument("--refine-gens", type=int, default=0, help="段階2の世代数（0で --gens）")
    ap.add_argument("--jobs", type=int, default=1, help="評価器プロセスの並列数")
    ap.add_argument("--opponents", default="martial,agrarian,merit,terror,melting")
    ap.add_argument("--screen-opponents", default="", help="段階1・2で使う相手（既定は全部）")
    ap.add_argument("--screen-seeds", type=int, default=6)
    ap.add_argument("--refine-seeds", type=int, default=12)
    ap.add_argument("--search-seeds", type=int, default=30)
    ap.add_argument("--holdout-seeds", type=int, default=30)
    ap.add_argument("--search-seed-list", default="",
                    help="探索種を明示する（例 1-24）。過去の探索を引き継ぐときに使う")
    ap.add_argument("--holdout-seed-list", default="",
                    help="ホールドアウト種を明示する（例 101-130）。**選抜に一度も使っていない種**であること")
    ap.add_argument("--random", type=int, default=1200, help="段階1のランダム点数")
    ap.add_argument("--elites", type=int, default=10)
    ap.add_argument("--keep-top", type=int, default=10, help="ホールドアウトに送る上位本数")
    ap.add_argument("--baseline-random", type=int, default=20,
                    help="ホールドアウトで測る一様乱択の本数（問4の基準線）")
    ap.add_argument("--hc-iters", type=int, default=10)
    ap.add_argument("--de-gens", type=int, default=8)
    ap.add_argument("--de-pop", type=int, default=24)
    ap.add_argument("--seed", type=int, default=20260820)
    ap.add_argument("--batch", type=int, default=400)
    ap.add_argument("--freeze", default="",
                    help="固定するカード（例 stockpile,ration_equal）。既定値に釘付けする")
    ap.add_argument("--snapshots", type=int, default=0,
                    help="相手国スナップショット数（eval.js 既定24）。小さいほど省メモリ")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--objective", default="powerTail",
                    choices=["power", "powerTail", "powerMean"],
                    help="探索で最大化する読み（最終報告は power も併記）")
    ap.add_argument("--out", default=str(HERE / "best.json"))
    ap.add_argument("--log", default=str(HERE / "search-log.json"))
    args = ap.parse_args()
    global OBJECTIVE, SIM_VER, FROZEN
    OBJECTIVE = args.objective
    SIM_VER = sim_fingerprint()
    defs = dict(DEFAULT_CARDS)
    FROZEN = {c.strip(): defs[c.strip()] for c in args.freeze.split(",")
              if c.strip() in defs}
    print(f"sim版 {SIM_VER}  固定カード {FROZEN or 'なし'}", file=sys.stderr)

    if args.eval == "stub":
        cmd = [sys.executable, str(HERE / "stub_eval.py")]
    elif args.eval == "local":
        cmd = ["node", str(HERE / "local_eval.mjs")]
    elif args.eval == "eval":
        cmd = ["node", str(GAME_ROOT / "tools" / "eval.js")]
        if args.workers:
            cmd += ["--workers", str(args.workers)]
    else:
        cmd = shlex.split(args.eval)
    serve = args.serve and args.eval in ("eval",) or (args.serve and "eval.js" in " ".join(cmd))
    ev = Evaluator(cmd=cmd + (["--serve"] if serve else []),
                   cwd=str(GAME_ROOT), gens=args.gens, jobs=args.jobs,
                   extra=({"snapshots": args.snapshots} if args.snapshots else {}))
    if serve:
        ev.start()
    opponents = [o.strip() for o in args.opponents.split(",") if o.strip()]
    screen_opps = ([o.strip() for o in args.screen_opponents.split(",") if o.strip()]
                   or opponents)
    screen_gens = args.screen_gens or args.gens
    refine_gens = args.refine_gens or args.gens
    runner = Runner(ev, opponents, use_cache=not args.no_cache, batch=args.batch,
                    cache_path=HERE / f"cache-{args.eval.replace('/', '_')}.jsonl")
    rng = np.random.default_rng(args.seed)

    # --- 種の分割。ここで分けたら二度と混ぜない -----------------------------
    def parse_seeds(spec):
        out = []
        for part in spec.split(","):
            part = part.strip()
            if not part:
                continue
            if "-" in part:
                a, b = part.split("-")
                out += list(range(int(a), int(b) + 1))
            else:
                out.append(int(part))
        return sorted(set(out))

    if args.search_seed_list or args.holdout_seed_list:
        search_seeds = parse_seeds(args.search_seed_list)
        holdout_seeds = parse_seeds(args.holdout_seed_list)
        if set(search_seeds) & set(holdout_seeds):
            sys.exit("探索種とホールドアウト種が重なっている。分けること。")
    else:
        all_seeds = list(range(1, 1 + args.search_seeds + args.holdout_seeds))
        rs = random.Random(args.seed)
        rs.shuffle(all_seeds)
        search_seeds = sorted(all_seeds[:args.search_seeds])
        holdout_seeds = sorted(all_seeds[args.search_seeds:])
    screen_seeds = search_seeds[:args.screen_seeds]
    refine_seeds = search_seeds[:args.refine_seeds]
    print(f"探索種 {search_seeds}\nホールドアウト種 {holdout_seeds}", file=sys.stderr)

    hist = {"stages": [], "seeds": {"search": search_seeds, "holdout": holdout_seeds},
            "opponents": opponents, "screen_opponents": screen_opps,
            "gens": args.gens, "screen_gens": screen_gens, "refine_gens": refine_gens,
            "eval": " ".join(cmd)}
    t_start = time.time()

    # --- 段階1：ランダムサーチ＋段階的ふるい落とし --------------------------
    print(f"\n=== 段階1：ランダム{args.random}点 → successive halving "
          f"（{len(screen_opps)}相手 × {screen_gens}世代）===", file=sys.stderr)
    ev.gens = screen_gens
    cand = [apply_frozen(v) for v in latin_hypercube(args.random, DIM, rng)]
    cand.append(default_policy_vec())
    cand = dedup(cand)
    schedule = [(max(args.de_pop * 4, args.random // 4), args.screen_seeds),
                (args.de_pop * 2, args.screen_seeds * 2),
                (args.de_pop, args.refine_seeds)]
    survivors, surv_fits, sh_log = successive_halving(
        runner, cand, refine_seeds, screen_opps, schedule, tag="sh")
    hist["stages"].append({"stage": "successive_halving", "points": len(cand),
                           "rounds": sh_log})

    # --- 段階1.5：応答曲面。ノイズに強い「構造」の推定 ----------------------
    all_aggs = runner.run(cand, refine_seeds[:args.screen_seeds],
                          opponents=screen_opps, tag="sh0")   # 全点はキャッシュ済み
    ok = [(v, a) for v, a in zip(cand, all_aggs) if a["n"] > 0]
    beta, r2 = fit_surrogate([v for v, _ in ok], [a["power"] for _, a in ok],
                             weights=[a["n"] for _, a in ok])
    sur = surrogate_best(beta, rng, k=3)
    print(f"[代理モデル] R²={r2:.3f}  予測最良={sur[0][1]:.0f}", file=sys.stderr)
    hist["stages"].append({"stage": "surrogate", "r2": float(r2),
                           "coef": {n: float(b) for n, b in zip(FEATURE_NAMES, beta)},
                           "predicted": [float(s[1]) for s in sur]})

    elites = dedup([s[0] for s in sur] + survivors)[:max(args.elites, args.de_pop)]

    # --- 段階2a：差分進化 ---------------------------------------------------
    print(f"\n=== 段階2a：差分進化 pop={args.de_pop} × {args.de_gens}世代 "
          f"× {len(refine_seeds)}種 × {refine_gens}世代 ===", file=sys.stderr)
    ev.gens = refine_gens
    pop = elites[:args.de_pop]
    while len(pop) < args.de_pop:
        pop.append(np.clip(rng.random(DIM), 0, 1))
    de_pop, de_fits, de_aggs, de_trace = differential_evolution(
        runner, pop, refine_seeds, rng, gens=args.de_gens, tag="de", opponents=screen_opps)
    hist["stages"].append({"stage": "de", "trace": [float(x) for x in de_trace],
                           "seeds": len(refine_seeds)})

    # --- 段階2b：山登り（上位を種に、全点同時） -----------------------------
    print(f"\n=== 段階2b：山登り 上位{args.elites}本 × {args.hc_iters}反復（同時）===",
          file=sys.stderr)
    hc_vecs, hc_fits, hc_traces = parallel_hill_climb(
        runner, de_pop[:args.elites], refine_seeds, rng,
        iters=args.hc_iters, tag="hc", opponents=screen_opps)
    hist["stages"].append({"stage": "hill_climb",
                           "traces": [[float(x) for x in t] for t in hc_traces]})

    # --- 段階3：探索種の全数で並べ直す --------------------------------------
    finalists = dedup(list(hc_vecs) + de_pop[:args.elites] + [s[0] for s in sur]
                      + [default_policy_vec()])
    print(f"\n=== 段階3：探索種{len(search_seeds)}本 × {args.gens}世代で "
          f"{len(finalists)}方針を再測定 ===", file=sys.stderr)
    ev.gens = args.gens
    f_aggs = runner.run(finalists, search_seeds, tag="verify")
    f_fits = [fitness(a) for a in f_aggs]
    order = np.argsort(f_fits)[::-1]
    top = [finalists[i] for i in order[:args.keep_top]]
    hist["stages"].append({
        "stage": "verify", "n": len(finalists), "best": float(max(f_fits)),
        "seeds": len(search_seeds),
        "ranked": [{"policy": decode(finalists[i]), "power": float(f_aggs[i]["power"]),
                    "extinct_rate": f_aggs[i]["extinct_rate"]} for i in order],
    })

    # --- 段階4：ホールドアウト ----------------------------------------------
    print(f"\n=== 段階4：ホールドアウト{len(holdout_seeds)}種 × {len(top)}方針 ===",
          file=sys.stderr)
    # 基準線：ランダム方針20本と既定カード（Q4「上手い下手の差」用）
    baseline_rand = [apply_frozen(np.clip(rng.random(DIM), 0, 1))
                     for _ in range(args.baseline_random)]
    hold_targets = dedup(top + [default_policy_vec()] + baseline_rand)
    h_aggs = runner.run(hold_targets, holdout_seeds, tag="holdout")

    n_top = len(top)
    rows = []
    for v, a in zip(hold_targets, h_aggs):
        lo, hi = bootstrap_ci(a["per_seed"])
        rows.append({"vec": [float(x) for x in v], "policy": decode(v),
                     "power": a["power"], "ci": [lo, hi], "sd": a["sd"],
                     "median": float(np.median(a["per_seed"])),
                     "q25": float(np.quantile(a["per_seed"], 0.25)),
                     "q75": float(np.quantile(a["per_seed"], 0.75)),
                     "win_rate": a["win_rate"], "raw_power": a["raw_power"],
                     "extinct_rate": a["extinct_rate"], "per_opp": a["per_opp"],
                     "per_seed": a["per_seed"]})
    top_rows = sorted(rows[:n_top], key=lambda r: -r["power"])
    # 平均で並べると裾の運が効くので、中央値の順位も別に出す
    by_median = sorted(range(len(top_rows)), key=lambda i: -top_rows[i]["median"])
    dflt_row = rows[n_top] if len(rows) > n_top else None
    rand_rows = rows[n_top + 1:]

    out = {
        "meta": {
            "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
            "evaluator": " ".join(cmd), "gens": args.gens, "opponents": opponents,
            "search_seeds": search_seeds, "holdout_seeds": holdout_seeds,
            "evaluations_runs": ev.runs, "evaluator_calls": ev.calls,
            "evaluator_restarts": ev.restarts,
            "wall_seconds": round(time.time() - t_start, 1),
            "extinct_gate": EXTINCT_GATE, "sim_version": SIM_VER,
            "sim_versions_seen": runner.sim_versions,
            "frozen_cards": FROZEN,
        },
        "best": top_rows[0] if top_rows else None,
        "rank_by_median": [{"mean_rank": i + 1, "median": top_rows[i]["median"],
                            "power": top_rows[i]["power"]} for i in by_median],
        "top": top_rows,
        "baseline_default": dflt_row,
        "baseline_random": {
            "n": len(rand_rows),
            "mean": float(np.mean([r["power"] for r in rand_rows])) if rand_rows else 0.0,
            "win_rate": float(np.mean([r["win_rate"] for r in rand_rows])) if rand_rows else 0.0,
            "all": [{"power": r["power"], "win_rate": r["win_rate"]} for r in rand_rows],
            "median": float(np.median([r["power"] for r in rand_rows])) if rand_rows else 0.0,
            "median_of_medians": float(np.median([r["median"] for r in rand_rows])) if rand_rows else 0.0,
            "best": float(max([r["power"] for r in rand_rows])) if rand_rows else 0.0,
            "extinct_rate": float(np.mean([r["extinct_rate"] for r in rand_rows])) if rand_rows else 0.0,
        },
        "history": hist,
        "eval_log": ev.log[-50:],
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    Path(args.log).write_text(json.dumps(hist, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n=== ホールドアウト成績 ===", file=sys.stderr)
    for i, r in enumerate(top_rows):
        print(f"[{i}] power={r['power']:.0f} CI=[{r['ci'][0]:.0f},{r['ci'][1]:.0f}] "
              f"勝率={r['win_rate']:.2f} 絶滅={r['extinct_rate']:.0%} "
              f"promote={r['policy']['promote']} "
              f"axis={r['policy']['captiveAxis']} border={r['policy']['border']}", file=sys.stderr)
    if dflt_row:
        print(f"[既定カード] power={dflt_row['power']:.1f}", file=sys.stderr)
    print(f"[ランダム20本] mean={out['baseline_random']['mean']:.1f} "
          f"best={out['baseline_random']['best']:.1f}", file=sys.stderr)
    print(f"\n総評価 {ev.runs} 本 / {ev.calls} 呼び出し / {out['meta']['wall_seconds']}s", file=sys.stderr)
    print(f"→ {args.out}", file=sys.stderr)
    ev.stop()


if __name__ == "__main__":
    main()
