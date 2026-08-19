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

### adapter が足しているカード

`world.mating.foreignBias`（-1 隔離 … +1 融和）は sim の交配が読んでいるが、
**それを動かすカードが sim 側に無く、既定 0 のまま動かない。**
「100体の段階で融和か優生かを選ばされる」はフェーズ2の中心なので、
`mix_policy` カードを adapter から足して、sim が読む値を書いている。

実測（同じ種・6戦・24世代）：

| 融和度 | 外来血の平均 | 外来25%以上の個体 |
|---|---|---|
| 0%（隔離） | 15.7% | 12 / 102 体 |
| 100%（融和） | 51.0% | 93 / 94 体 |

**これは本来 `src/sim/cards.js` に居るべきカード。** sim 側に入ったら adapter の分岐は消す。

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
  タブを切り替えただけで世界の時計まで止まるため。ただし**ブラウザは裏タブのタイマーを
  約1秒に絞る**ので、裏に回すと進行が遅くなる（止まりはしない）
- 世代の長さは `TICKS_PER_GEN = 120` × `TICK_MS = 220ms` ＝ ×1で約26秒。
  `core/model.js` の `GEN_MS`（P1で2分）とは合っていない。**体験の尺は未調整**
- 個体が100体を超えたときの重なり具合は未検証（P2の上限100で試したのは47体まで）
- 帰還報告の「失われた歳月」（3世代を超えて放置した場合の要約）は未実装
- 年代記の「遡及の再調査」（過去の事件に諜報予算を投じて開ける）は未実装。v2に諜報局がないため
- 「配る／殺す／ぶつける／編む」のうち、**編む**だけ年代記に実装済み。残り3つは方針タブに枠だけ

### 本物の sim に繋いだ結果ぶつかったこと（sim担当への申し送り）

- **フェーズ2が初戦より先に来る。** sim は人口10でフェーズを上げるので、
  初戦の時点で既に部族（配役タブが消えている）。設計表（P1が2→10、P2が10→100）
  どおりではあるが、「10体で初戦 → その戦利品でフェーズ2」という体験の順序にはなっていない
- **初戦の規模が5対5にならない。** 上の理由で、戦うころには人口が数十あり、
  `deploy_top` に従って26対83のような戦になる。戦闘画面は格子並びで折り返して耐えているが、
  「5対5だから個体が識別できる」という設計の狙いは出ていない
- **相手がほぼ常に「格上」**。ロスターが毎世代 `advanceRoster` で進むので国力差が開く
- `captiveOptions().count` は 1 を返すが `takeCaptives` は 3〜5体返す（数が合っていない）
- `world.mating.foreignBias` を動かすカードが無い（上記 `mix_policy` で暫定対応）

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
