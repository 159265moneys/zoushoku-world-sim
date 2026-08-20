"""方針空間と評価器クライアント。

探索空間は tools/SEARCH.md の契約そのまま：連続12枚 + 選択4つ。
内部表現は [0,1]^d の連続ベクトル（d = 12 + 3(one-hot風のスカラー) + 1）。
選択肢はスカラー1つを等分してカテゴリに落とす（山登り・DEがそのまま使える）。

評価器は黒箱。`node tools/eval.js` に JSON を投げて JSON を受け取るだけで、
Python側でゲームのルールを一切持たない（SEARCH.md の絶対規則）。
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from dataclasses import dataclass, field

# --- 12枚のカード（id, min, max, step） -----------------------------------
CARDS = [
    ("deploy_top",   0.0, 100.0, 5.0),
    ("spare_old",    2.0,  12.0, 1.0),
    ("raise_young",  0.0, 100.0, 10.0),
    ("guards",       0.0,   5.0, 1.0),
    ("drill",        0.0,  60.0, 5.0),
    ("surrender_at", 0.0,  90.0, 10.0),
    ("hunt_ratio",   0.0,  80.0, 5.0),
    ("stockpile",    0.0,  60.0, 5.0),
    ("frontier",     0.0, 100.0, 10.0),
    ("ration_equal", 0.0, 100.0, 10.0),
    ("hereditary",   0.0, 100.0, 10.0),
    ("mix_policy",   0.0, 100.0, 10.0),
]
CARD_IDS = [c[0] for c in CARDS]

# --- 4つの選択 -------------------------------------------------------------
CAPTIVE_AXES = ["総合", "武力", "知性", "統率", "繁殖性", "器用", "頑健"]
BORDERS = ["accept", "kill", "return"]
PROMOTES = ["martial", "agrarian", "fecund", "purist", "melting",
            "terror", "laissez", "pious", "merit", "dynastic"]

DIM = len(CARDS) + 4  # 16


def _quant(x: float, lo: float, hi: float, step: float) -> float:
    v = lo + (hi - lo) * min(1.0, max(0.0, x))
    v = round(v / step) * step
    return float(min(hi, max(lo, v)))


def _cat(x: float, options: list) -> str:
    i = int(min(1.0, max(0.0, x)) * len(options))
    return options[min(len(options) - 1, i)]


def _cat_index(x: float, n: int) -> int:
    return min(n - 1, int(min(1.0, max(0.0, x)) * n))


def decode(vec) -> dict:
    """[0,1]^16 → 方針dict（評価器に渡す形）"""
    cards = {}
    for i, (cid, lo, hi, step) in enumerate(CARDS):
        cards[cid] = _quant(vec[i], lo, hi, step)
    n = len(CARDS)
    return {
        "cards": cards,
        "captiveAxis": _cat(vec[n + 0], CAPTIVE_AXES),
        "border": _cat(vec[n + 1], BORDERS),
        "promote": _cat(vec[n + 2], PROMOTES),
        "warAppetite": round(min(1.0, max(0.0, float(vec[n + 3]))), 3),
    }


def canonical(vec):
    """量子化・カテゴリ化を経た後の代表ベクトル（重複判定・クラスタリング用）"""
    p = decode(vec)
    out = []
    for cid, lo, hi, step in CARDS:
        out.append((p["cards"][cid] - lo) / (hi - lo))
    out.append(CAPTIVE_AXES.index(p["captiveAxis"]) / (len(CAPTIVE_AXES) - 1))
    out.append(BORDERS.index(p["border"]) / (len(BORDERS) - 1))
    out.append(PROMOTES.index(p["promote"]) / (len(PROMOTES) - 1))
    out.append(p["warAppetite"])
    return out


def key_of(vec) -> str:
    p = decode(vec)
    return json.dumps(p, sort_keys=True, ensure_ascii=False)


# --- 評価器クライアント ---------------------------------------------------

@dataclass
class Evaluator:
    """`node tools/eval.js`（無ければ stub）に JSON を投げる黒箱クライアント。

    1回の呼び出しで policies × seeds × opponents を丸ごと渡す（起動コストの償却）。
    """
    cmd: list
    cwd: str
    gens: int = 200
    jobs: int = 1          # 同じ契約のプロセスを何本並べるか（方針で分割するだけ）
    serve: bool = False    # 常駐モード（NDJSON）。相手国ロスターを呼び出し間で使い回せる
    extra: dict = field(default_factory=dict)   # 契約の任意フィールド（snapshots など）
    restarts: int = 0
    calls: int = 0
    runs: int = 0          # policy×seed×opponent の実行本数
    seconds: float = 0.0
    log: list = field(default_factory=list)
    timeout: int = 36000
    _proc: object = None

    # --- 常駐モード -------------------------------------------------------
    def start(self):
        """`--serve` の評価器を1本立ち上げて繋ぎっぱなしにする。

        eval.js は種ごとに10国のロスター（10国×gens世代）を作り、それを
        リクエスト間でキャッシュする。呼び出しのたびにプロセスを起こすと
        この25秒級の固定費を毎回払うので、探索では常駐が必須。
        """
        import threading
        if self._proc is not None:
            return
        self._proc = subprocess.Popen(
            self.cmd, cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )

        def drain():
            for line in self._proc.stderr:
                line = line.rstrip()
                if line:
                    print(f"    {line}", file=sys.stderr)
        threading.Thread(target=drain, daemon=True).start()
        self.serve = True

    def stop(self):
        if self._proc is None:
            return
        try:
            self._proc.stdin.close()
            self._proc.wait(timeout=10)
        except Exception:
            self._proc.kill()
        self._proc = None

    def _serve_once(self, policies, seeds, opponents, gens):
        payload = {"policies": policies, "seeds": list(seeds),
                   "gens": gens, "opponents": list(opponents), **self.extra}
        self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError("評価器（--serve）が応答せずに終了した")
        out = json.loads(line)
        if "error" in out and "results" not in out:
            raise RuntimeError(f"evaluator error: {out['error']}")
        return out.get("results", [])

    def _serve_call(self, policies, seeds, opponents, gens):
        """評価器が落ちたら建て直して、半分に割って測り直す。

        相手国のスナップショットはメモリを食うので、機械が混んでいると
        評価器プロセスが黙って死ぬことがある。1回の呼び出しに数十分ぶんの
        計算を載せている以上、ここで諦めると探索が丸ごと消える。
        """
        try:
            return self._serve_once(policies, seeds, opponents, gens)
        except Exception as e:
            print(f"[evaluator] 落ちた（{e}）。建て直して分割して測り直す", file=sys.stderr)
            self.restarts += 1
            self.stop()
            self.start()
            if len(policies) <= 1 and len(seeds) <= 1:
                raise
            if len(seeds) > 1:
                rows = []
                for s in seeds:
                    rows.extend(self._serve_call(policies, [s], opponents, gens))
                return rows
            mid = len(policies) // 2
            return (self._serve_call(policies[:mid], seeds, opponents, gens)
                    + self._serve_call(policies[mid:], seeds, opponents, gens))

    def _one(self, policies, seeds, opponents, gens):
        payload = {"policies": policies, "seeds": list(seeds),
                   "gens": gens, "opponents": list(opponents), **self.extra}
        proc = subprocess.run(
            self.cmd, cwd=self.cwd, input=json.dumps(payload, ensure_ascii=False),
            capture_output=True, text=True, timeout=self.timeout,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"evaluator failed rc={proc.returncode}\n{proc.stderr[-4000:]}")
        return _parse_json(proc.stdout).get("results", [])

    def evaluate(self, policies: list, seeds: list, opponents: list, gens: int | None = None) -> list:
        gens = gens if gens is not None else self.gens
        t0 = time.time()
        if self.serve and self._proc is not None:
            rows = self._serve_call(policies, seeds, opponents, gens)
        elif self.jobs <= 1 or len(policies) <= 1:
            rows = self._one(policies, seeds, opponents, gens)
        else:
            from concurrent.futures import ThreadPoolExecutor
            k = min(self.jobs, len(policies))
            shards = [policies[i::k] for i in range(k)]
            rows = []
            with ThreadPoolExecutor(max_workers=k) as pool:
                for part in pool.map(lambda s: self._one(s, seeds, opponents, gens), shards):
                    rows.extend(part)
        dt = time.time() - t0
        self.calls += 1
        self.runs += len(rows)
        self.seconds += dt
        self.log.append({
            "call": self.calls, "policies": len(policies), "seeds": len(seeds),
            "opponents": len(opponents), "gens": gens, "rows": len(rows), "sec": round(dt, 2),
        })
        return rows


def _parse_json(text: str) -> dict:
    """stdout に混ざったログ行を跨いで、最初に現れる完全な JSON オブジェクトを拾う。"""
    text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    dec = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            obj, _ = dec.raw_decode(text[i:])
            if isinstance(obj, dict) and "results" in obj:
                return obj
        except Exception:
            continue
    raise RuntimeError(f"evaluator returned non-JSON:\n{text[:2000]}")
