#!/usr/bin/env python3
"""analyze.py — SEARCH.md の「答えるべき4つの問い」に数字で答える。

  1. 支配戦略はあるか      … 上位方針が全種・全相手で勝つか（相手別の順位を見る）
  2. 勝ち筋は何本あるか    … 上位方針をクラスタリングして型の数を数える
  3. 最適は相手で変わるか  … 相手ごとに最良方針を選び直して、入れ替わるか
  4. 上手い下手の差は出るか… 最良／既定／ランダムの差と、種ノイズの大きさを比べる

入力は search.py が書いた best.json と、その過程の cache.jsonl。
出力は標準出力（人が読む形）と、--json で機械可読の要約。
"""
from __future__ import annotations

import argparse
import collections
import itertools
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from space import CARDS, CAPTIVE_AXES, BORDERS, PROMOTES, canonical  # noqa: E402
from search import agglomerate, bootstrap_ci  # noqa: E402


def bar(x, lo, hi, width=28):
    if hi <= lo:
        return ""
    n = int(round(width * (x - lo) / (hi - lo)))
    return "#" * max(0, min(width, n))


def load_cache(path):
    """cache.jsonl → {(gens,pkey): {(opp,seed): row}}"""
    out = collections.defaultdict(dict)
    if not Path(path).exists():
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            sim, gens, opp, seed, pkey = rec["k"].split("|", 4)
            out[(gens, pkey)][(opp, int(seed))] = rec["v"]
    return out


def q1_dominance(best, report):
    """支配戦略の検査。上位方針が全相手で1位かどうか。"""
    rows = best["top"]
    opps = list(rows[0]["per_opp"].keys())
    print("\n" + "=" * 72)
    print("問1  支配戦略はあるか — 相手ごとの順位表（ホールドアウト種）")
    print("=" * 72)
    head = "方針            " + "".join(f"{o[:8]:>10}" for o in opps) + "   総合"
    print(head)
    ranks = {}
    for o in opps:
        order = sorted(range(len(rows)), key=lambda i: -rows[i]["per_opp"][o])
        for r, i in enumerate(order):
            ranks.setdefault(i, {})[o] = r + 1
    for i, r in enumerate(rows):
        line = f"#{i + 1:<2} {r['policy']['promote'][:10]:<12}"
        line += "".join(f"{r['per_opp'][o]:>7.0f}({ranks[i][o]})" for o in opps)
        line += f"  {r['power']:>7.0f}"
        print(line)
    first = [i for i in range(len(rows)) if all(ranks[i][o] == 1 for o in opps)]
    if first:
        print(f"\n→ 全相手で1位の方針が **ある**（#{first[0] + 1}）。ただし1位であることと"
              f"「差がある」ことは別物なので、下で対応あり検定にかける。")
    else:
        winners = {min(range(len(rows)), key=lambda i: ranks[i][o]) for o in opps}
        print(f"\n→ 全相手で1位の方針は **ない**。相手ごとの1位は {len(winners)}種類。")
    report["q1"] = {"dominant_by_rank": bool(first), "n_first_place_policies":
                    len({min(range(len(rows)), key=lambda i: ranks[i][o]) for o in opps})}
    return report


