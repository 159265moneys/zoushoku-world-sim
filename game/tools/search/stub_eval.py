#!/usr/bin/env python3
"""stub_eval.py — tools/eval.js が出来るまでの代役（**ダミー**）。

契約（tools/SEARCH.md）と同じ入出力だけを守った偽物。ゲームの再実装ではない。
探索器を先に完成させて「探索器が正しく動くか」を検証するためだけに使う。

検証しやすいよう、真の構造を**わざと既知**にしてある：

  * 山は2本（A型「武」／B型「農」）＋ 誘い水の低い偽ピーク1本
  * 相手依存：A型は agrarian 相手に強く、B型は martial 相手に強い（最適が相手で変わる）
  * 崖：備蓄が薄く派遣が厚いと絶滅する領域がある
  * 種ノイズ：SD ≒ 山の高さの 0.6 倍。30種で平均を取らないと順位が入れ替わる

**この山を見つけられない探索器は、本物の eval.js でも何も見つけられない。**
"""
from __future__ import annotations

import hashlib
import json
import math
import sys

CARD_RANGE = {
    "deploy_top": (0, 100), "spare_old": (2, 12), "raise_young": (0, 100),
    "guards": (0, 5), "drill": (0, 60), "surrender_at": (0, 90),
    "hunt_ratio": (0, 80), "stockpile": (0, 60), "frontier": (0, 100),
    "ration_equal": (0, 100), "hereditary": (0, 100), "mix_policy": (0, 100),
}

# 真の最適（0-1正規化）。探索器の答え合わせに使う。
PEAK_A = {  # 武断型
    "deploy_top": 0.70, "spare_old": 0.55, "raise_young": 0.45, "guards": 0.20,
    "drill": 0.45, "surrender_at": 0.10, "hunt_ratio": 0.60, "stockpile": 0.35,
    "frontier": 0.60, "ration_equal": 0.30, "hereditary": 0.40, "mix_policy": 0.70,
}
PEAK_B = {  # 農本型
    "deploy_top": 0.25, "spare_old": 0.40, "raise_young": 0.15, "guards": 0.10,
    "drill": 0.10, "surrender_at": 0.55, "hunt_ratio": 0.20, "stockpile": 0.75,
    "frontier": 0.20, "ration_equal": 0.75, "hereditary": 0.35, "mix_policy": 0.85,
}
PEAK_FAKE = {k: 0.5 for k in CARD_RANGE}   # 中庸＝そこそこ良いが天井が低い


def _n(cards, k):
    lo, hi = CARD_RANGE[k]
    return (float(cards.get(k, (lo + hi) / 2)) - lo) / (hi - lo)


def _dist(cards, peak, w=None):
    s = 0.0
    for k, target in peak.items():
        d = _n(cards, k) - target
        s += (w.get(k, 1.0) if w else 1.0) * d * d
    return math.sqrt(s / len(peak))


def _rand(*parts) -> float:
    h = hashlib.blake2b(("|".join(str(p) for p in parts)).encode(), digest_size=8)
    return int.from_bytes(h.digest(), "big") / 2**64


def _gauss(*parts) -> float:
    u = max(1e-9, _rand("u", *parts))
    v = _rand("v", *parts)
    return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)


def score(policy, seed, opponent, gens):
    cards = policy.get("cards", {})
    ax, bd = policy.get("captiveAxis", "総合"), policy.get("border", "accept")
    pr, wa = policy.get("promote", "merit"), float(policy.get("warAppetite", 0.5))

    hA = 900 * math.exp(-(_dist(cards, PEAK_A) / 0.26) ** 2)
    hB = 860 * math.exp(-(_dist(cards, PEAK_B) / 0.26) ** 2)
    hF = 430 * math.exp(-(_dist(cards, PEAK_FAKE) / 0.30) ** 2)

    # 選択の寄与：山ごとに違う組み合わせが要る（＝カードだけでは決まらない）
    hA *= 1.0 + 0.16 * (pr == "martial") + 0.10 * (ax == "武力") + 0.12 * (wa - 0.5)
    hB *= 1.0 + 0.16 * (pr == "agrarian") + 0.10 * (ax == "器用") - 0.12 * (wa - 0.5)
    base = max(hA, hB, hF) + 0.25 * min(hA, hB)
    base *= 1.0 + 0.08 * (bd == "accept") - 0.10 * (bd == "kill")

    # 相手依存（設計主張3のミニチュア）
    opp = {"martial": (-0.10, +0.12), "agrarian": (+0.12, -0.10)}.get(opponent, (0.0, 0.0))
    base *= 1.0 + (opp[0] if hA >= hB else opp[1])

    # 崖：派遣が厚く備蓄が薄いと国が保たない
    risk = max(0.0, _n(cards, "deploy_top") - 0.55) + max(0.0, 0.30 - _n(cards, "stockpile"))
    extinct = _rand("ex", seed, opponent, json.dumps(cards, sort_keys=True)) < min(0.9, risk * 0.8)

    noise = 0.6 * 900 * 0.35 * _gauss(seed, opponent, json.dumps(policy, sort_keys=True, ensure_ascii=False))
    power = max(0.0, base + noise)
    return power, extinct, base


def main():
    req = json.load(sys.stdin)
    gens = req.get("gens", 200)
    seeds = req.get("seeds", [1])
    opponents = req.get("opponents") or ["martial"]
    results = []
    for pol in req.get("policies", []):
        for seed in seeds:
            for opp in opponents:
                power, extinct, base = score(pol, seed, opp, gens)
                results.append({
                    "id": pol.get("id"), "seed": seed, "opponent": opp,
                    "power": 0 if extinct else round(power, 1),
                    "pop": 0 if extinct else round(20 + power * 0.12, 1),
                    "gens": gens, "extinct": bool(extinct),
                    "wins": round(5 + 5 * _rand("w", seed, opp, pol.get("id"))),
                    "losses": round(5 * _rand("l", seed, opp, pol.get("id"))),
                    "admixture": round(0.5 * _n(pol.get("cards", {}), "mix_policy"), 3),
                    "morale": round(0.3 + 0.4 * _rand("m", seed, opp, pol.get("id")), 3),
                    "regimeGrudge": round(20 * _rand("g", seed, opp, pol.get("id")), 2),
                    "yieldRate": round(base * 0.05, 2),
                })
    json.dump({"results": results, "stub": True}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
