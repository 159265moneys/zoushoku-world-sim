# src/ui — 画面

`python3 -m http.server` で `game/index.html` を開けば動く。ビルド手順はない。
依存の向きは **ui → sim → core** の一方向。ui から sim へは必ず `src/ui/api.js` 越しに触ること
（`src/sim/` を直接 import しない）。

---

## sim の切り替え

`api.js` の `DEFAULT_SOURCE` は **`'sim'`**（本物の `src/sim` が既定）。

| URL | 使う sim |
|---|---|
| `index.html` | `src/sim/index.js`（既定） |
| `index.html?sim=mock` | `src/ui/mock.js`（画面だけ触りたいとき） |

mock は捨て札として残してある。sim が壊れているときに画面側の切り分けをするためだけのもの。

## 世代の尺（時間の設計値との接続）

世代の長さは **2つの数の積**で決まる。画面が勝手に決めてよいのは片方もない。

| 数 | 出どころ | 値 |
|---|---|---|
| `TICKS_PER_GEN` | `src/sim/constants.js`（`api.TICKS_PER_GEN` 経由で引く） | 12 |
| `GEN_MS` | `src/core/model.js` | P1 = 2分／世代、P2 = 60分／世代 |

`main.js` は `GEN_MS[phase] / TICKS_PER_GEN` を1tickの実時間として回す。
**×1 が設計値そのもの**で、倍速ボタン（×1/×2/×4/×8）はこの尺に対する倍率。

- P1 ×1 → 1tick = 10秒、1世代 = 2分。sim の実測で10体到達が3〜4世代なので **6〜8分**
- P2 ×1 → 1tick = 5分、1世代 = 60分（×8 で 7分30秒）

> 以前は画面が独自に `TICK_MS=220ms × TICKS_PER_GEN=120` で回していた。
> 1世代26秒という尺の問題だけではなく、**sim に1世代あたり10倍のtickを流し込んでいた**
> （sim の経済と練度の伸びは12tick刻みで調律されている）。両方ここで直っている。

画面には尺が出る：トップ右に `経過 m:ss` と `1世代 2:00（設計値 2:00 ×1）`、
トップバーの下端2pxに世代の進捗バー。P1は10秒に1tickしか来ないので、
これが無いと「静かに進んでいる」と「フリーズ」が区別できない。

裏タブ対策として1フレームの `dt` 上限は 1200ms。160msに切っていたときは、
ブラウザが裏タブの `setInterval` を約1秒に絞るため **裏に回すと世界の時計が実時間の1/6**
になっていた（「1世代＝2分」が裏では12分）。

---

## adapter.js — ズレの吸収層

sim と UI は素直には噛み合わない。**ズレはすべて `src/ui/adapter.js` に閉じ込めてある。**
`src/sim` も UI 本体も変えない。

### 名前が違うもの

| UI が呼ぶ名 | `src/sim` |
|---|---|
| `powerOf` | `citizenPower` |
| `canonize` | `setCanon` |
| `stepRoster` | `advanceRoster` |
| `nationPower` | **対応物なし。adapter が合成している** |

> **`rankNation` は国力ではない。** 名前は似ているが、個体の**配列**を受け取って
> `homeRankPct` を焼き、並べ替えた配列を返す関数である。world を渡すと
> `people is not iterable` で落ちる。しかもこれは描画ループから毎フレーム呼ばれるので、
> 画面が起動直後に死ぬ。国力は adapter 側で `citizenPower` の総和から作っている。

### 形が違うもの

| UI が読む形 | `src/sim` の形 |
|---|---|
| `world.strains` = `{key:{key,name,hue 度}}` | `world.origins` = `Map(key -> {key,name,hue 0..1})` |
| `world.history[]` | `world.stats[]`（`yield` / `yieldRate` など名前も違う） |
| `world.borderQueue[]`（配列） | `world.border`（Map） |
| `world.warReady` / `intel` / `name` | 無い。adapter が導出・補完 |
| `advanceGeneration -> events[]` | `-> {events, …}` |
| `battle.a/.b.fighters[{state,fear,x,y}]` | `battle.sides.home/away.units[{dead,fled,stats}]` |
| `battle.outcome = 'win'\|'lose'` | `{kind,winner,loser}` |
| `battle.log[{text}]` | ラウンドごとの数値スナップショット |
| `publicRank -> {pct,label,value}` | 文字列 `'上位30%'` を返す |
| 具申の `title/gain/lose/motive` | `kind/stake/targetBureau`（誰が損得するかは持っていない） |
| カードの `name` / `desc` | `label` のみ（説明文は無い） |
| `startWar(w,rng,opponent)` の opponent | **`{people: 配列}` の形**（`listOpponents` の要素をそのまま渡すと落ちる） |