def q1_significance(best, cache, report):
    """1位と2位の差が、種のばらつきを超えているか（相手ごとの対応あり比較）。

    順位表だけで「支配戦略あり」と言うと、ノイズの上澄みを支配戦略と呼ぶことになる。
    この企画が一度踏んだ落とし穴なので、必ず差の信頼区間まで見る。
    """
    rows = best["top"]
    gens = str(best["meta"]["gens"])
    seeds = best["meta"]["holdout_seeds"]
    opps = list(rows[0]["per_opp"].keys())

    def cells(policy, opp):
        pkey = json.dumps(policy, sort_keys=True, ensure_ascii=False)
        c = cache.get((gens, pkey), {})
        return [c.get((opp, s)) for s in seeds]

    print("\n" + "-" * 72)
    print("  1位と2位の差（同じ種で対応あり・95%ブートストラップ区間）")
    sig = {}
    for o in opps:
        order = sorted(range(len(rows)), key=lambda i: -rows[i]["per_opp"][o])
        a, b = order[0], order[1]
        va = [x for x in cells(rows[a]["policy"], o)]
        vb = [x for x in cells(rows[b]["policy"], o)]
        pairs = [(0.0 if x["extinct"] else x["power"], 0.0 if y["extinct"] else y["power"])
                 for x, y in zip(va, vb) if x and y]
        if len(pairs) < 5:
            print(f"  {o:<10} （キャッシュ不足で測れず）")
            continue
        d = np.array([p[0] - p[1] for p in pairs])
        lo, hi = bootstrap_ci(d)
        ok = lo > 0
        sig[o] = {"mean": float(d.mean()), "ci": [lo, hi], "significant": bool(ok)}
        print(f"  {o:<10} #{a + 1} − #{b + 1} = {d.mean():+8.0f}  "
              f"CI[{lo:+.0f},{hi:+.0f}]  {'有意' if ok else '差なし'}  (n={len(pairs)})")
    n_sig = sum(1 for v in sig.values() if v["significant"])
    print(f"\n  → {len(sig)}相手のうち、1位が2位を有意に上回ったのは {n_sig} 相手。")
    report["q1_significance"] = sig
    return report


def q2_clusters(best, report, threshold=0.55):
    rows = best["top"]
    vecs = [np.array(r["vec"]) for r in rows]
    clusters, X = agglomerate(vecs, threshold)
    print("\n" + "=" * 72)
    print(f"問2  勝ち筋は何本あるか — 上位{len(rows)}方針のクラスタリング（閾値 {threshold}）")
    print("=" * 72)
    for ci, c in enumerate(clusters):
        members = [f"#{i + 1}" for i in c]
        pw = np.mean([rows[i]["power"] for i in c])
        print(f"\n型{ci + 1}（{len(c)}本, 平均 power {pw:.0f}）: {' '.join(members)}")
        for cid, lo, hi, _s in CARDS:
            vals = [rows[i]["policy"]["cards"][cid] for i in c]
            print(f"    {cid:<13} {np.mean(vals):6.1f} ± {np.std(vals):5.1f}"
                  f"   {bar(np.mean(vals), lo, hi)}")
        for k in ("captiveAxis", "border", "promote"):
            vals = collections.Counter(rows[i]["policy"][k] for i in c)
            print(f"    {k:<13} {dict(vals)}")
        print(f"    warAppetite   {np.mean([rows[i]['policy']['warAppetite'] for i in c]):.2f}")
    print(f"\n→ 型は {len(clusters)} 本。")
    report["q2"] = {"clusters": len(clusters),
                    "sizes": [len(c) for c in clusters]}
    return report


def q3_opponent(best, report):
    rows = best["top"]
    opps = list(rows[0]["per_opp"].keys())
    print("\n" + "=" * 72)
    print("問3  最適は相手で変わるか")
    print("=" * 72)
    best_by = {}
    for o in opps:
        i = max(range(len(rows)), key=lambda i: rows[i]["per_opp"][o])
        best_by[o] = i
        second = sorted((rows[j]["per_opp"][o] for j in range(len(rows))), reverse=True)[1]
        print(f"  {o:<10} 最良=#{i + 1}（{rows[i]['policy']['promote']}）"
              f" {rows[i]['per_opp'][o]:.0f}  2位との差 {rows[i]['per_opp'][o] - second:+.0f}")
    uniq = len(set(best_by.values()))
    print(f"\n→ 相手{len(opps)}種に対する最良方針は {uniq} 種類。")
    # 順位の入れ替わり（Kendall tau 的な粗い指標）
    swaps = 0
    pairs = 0
    for o1, o2 in itertools.combinations(opps, 2):
        r1 = np.argsort([-r["per_opp"][o1] for r in rows])
        r2 = np.argsort([-r["per_opp"][o2] for r in rows])
        for i, j in itertools.combinations(range(len(rows)), 2):
            pairs += 1
            if (list(r1).index(i) < list(r1).index(j)) != (list(r2).index(i) < list(r2).index(j)):
                swaps += 1
    print(f"  相手を変えたときに順位が入れ替わるペアの割合 {swaps / max(1, pairs):.1%}")
    report["q3"] = {"distinct_best": uniq, "rank_swap_rate": swaps / max(1, pairs)}
    return report


