#!/usr/bin/env python3
"""pilot.py — 本探索の前に「予算」を決めるための下見。

答えたいのは3つだけ：
  1. 種ノイズ（同じ方針・違う種）と方針差（違う方針）のどちらが大きいか
     → 1方針あたり何種要るかが決まる。この企画が一度失敗した論点そのもの
  2. 短い世代（例：60世代）での順位は、200世代の順位を予測するか
     → 予測するなら段階1を短くして点数を稼げる
  3. 1本あたり何秒か

出力は標準出力に人が読める形で。ファイルは書かない。
"""
from __future__ import annotations

import argparse
import shlex
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from space import DIM, Evaluator, decode  # noqa: E402
from search import Runner, default_policy_vec, latin_hypercube  # noqa: E402

GAME_ROOT = HERE.parent.parent


def spearman(a, b):
    ra = np.argsort(np.argsort(a))
    rb = np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", default="local")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--policies", type=int, default=24)
    ap.add_argument("--seeds", type=int, default=8)
    ap.add_argument("--opponents", default="martial,agrarian")
    ap.add_argument("--long", type=int, default=200)
    ap.add_argument("--short", type=int, default=60)
    args = ap.parse_args()

    cmd = ([sys.executable, str(HERE / "stub_eval.py")] if args.eval == "stub"
           else ["node", str(HERE / "local_eval.mjs")] if args.eval == "local"
           else shlex.split(args.eval))
    opponents = [o.strip() for o in args.opponents.split(",")]
    ev = Evaluator(cmd=cmd, cwd=str(GAME_ROOT), gens=args.long, jobs=args.jobs)
    runner = Runner(ev, opponents, batch=200)
    rng = np.random.default_rng(7)

    vecs = list(latin_hypercube(args.policies, DIM, rng)) + [default_policy_vec()]
    seeds = list(range(101, 101 + args.seeds))

    out = {}
    for label, gens in (("long", args.long), ("short", args.short)):
        ev.gens = gens
        t0 = time.time()
        aggs = runner.run(vecs, seeds, tag=label)
        dt = time.time() - t0
        n = len(vecs) * len(seeds) * len(opponents)
        out[label] = aggs
        print(f"\n--- {label}: {gens}世代 × {len(vecs)}方針 × {len(seeds)}種 "
              f"× {len(opponents)}相手 = {n}本 / {dt:.0f}s "
              f"（{dt / max(1, n) * args.jobs:.2f}s/本・逐次換算）")
        means = np.array([a["power"] for a in aggs])
        within = np.array([np.std(a["per_seed"], ddof=1) for a in aggs])
        print(f"  方針間SD {means.std(ddof=1):8.1f}   種内SD(平均) {within.mean():8.1f}"
              f"   比 {means.std(ddof=1) / max(1e-9, within.mean()):.2f}")
        print(f"  power  min {means.min():.0f} / 中央 {np.median(means):.0f} / max {means.max():.0f}")
        print(f"  絶滅率 {np.mean([a['extinct_rate'] for a in aggs]):.1%}"
              f"  （全滅した方針 {sum(1 for a in aggs if a['extinct_rate'] > 0.9)}本）")
        # 何種あれば順位が安定するか（半分ずつに割って相関を見る）
        half = len(seeds) // 2
        a1 = np.array([np.mean(a["per_seed"][:half]) for a in aggs])
        a2 = np.array([np.mean(a["per_seed"][half:]) for a in aggs])
        print(f"  種を半分ずつに割ったときの順位相関 rho={spearman(a1, a2):.2f}"
              f"  （{half}種での再現性）")

    a = np.array([x["power"] for x in out["long"]])
    b = np.array([x["power"] for x in out["short"]])
    print(f"\n短い世代は長い世代の順位を予測するか: rho={spearman(a, b):.2f}")
    print(f"総評価 {ev.runs}本 / {ev.seconds:.0f}s")


if __name__ == "__main__":
    main()
