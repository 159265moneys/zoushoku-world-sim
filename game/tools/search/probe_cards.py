#!/usr/bin/env python3
"""probe_cards.py — 12枚のカードのうち、どれが本当に効いているかを実測で確かめる。

grep で「読み手がいる／いない」を見るのは実装の話。探索が知りたいのは
**動かしたときに結果が変わるか**なので、両端（min / max）を同じ種で撃って比べる。

  ・結果がビット一致 → その次元は死んでいる。探索空間から外す（固定する）
  ・変わる           → 生きている。効きの大きさもここで見える

探索本番の前に必ず1回撃つこと。sim は書き換わる。
"""
from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from space import CARDS, Evaluator  # noqa: E402
from search import DEFAULT_CARDS, sim_fingerprint  # noqa: E402

GAME_ROOT = HERE.parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", default="eval")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--gens", type=int, default=120)
    ap.add_argument("--seeds", type=int, default=6)
    ap.add_argument("--opponent", default="martial")
    ap.add_argument("--snapshots", type=int, default=10)
    args = ap.parse_args()

    cmd = ["node", str(GAME_ROOT / "tools" / "eval.js"), "--workers", str(args.workers)]
    if args.eval != "eval":
        cmd = shlex.split(args.eval)
    ev = Evaluator(cmd=cmd, cwd=str(GAME_ROOT), gens=args.gens,
                   extra={"snapshots": args.snapshots})

    base = dict(DEFAULT_CARDS)
    policies = [{"id": "base", "cards": base, "captiveAxis": "総合", "border": "accept",
                 "promote": "merit", "warAppetite": 0.5}]
    for cid, lo, hi, _s in CARDS:
        for tag, val in (("lo", lo), ("hi", hi)):
            cards = dict(base)
            cards[cid] = val
            policies.append({"id": f"{cid}|{tag}", "cards": cards, "captiveAxis": "総合",
                             "border": "accept", "promote": "merit", "warAppetite": 0.5})
    seeds = list(range(201, 201 + args.seeds))
    print(f"sim版 {sim_fingerprint()}  {len(policies)}方針 × {len(seeds)}種 "
          f"× {args.gens}世代", file=sys.stderr)
    rows = ev.evaluate(policies, seeds, [args.opponent])

    by = {}
    for r in rows:
        by.setdefault(r["id"], {})[r["seed"]] = 0.0 if r["extinct"] else r["power"]
    b = np.array([by["base"][s] for s in seeds])
    print(f"\n既定カードの power: 平均 {b.mean():.0f}  SD {b.std(ddof=1):.0f}")
    print(f"\n{'カード':<14}{'min→power':>12}{'max→power':>12}{'差':>10}"
          f"{'同一?':>8}   （種{len(seeds)}本の平均）")
    dead = []
    for cid, lo, hi, _s in CARDS:
        v_lo = np.array([by[f"{cid}|lo"][s] for s in seeds])
        v_hi = np.array([by[f"{cid}|hi"][s] for s in seeds])
        same = bool(np.array_equal(v_lo, v_hi))
        if same:
            dead.append(cid)
        print(f"{cid:<14}{v_lo.mean():>12.0f}{v_hi.mean():>12.0f}"
              f"{v_hi.mean() - v_lo.mean():>+10.0f}{'★同一' if same else '':>8}")
    print(f"\n死んでいる次元（両端で完全一致）: {dead or 'なし'}")
    print(f"探索での指定: --freeze {','.join(dead)}" if dead else "全12枚が生きている")


if __name__ == "__main__":
    main()