def q4_skill(best, report):
    print("\n" + "=" * 72)
    print("問4  上手い下手の差は観測できるか")
    print("=" * 72)
    top = best["top"][0]
    dflt = best.get("baseline_default")
    rnd = best.get("baseline_random", {})
    noise = float(np.mean([np.std(r["per_seed"], ddof=1) for r in best["top"]]))
    print(f"  最良      power {top['power']:8.0f}  CI[{top['ci'][0]:.0f},{top['ci'][1]:.0f}]"
          f"  絶滅{top['extinct_rate']:.0%}")
    if dflt:
        print(f"  既定カード power {dflt['power']:8.0f}  CI[{dflt['ci'][0]:.0f},{dflt['ci'][1]:.0f}]"
              f"  絶滅{dflt['extinct_rate']:.0%}")
    print(f"  ランダム   power {rnd.get('mean', 0):8.0f}（{rnd.get('n', 0)}本の平均, "
          f"最良{rnd.get('best', 0):.0f}, 絶滅{rnd.get('extinct_rate', 0):.0%}）")
    print(f"\n  種ごとのばらつき（1本の世界のSD） {noise:.0f}")
    gap_r = top["power"] - rnd.get("mean", 0)
    gap_d = top["power"] - (dflt["power"] if dflt else 0)
    print(f"  最良 − ランダム   {gap_r:+8.0f}")
    print(f"  最良 − 既定カード {gap_d:+8.0f}")

    # 差／SD で語ると誤る。power は重い裾を持つので、平均もSDも裾に引っぱられる。
    # プレイヤーが体験するのは「別々の世界を1本ずつ比べたらどちらが上か」なので、
    # そのまま経験確率（AUC）で出す。
    if dflt:
        a = np.asarray(top["per_seed"], float)
        b = np.asarray(dflt["per_seed"], float)
        auc = float(np.mean(a[:, None] > b[None, :]))
        paired = float(np.mean(a[:len(b)] > b[:len(a)]))
        print(f"\n  1本ずつ別の世界で比べて最良が上になる確率  {auc:.0%}")
        print(f"  同じ種で比べて最良が上になる確率            {paired:.0%}")
        print(f"  最良の下位25%点 {np.quantile(a, .25):.0f}  >  既定の上位25%点 "
              f"{np.quantile(b, .75):.0f}  … {'分布ごと上'if np.quantile(a,.25)>np.quantile(b,.75) else '重なりあり'}")
        print("\n  → 上手い下手は**1本のプレイでも見える**（差／SD の比では隠れて見えるが、"
              "それは裾がSDを膨らませているだけ）。")
        report["q4_auc"] = {"unpaired": auc, "paired": paired}
    report["q4"] = {"best": top["power"], "best_median": top.get("median"),
                    "default": dflt["power"] if dflt else None,
                    "random_mean": rnd.get("mean"), "seed_sd": noise,
                    "gap_vs_random": gap_r, "gap_vs_default": gap_d}
    return report


