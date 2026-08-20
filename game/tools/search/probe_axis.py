#!/usr/bin/env python3
"""probe_axis.py — つまみを1つだけ動かして、同じ種で突き合わせる。

回帰（応答曲面）は空間全体の傾向を1本の式に潰すので、
**応答がU字だと符号が標本次第で反転する**（mix_policy で実際に起きた）。
1つの次元だけを端から端まで動かし、他は固定して、同じ種で対応比較するのが
その次元について言えることの上限であり、いちばん強い証拠になる。

  python3 probe_axis.py --dim border     --levels accept,kill,return --ref accept
  python3 probe_axis.py --dim mix_policy --levels 0,25,50,75,100     --ref 50

--base best（best.json の1位）/ default（カード既定値）/ ファイルパス。
基点1つだけの結論は基点に依存するので、**必ず2つ以上の基点で撃つこと**。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from space import CARD_IDS, CAPTIVE_AXES, BORDERS, PROMOTES, Evaluator  # noqa: E402
from search import DEFAULT_CARDS, bootstrap_ci, sim_fingerprint  # noqa: E402

GAME_ROOT = HERE.parent.parent
CHOICES = {"border": BORDERS, "captiveAxis": CAPTIVE_AXES, "promote": PROMOTES}


def base_policy(spec):
    if spec == "default":
        return ({"cards": dict(DEFAULT_CARDS), "captiveAxis": "総合", "border": "accept",
                 "promote": "merit", "warAppetite": 0.5}, "既定カード")
    if spec == "best":
        d = json.loads((HERE / "best.json").read_text(encoding="utf-8"))
        return (dict(d["top"][0]["policy"]), "探索1位")
    d = json.loads(Path(spec).read_text(encoding="utf-8"))
    return (d.get("policy", d), Path(spec).name)


def parse_seeds(spec):
    out = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return sorted(set(out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dim", required=True, help="カードid または border/captiveAxis/promote/warAppetite")
    ap.add_argument("--levels", required=True)
    ap.add_argument("--ref", default="", help="比較の基準にする水準（既定：先頭）")
    ap.add_argument("--base", default="best")
    ap.add_argument("--seeds", default="101-130", help="**選抜に使っていない種**を使うこと")
    ap.add_argument("--opponents", default="martial,agrarian")
    ap.add_argument("--gens", type=int, default=200)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--snapshots", type=int, default=10)
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    base, base_name = base_policy(args.base)
    levels = [x.strip() for x in args.levels.split(",")]
    numeric = args.dim in CARD_IDS or args.dim == "warAppetite"
    if numeric:
        levels = [float(x) for x in levels]
    ref = (float(args.ref) if (numeric and args.ref) else args.ref) or levels[0]

    policies = []
    for lv in levels:
        p = {"cards": dict(base["cards"]), "captiveAxis": base["captiveAxis"],
             "border": base["border"], "promote": base["promote"],
             "warAppetite": base["warAppetite"]}
        if args.dim in CARD_IDS:
            p["cards"][args.dim] = lv
        else:
            p[args.dim] = lv
        p["id"] = f"lv_{lv}"
        policies.append(p)

    seeds = parse_seeds(args.seeds)
    opponents = [o.strip() for o in args.opponents.split(",")]
    ev = Evaluator(cmd=["node", str(GAME_ROOT / "tools" / "eval.js"),
                        "--workers", str(args.workers)],
                   cwd=str(GAME_ROOT), gens=args.gens,
                   extra={"snapshots": args.snapshots})
    print(f"sim版 {sim_fingerprint()}  基点={base_name}  次元={args.dim}  "
          f"水準={levels}\n種 {len(seeds)}本 × 相手 {opponents} × {args.gens}世代 "
          f"= {len(policies) * len(seeds) * len(opponents)}行", file=sys.stderr)
    rows = ev.evaluate(policies, seeds, opponents)

    # (水準, 種) に畳む。相手は平均する（対応比較の単位は種）
    cell = {}
    for r in rows:
        k = (r["id"], r["seed"])
        cell.setdefault(k, []).append(0.0 if r["extinct"] else r["power"])
    wins_l = {}
    for r in rows:
        w, l = r.get("wins", 0), r.get("losses", 0)
        wins_l.setdefault(r["id"], []).append(
            0.0 if (r["extinct"] or w + l == 0) else w / (w + l))
    ext = {}
    for r in rows:
        ext.setdefault(r["id"], []).append(1 if r["extinct"] else 0)

    vec = {lv: np.array([np.mean(cell[(f"lv_{lv}", s)]) for s in seeds]) for lv in levels}
    print(f"\n{'水準':<10}{'平均':>10}{'中央':>10}{'勝率':>8}{'絶滅':>7}"
          f"{'基準に勝った種':>16}{'差の95%CI':>22}")
    out = {"dim": args.dim, "base": base_name, "sim": sim_fingerprint(), "levels": {}}
    for lv in levels:
        v = vec[lv]
        d = v - vec[ref]
        lo, hi = bootstrap_ci(d) if lv != ref else (0.0, 0.0)
        win = float(np.mean(v > vec[ref])) if lv != ref else float("nan")
        wr = float(np.mean(wins_l[f"lv_{lv}"]))
        ex = float(np.mean(ext[f"lv_{lv}"]))
        mark = "  ← 基準" if lv == ref else ""
        print(f"{str(lv):<10}{v.mean():>10.0f}{np.median(v):>10.0f}{wr:>8.2f}{ex:>7.0%}"
              f"{'' if lv == ref else f'{win:>13.0%} / {len(seeds)}'}"
              f"{'' if lv == ref else f'   [{lo:+.0f}, {hi:+.0f}]':>22}{mark}")
        out["levels"][str(lv)] = {"mean": float(v.mean()), "median": float(np.median(v)),
                                  "win_rate": wr, "extinct": ex,
                                  "beats_ref": None if lv == ref else win,
                                  "diff_ci": [lo, hi]}
    # U字（谷）かどうか。端が中央より高ければ双峰
    if numeric and len(levels) >= 3:
        mids = levels[1:-1]
        best_mid = max(mids, key=lambda m: vec[m].mean())
        ends = [levels[0], levels[-1]]
        u = all(vec[e].mean() > vec[best_mid].mean() for e in ends)
        print(f"\n  両端 {vec[ends[0]].mean():.0f} / {vec[ends[1]].mean():.0f}"
              f"  対  中間の最良（{best_mid}） {vec[best_mid].mean():.0f}"
              f"  → {'**U字（谷がある）。単調モデルでは符号が反転する**' if u else '単峰または単調'}")
        out["u_shaped"] = bool(u)
    if args.json:
        Path(args.json).write_text(json.dumps(out, ensure_ascii=False, indent=2),
                                   encoding="utf-8")


if __name__ == "__main__":
    main()
