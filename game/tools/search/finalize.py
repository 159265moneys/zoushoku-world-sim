#!/usr/bin/env python3
"""finalize.py — best.json に、判定器（tools/judge）が食える形の方針配列を足す。

tools/judge/run.js は `tools/search/best.json` を読み、
`policies` / `best` が **方針オブジェクトの配列**（id, cards, captiveAxis, border,
promote, warAppetite）であることを期待している。探索側の best.json は
成績つきの入れ子なので、ここで平らにして書き戻す。

同時に、キャッシュに残っている「十分な種数で測った方針」も候補に足す。
判定器は与えられた方針をクラスタリングして型の数を数えるので、
上位1本だけでなく**上位群**を渡さないと問2に答えられない。
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent


def load_cache(path):
    per = collections.defaultdict(dict)
    if not Path(path).exists():
        return per
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            sim, gens, opp, seed, pkey = rec["k"].split("|", 4)
            per[(gens, pkey)][(opp, int(seed))] = rec["v"]
    return per


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--best", default=str(HERE / "best.json"))
    ap.add_argument("--cache", default=str(HERE / "cache-eval.jsonl"))
    ap.add_argument("--cap", type=int, default=32)
    ap.add_argument("--min-runs", type=int, default=40,
                    help="候補に足すのに必要な最低評価本数（種×相手）")
    ap.add_argument("--from-cache", action="store_true",
                    help="best.json が無い（探索が途中で終わった）ときに、キャッシュだけで作る")
    ap.add_argument("--gens", type=int, default=200)
    args = ap.parse_args()

    if args.from_cache or not Path(args.best).exists():
        # 保険：探索が完走しなくても、そこまでに測った分から上位を出す
        best = {"meta": {"gens": args.gens, "search_seeds": list(range(1, 61)),
                         "holdout_seeds": [], "note": "cache only（探索は未完走）"},
                "top": []}
    else:
        best = json.loads(Path(args.best).read_text(encoding="utf-8"))
    gens = str(best["meta"]["gens"])
    search_seeds = set(best["meta"]["search_seeds"])

    out, seen = [], set()

    def add(policy, note, score):
        key = json.dumps(policy, sort_keys=True, ensure_ascii=False)
        if key in seen:
            return
        seen.add(key)
        out.append({"policy": policy, "note": note, "score": score})

    for i, r in enumerate(best.get("top", [])):
        add(r["policy"], f"holdout#{i + 1}", r["power"])

    # キャッシュから、探索種で十分に測った方針を拾う（上位群を厚くする）
    per = load_cache(args.cache)
    rows = []
    for (g, pkey), cells in per.items():
        if g != gens:
            continue
        vals = [(0.0 if v["extinct"] else v["power"])
                for (o, s), v in cells.items() if s in search_seeds]
        if len(vals) < args.min_runs:
            continue
        rows.append((float(np.mean(vals)), len(vals), pkey))
    rows.sort(reverse=True)
    for score, n, pkey in rows:
        if len(out) >= args.cap:
            break
        add(json.loads(pkey), f"search({n}本)", score)

    policies = []
    for i, o in enumerate(out[:args.cap]):
        p = dict(o["policy"])
        p["id"] = f"elite{i + 1:03d}"
        p["_note"] = o["note"]
        p["_score"] = round(o["score"], 1)
        policies.append(p)

    best["policies"] = policies
    Path(args.best).write_text(json.dumps(best, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"policies {len(policies)}本を best.json に書き込んだ（判定器が読む形）",
          file=sys.stderr)
    for p in policies[:10]:
        print(f"  {p['id']:<9} {p['_note']:<14} {p['_score']:>8}  "
              f"promote={p['promote']:<9} axis={p['captiveAxis']} border={p['border']}",
              file=sys.stderr)


if __name__ == "__main__":
    main()