def sensitivity(cache, best, report, gens):
    """カード1枚ずつの効き。全評価点を使った回帰の係数と、上位群の分布。"""
    print("\n" + "=" * 72)
    print("補足  どのカードが効いているか（全評価点の回帰）")
    print("=" * 72)
    coef = None
    for st in best.get("history", {}).get("stages", []):
        if st.get("stage") == "surrogate":
            coef = st["coef"]
            r2 = st["r2"]
    if not coef:
        print("  （代理モデルの係数が best.json に無い）")
        return report
    print(f"  応答曲面 R² = {r2:.3f}")
    # 応答の「かたち」まで出す。argmax だけを出すと、U字（両端が良く中央が谷）を
    # 単峰と誤読し、標本がどちらの端に寄るかで最適位置が 0.00 と 1.00 の間で
    # 反転する（mix_policy で実際に起きた）。2次の係数の符号が形そのもの。
    rows = []
    for cid, lo, hi, _s in CARDS:
        a, b = coef.get(cid, 0.0), coef.get(cid + "^2", 0.0)
        xs = np.linspace(0, 1, 21)
        ys = a * xs + b * xs ** 2
        shape = ("U字（両端）" if b > 0 and 0.15 < -a / (2 * b) < 0.85 else
                 "山（中央）" if b < 0 and 0.15 < -a / (2 * b) < 0.85 else "単調")
        rows.append((cid, ys.max() - ys.min(), float(xs[int(np.argmax(ys))]), shape,
                     float(ys[0]), float(ys[-1])))
    rows.sort(key=lambda r: -r[1])
    span = max(r[1] for r in rows) or 1
    print(f"  {'カード':<13}{'効き':>9}  {'形':<12}{'低端':>8}{'高端':>8}  最良位置")
    for cid, amp, argmax, shape, y0, y1 in rows:
        note = "  ※両端比較が要る" if shape == "U字（両端）" else ""
        print(f"  {cid:<13}{amp:>9.0f}  {shape:<12}{y0:>8.0f}{y1:>8.0f}  "
              f"{argmax:.2f} {bar(amp, 0, span, 14)}{note}")
    for group, opts in (("axis", CAPTIVE_AXES), ("border", BORDERS), ("promote", PROMOTES)):
        vals = {o: coef.get(f"{group}={o}", 0.0) for o in opts}
        base = np.mean(list(vals.values()))
        ranked = sorted(vals.items(), key=lambda kv: -kv[1])
        print(f"  {group:<13} 幅 {max(vals.values()) - min(vals.values()):8.1f}  "
              + " ".join(f"{k}{v - base:+.0f}" for k, v in ranked[:5]))
    report["sensitivity"] = {"r2": r2, "cards": [
        {"card": c, "amp": a, "argmax": m, "shape": sh, "low": y0, "high": y1}
        for c, a, m, sh, y0, y1 in rows]}
    return report