`fear`（目の細さ）と戦闘ログの文は sim に無いので、団結と `stats.nerve`、
および前フレームとの状態差分から adapter が作っている。

### adapter が値を写しているもの（名前も形も違わないが、意味が違う）

| UI が呼ぶ名 | 中身 |
|---|---|
| `TICKS_PER_GEN` | `sim.SIM_CONST.TICKS_PER_GEN`。世代の尺の分母 |
| `captiveOptions().countLabel` | 捕虜の**人数の幅**。`CAPTIVE_COUNT[開戦時のフェーズ]` から作る |
| `borderDecision(w, id, 'execute')` | sim の語彙は `'kill'`。**写さないと誅殺が accept に落ちて入国する** |
| `world.mixState` | `stats` の最新行から `{admixture, pure, foreign}` |

### 同化のメーターは「量」ではなく `admixture`

`mix_policy`（外来血を混ぜる）は **sim の `cards.js` に入った**ので、adapter の仮置きは撤去済み。

画面で気をつけるのはここから先で、**外来血の量（`foreign`）は同化のメーターにならない**。
隔離するとよそ者どうしで繁殖するので系統が薄まらず、量は多いまま混ざらない。

sim担当の実測（60世代・3種平均）：

| 融和度 | 外来血の量 | **混血度 `admixture`** | 純血個体 | 見え方 |
|---|---|---|---|---|
| 0%（隔離） | 38.1% | **0.006** | 96% | 斑のまま固定 |
| 50% | 9.2% | 0.083 | 37% | 斑 |
| 100%（融和） | 50.3% | **0.488** | 1% | 混色 |

量だけ見ると隔離(38%)と融和(50%)がほぼ同じに見えるが、混血度は **80倍**違う。
量で判定すると「隔離しているのに混ざってきた」と表示してしまい、
設計文書の「隔離政策 → 斑のまま固定」が画面の上で死ぬ。

よって血統HUD（`main.js` の `renderStrains`）は `admixture` を出す：
`単色 / 斑（固定） / 混ざりはじめ / 混色`。

---

## 画面一覧

| # | 画面 | ファイル | 出し方 |
|---|---|---|---|
| 1 | オープニング（7問・回答が第1世代の遺伝子になる） | `panels/opening.js` | 起動時に全画面 |
| 2 | シャーレ（メイン・Canvas） | `dish.js` | 常時 |
| 3 | 個体パネル（全ステ・家系・所属・履歴・実績） | `panels/inspector.js` | 右ドック「個体」／円をクリック |
| 4 | 配役（P1のみ）→ 人事（P2以降） | `panels/roles.js` | 右ドック「配役／人事」 |
| 5 | 帰還報告（3局1行＋重大イベント＋グラフ3本＋裁可待ち） | `panels/report.js` | 「帰還報告」ボタン／P2の世代境界で自動 |
| 6 | 具申（承認／却下） | `panels/petitions.js` | 右ドック「具申」＋報告モーダル内 |
| 7 | 検索（素質・年齢・役割・居住区・血統／ソート） | `panels/search.js` | 右ドック「検索」 |
| 8 | 年代記（上流／下流の展開・編む） | `panels/chronicle.js` | 右ドック「年代記」 |
| 9 | 戦闘（5対5・降伏は常に1つ） | `panels/battle.js` | 対戦相手選択から |
| 10 | 国境（階級のみ・受け入れ／誅殺／送還） | `panels/border.js` | 戦闘の「戦後処理へ」 |
| 11 | 対戦相手の選択（10国・国力のみ＋デバッグトグル） | `panels/opponents.js` | 「隣のシャーレ」ボタン |
| — | 方針カード（敷く） | `panels/policy.js` | 右ドック「方針」 |

補助：`dom.js`（DOMヘルパ）／`color.js`（見た目の規則）／`cards.js`（カード定義）／
`questions.js`（設問）／`main.js`（シェル・ループ）。

---

## 見た目の規則（`color.js`）