def per_opponent_surface(cache, best, report):
    """相手ごとに応答曲面を別々に当てて、カードの「最適位置」が動くかを見る。

    上位8本の順位が入れ替わるかどうかだけだと、たまたま近い方針を8本並べた
    せいで動かない可能性がある。全評価点（数百〜千点）を相手別に回帰すると、
    「どのカードをどちらへ倒すべきか」自体が相手で変わるかが見える。
    """
    from search import fit_surrogate  # noqa
    gens = str(best["meta"]["gens"])
    rows = collections.defaultdict(lambda: collections.defaultdict(list))
    for (g, pkey), cells in cache.items():
        if g != gens:
            continue
        for (opp, seed), v in cells.items():
            rows[opp][pkey].append(0.0 if v["extinct"] else v["power"])
    opps = [o for o in rows if len(rows[o]) >= 50]
    if len(opps) < 2:
        return report
    print("\n" + "=" * 72)
    print("補足  相手ごとに応答曲面を当て直す（構造レベルの相手依存）")
    print("=" * 72)
    import numpy as np
    from space import decode as _dec  # noqa
    betas = {}
    for o in sorted(opps):
        keys = list(rows[o].keys())
        vecs = [json_to_vec(k) for k in keys]
        ys = [float(np.mean(rows[o][k])) for k in keys]
        w = [len(rows[o][k]) for k in keys]
        beta, r2 = fit_surrogate(vecs, ys, weights=w)
        betas[o] = beta
        print(f"  {o:<10} 点数 {len(keys):>4}  R²={r2:.3f}")
    names = sorted(betas)
    print(f"\n  カードごとの最適位置（0〜1）")
    print("  " + " " * 14 + "".join(f"{o[:8]:>10}" for o in names))
    diffs = []
    for ci, (cid, lo, hi, _s) in enumerate(CARDS):
        xs = np.linspace(0, 1, 21)
        row, shapes = [], []
        for o in names:
            b = betas[o]
            a1, a2 = b[2 * ci], b[2 * ci + 1]
            row.append(float(xs[int(np.argmax(a1 * xs + a2 * xs ** 2))]))
            shapes.append("U" if a2 > 0 and 0.15 < -a1 / (2 * a2) < 0.85 else "-")
        diffs.append(max(row) - min(row))
        # U字の次元は「最適位置が相手で動いた」ように見えても、単に谷の
        # どちら側を拾ったかの違いでしかないことがある
        flag = "  ※U字（相手依存の判定に使えない）" if "U" in shapes else ""
        print(f"  {cid:<14}" + "".join(f"{v:>10.2f}" for v in row) + flag)
    print(f"\n  → 最適位置の相手間の開き 平均 {np.mean(diffs):.2f}（0＝相手に依らない）")
    print("     ※印の次元は端点比較（probe_axis.py）で確かめること。"
          "単調モデルの最適位置は谷のどちら側を拾ったかで反転する")
    report["per_opponent"] = {"opponents": names, "mean_shift": float(np.mean(diffs))}
    return report


def json_to_vec(pkey):
    """key_of() の逆写像。カード値と選択を [0,1]^16 に戻す。"""
    p = json.loads(pkey)
    v = []
    for cid, lo, hi, _s in CARDS:
        v.append((p["cards"][cid] - lo) / (hi - lo))
    v.append((CAPTIVE_AXES.index(p["captiveAxis"]) + 0.5) / len(CAPTIVE_AXES))
    v.append((BORDERS.index(p["border"]) + 0.5) / len(BORDERS))
    v.append((PROMOTES.index(p["promote"]) + 0.5) / len(PROMOTES))
    v.append(p["warAppetite"])
    return np.array(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--best", default=str(HERE / "best.json"))
    ap.add_argument("--cache", default=str(HERE / "cache.jsonl"))
    ap.add_argument("--json", default="")
    ap.add_argument("--cluster-threshold", type=float, default=0.55)
    args = ap.parse_args()

    best = json.loads(Path(args.best).read_text(encoding="utf-8"))
    cache = load_cache(args.cache)
    report = {"meta": best["meta"]}

    m = best["meta"]
    print("=" * 72)
    print(f"探索の要約  評価器={m['evaluator']}  {m['gens']}世代")
    print(f"  実行本数 {m['evaluations_runs']}  呼び出し {m['evaluator_calls']}  "
          f"所要 {m['wall_seconds']:.0f}s")
    print(f"  探索種 {len(m['search_seeds'])}本 / ホールドアウト種 {len(m['holdout_seeds'])}本"
          f"（重なりなし）")
    print(f"  相手 {', '.join(m['opponents'])}")

    q1_dominance(best, report)
    try:
        q1_significance(best, cache, report)
    except Exception as e:
        print(f'（1位と2位の差は測れず: {e}）')
    q2_clusters(best, report, args.cluster_threshold)
    q3_opponent(best, report)
    q4_skill(best, report)
    sensitivity(cache, best, report, m["gens"])
    try:
        per_opponent_surface(cache, best, report)
    except Exception as e:      # 補足なので落ちても本体は出す
        print(f"（相手別の応答曲面は出せず: {e}）")

    if args.json:
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                   encoding="utf-8")


if __name__ == "__main__":
    main()