- **色相 = 血統の混合比**（出自。ステータス傾向ではない）。円環上の加重平均なので混血の子は必ず親の間に落ちる
- **彩度 = 練度**（`52 + 46 × 練度`）
- **明度 = 年齢/体力**（幼いと明るく、老いると暗い。傷病・疲労で更に落ちる）
- **目** = 縦長の楕円2つ。感応が高いほど大きく、恐怖で細くなり、死ぬと消える
- 村 = 中心の多角形（辺の数 = 発展段階 3〜9）、資源 = 小さい三角

### 色相の割り当てには制約が2つある

1. プレイヤーの自国は赤(0)。他国は **60度以上離す**。近い色を混ぜると
   「捕虜が1体入った瞬間に色が違う」が成立せず、看板がまるごと死ぬ
2. 赤の対蹠点（**180度付近**）を空ける。ほぼ正反対の色相どうしは円環上の中点がどちら回りか
   不安定になり、似た親から正反対の子色が出る

よって10国は **60..156 と 204..300** の2帯に配ってある（`mock.js` の `PROFILES`）。

---

## 実機で確認した通し

**本物の `src/sim`（既定）**でブラウザを開き、以下を通した（スクリーンショットで確認済み・コンソールエラー0）。

オープニング7問（回答でバーが動く）→ 二匹（アダム／イザナミ）→ 配役
→ 増える → 「隣のシャーレ」出現 → 相手選択（国力のみ＋デバッグ内訳）
→ 戦闘（自国=赤／デメテル=青、逃走で目が細くなる、降伏ボタンは常に1つ）
→ 国境（「デメテル 100%」「上位40%」だけ見える・3択）
→ **フェーズ2**（配役タブが人事に変わり「配役の画面は消えた」）→ 局長任命
→ 具申（軍務局長と農業局長が互いに讒言してくる）→ 帰還報告。

**看板の確認（本物の sim）**

| 場面 | 見え方 |
|---|---|
| 捕虜5体を受け入れた直後（35体） | 青が5体、赤の中で一目で分かる。内訳 自国86% / デメテル21%…→14% |
| 3戦・14世代後（95体） | 赤・鮭色・桃・赤紫・菫・橙が連続的に並び、境界が溶ける。混血 95/95、血統4系統 |

色相の実測分布：`0,1,2,3,6,8,9,10,15,17,29,294,317,323,329,334,337,…,359`
（純血の0から、外来228へ向かう中間色が連続して埋まっている）。

---

## 既知の穴

### 画面側

- **時計は `setInterval`**（`main.js` の `FRAME_MS`）。`requestAnimationFrame` は裏タブで止まり、
  タブを切り替えただけで世界の時計まで止まるため。裏タブでは約1秒に絞られるが、
  1フレームの `dt` 上限を 1200ms にしてあるので**実時間とはズレない**
- 個体が100体を超えたときの重なり具合は未検証（P2の上限100で試したのは47体まで）
- 帰還報告の「失われた歳月」（3世代を超えて放置した場合の要約）は未実装
- 年代記の「遡及の再調査」（過去の事件に諜報予算を投じて開ける）は未実装。v2に諜報局がないため
- 「配る／殺す／ぶつける／編む」のうち、**編む**だけ年代記に実装済み。残り3つは方針タブに枠だけ

### 序盤のビートシート（sim側で確定済み）

**配役 → 10体 → 初戦（5対5）→ 捕虜1体 → フェーズ2＝配役タブが消える。**

sim が `pendingFirstWar` を立てて10体でフェーズ移行を止めるので、
**初戦を通さないと部族にならない**。画面側の受けは3か所：

1. `adapter.js` の `refreshWarReady`：`pendingFirstWar` のあいだは不応期を無視して
   「隣のシャーレ」を必ず出す。ここを塞ぐと世界が10体で止まって行き止まりになる
2. `adapter.js` の `settleWar`：`battle.firstWar` なら `world.firstWarDone` を立てる（保険）
3. `main.js` の `announceFirstWar` / `announcePhase2`：この2つの節目だけモーダルで止める。
   フェーズ2の告知は「配役 → 人事」を取り消し線で見せる**喪失の演出**であって、解禁ではない

- **相手はほぼ常に「格上」**。ロスターが毎世代 `advanceRoster` で進むので国力差が開く。
  初戦だけは sim が同数・同格に固定するので、5対5は保たれる

### mock 側（本物の sim ができたら丸ごと捨てる）

- `mock.js` は画面を成立させるための最小実装。遺伝はアレル対＋アーム正規化まではやっているが、
  **AAA の判定基準（1000世代・劣性の潜伏の観測など）は満たしていない**
- 対戦相手の国力がこちらより高く出やすい（ロスターは毎世代 `stepRoster` で進むため）。
  初戦がだいたい「格上」になる。バランスは未調整
- 捕虜が1体だけだと外来の血が数世代で消えることがある。斑がはっきり出るのは戦を重ねてから
- `mock.js` は `world.names`（NameGiver）を world に持たせている。純粋関数寄りではない

### 検証環境の注意

- 素の `python3 -m http.server` は ES モジュールを強くキャッシュする。
  **ファイルを直したのに画面が変わらないときはポートを変えて開き直す**（`.claude/launch.json`）。
  実行中のモジュールが古いかどうかは
  `import('/game/src/ui/panels/xxx.js').then(m => m.関数名.toString())` で中身を見れば分かる
- **裏タブでスクリーンショットを撮ると Canvas が真っ黒に写る。** これは不具合ではなく、
  隠れたタブが新しいフレームを合成しないため。撮る直前に
  `window['増殖'].state.dish.draw(world)` を単独で呼ぶと正しく写る
- ブラウザは裏タブの `setInterval` を約1秒に絞るので、裏で放置すると進行が実時間より遅い。
  世代を進めたいだけなら `api.stepTick` / `api.advanceGeneration` を直接叩くほうが速い

---

## sim に期待している形

```js
createWorld(seed, answers, opts?) -> world      // answers = [{id, choice, effects:{遺伝子名: 増分}}]
stepTick(world, rng) -> events[]
advanceGeneration(world, rng) -> events[]
assignRole(world, id, role) / setDistrict(world, id, district) / appointBureau(world, key, id)
setCard(world, cardId, on, value)
search(world, filters) -> individuals[]         // {role, district, ageMin, ageMax, gene, geneMin, strain, sort, desc, includeDead}
chronicle(world, filters) -> events[]           // {kinds, genMin, genMax, actor, limit}
traceUp(world, eventId) -> events[] / traceDown(world, eventId) -> events[]
petitions(world, rng) -> petitions[]            // {id, bureau, bureauLabel, fromId, fromName, title, detail, gain, lose, motive, risk}
resolvePetition(world, id, approve, rng) -> events[]
createRoster(seed) -> roster                    // 10国
listOpponents(roster) -> [{id, name, hue, power, profile, profileName, profileDesc, pop, gen, world}]
peek(roster, id) -> world                       // デバッグ表示専用
stepRoster(roster, rng)
makeGhost(seed, phase, power) -> opponent       // ロスターが無いときの相手
startWar(world, rng, opponent) -> battle
stepBattle(battle, rng) -> events[]
surrender(battle) -> {food, captives, accepted, gap}
captiveOptions(battle) -> {won, axes:[{key,label}], count, poolSize, note}
takeCaptives(world, battle, axis, rng) -> captives[]   // world.borderQueue に積む
borderDecision(world, captiveId, 'accept'|'execute'|'return')
settleWar(world, battle)                        // 捕虜0でも必ず呼ぶ。フェーズ転換はここ
publicRank(world, ind) -> {pct, label, value?}  // 外国人は階級のみ、自国民は実値
powerOf(ind) / nationPower(world)
canonize(world, eventId, text, {truthful}) -> event   // 編む（任意）
```

### world / individual に期待しているフィールド

`core/model.js` の `makeVillage()` / `makeIndividual()` / `makeEvent()` に加えて、
画面が読んでいるもの：

| 場所 | フィールド | 用途 |
|---|---|---|
| world | `strains` `{key: {key, name, hue}}` | 血統の色。`self` も入れること（他国世界を覗くとき自国色が要る） |
| world | `events[]` `history[]` `borderQueue[]` | 年代記／グラフ／国境 |
| world | `warReady` `intel` `name` | 「隣のシャーレ」ボタン／年代記の開示水準／表示名 |
| individual | `lineage` `expressed` `skills` | 色相／レンジ表示／彩度 |
| individual | `foreign` `homeName` `rankPct` `inheritedGrudge` | 国境と個体パネル |
| event | `trueCause` `claimed` `canon` `revealed` `effects` | 年代記の上流・帰属・影響 |

`history[]` の1要素は `{gen, pop, yieldRate, consumption, morale, food, grudge}`。
`revealed === false` の事件について、画面は **`claimed` しか出さない**（真の原因は辿らない）。
