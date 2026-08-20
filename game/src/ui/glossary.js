// 用語辞書。画面に出る言葉は、全部ここを通す。
//
// 【なぜ1つのファイルに集めるか】
//   「代謝17だったらなんなん？」に答える場所が、これまでどこにも無かった。
//   1つずつ手で説明を書いて回る方式は必ず漏れる。だから
//   **辞書に載っていない語は画面に出せない**ようにして、漏れを検出可能にする
//   （dom.js の bar() / tile() / stat() が第1引数を「内部名」として受ける）。
//
// 【書いてあることの根拠】
//   「高いと」「低いと」は sim の実装を読んで書いてある。推測はしない。
//   根拠：sim/derive.js・sim/world.js・sim/battle.js・sim/cards.js・sim/constants.js
//   実装と食い違ったら、直すのは辞書のほう。**画面が嘘をつくのが一番まずい。**
//
// 【言葉の絶対規則】
//   1. 二字漢語の名詞を、和語の動詞に開く（具申→〜と言っている／粛清→殺す）
//   2. 敬語を使わない
//   3. 1文は40字以内。1つの用件に本文1文＋補足1文まで
//   4. 数字を出すときは、数字・単位・どちらが良いか の3つを同じ視界に置く

// ---------------------------------------------------------------------------
// フィールド
//   label … やさしい表示名。読める語は変えない
//   unit  … 'scale'|'pct'|'count'|'age'|'gen'|'index'|'none'
//   group … 'strong'|'normal'|'skill'|'chief'|'dead'（個体パネルの並び順とまとまり）
//   tag   … 行の右端に出す1文字の印。'畑'|'戦'|'増'|'心'|'血'|''
//   one   … 一言（必ず1文）
//   high  … 高いと何が起きるか（**全ての目盛りに必ず書く**）
//   low   … 低いと何が起きるか
//   note  … 補足（無ければ空）
//   dead  … true なら「いまの版では何も起きない」。正直に出す
// ---------------------------------------------------------------------------

// ============================================================ 生まれつき｜からだ（11）
const BODY = {
  頑健: {
    label: '丈夫さ', unit: 'scale', group: 'strong', tag: '戦',
    one: '体の頑丈さ。',
    high: '戦いで受ける傷が減り、体力が増える。狩りの事故で死ににくい。国の強さにも入る。',
    low: '一撃で倒れる。狩りで死にやすい。',
  },
  攻撃素質: {
    label: '戦いの才', unit: 'scale', group: 'strong', tag: '戦',
    one: '生まれつきの、攻める力。',
    high: '戦いの攻撃力が上がる。狩りの取れ高も上がる。国の強さに一番大きく入る。',
    low: '当てても相手が削れない。',
    note: '子どものうちに戦か狩りに置かないと、分からないままになる。',
  },
  器用: {
    label: '手先の器用さ', unit: 'scale', group: 'strong', tag: '畑',
    one: '手の正確さ。',
    high: '畑の取れ高が上がる。戦いで当たりやすく、急所にも当たりやすい。',
    low: 'よく外す。畑も伸びない。',
    note: '子どものうちに畑か狩りに置かないと、分からないままになる。',
  },
  代謝: {
    label: '大食い', unit: 'scale', group: 'normal', tag: '畑',
    one: '体の燃費。悪いほどよく食べる。',
    high: '食べる量が増える。そのかわり飢えに強くなる。',
    low: '少ない食べもので足りる。飢えると先に倒れる。',
  },
  寿命: {
    label: '寿命', unit: 'scale', group: 'normal', tag: '増',
    one: '何世代生きるか。0で4世代、100で13世代。',
    high: '長く生きる。腕を伸ばす時間が長い。',
    low: '4世代で死ぬ。育てても、すぐいなくなる。',
  },
  繁殖性: {
    label: '子だくさん', unit: 'scale', group: 'normal', tag: '増',
    one: '子ができやすさ。',
    high: '子ができる確率が上がる。「子がほしい」欲が強い。',
    low: '子ができにくい。人口が増えない。',
  },
  知性: {
    label: '知性', unit: 'scale', group: 'normal', tag: '心',
    one: '頭のよさ。',
    high: '国の強さに少し入る。国への恨みが溜まると、暴動の音頭を取る側になる。',
    low: '国の強さが少し下がる。暴動を起こさない。',
  },
  可塑: {
    label: '子が親と似ない度', unit: 'scale', group: 'normal', tag: '血',
    one: '子に渡すとき、遺伝子がどれだけ組み替わるか。',
    high: '100で45%が組み替わる。親と似ない子がよく出る。',
    low: '0で3%。親そっくりの子が続く。',
    note: 'この一体の力そのものには効かない。効くのは子の代。',
  },
  技術習得: {
    label: '覚えの早さ', unit: 'scale', group: 'normal', tag: '畑',
    one: '国の強さに少しだけ入る値。',
    high: '国の強さが少し上がる。捕虜を「手先の器用さ」で選ぶとき引かれやすい。',
    low: '国の強さが少し下がる。',
    note: '名前に反して、畑の取れ高にも戦いにも効かない。効くのは国の強さの計算だけ。',
    // 根拠: derive.js:153（citizenPower に重み0.10）/ battle.js:514（捕虜の軸）
  },
  生育速度: {
    label: '育ちの早さ', unit: 'scale', group: 'dead', tag: '戦', dead: true,
    one: 'いまの版では、何にも効かない。',
    high: '何も起きない。',
    low: '何も起きない。',
    note: '壊れ方が「気配に気づく」とは違う。'
      + '戦いの手数を出す式には入っているのに、その手数を読む場所が戦いの計算に無い。',
    // 根拠: derive.js:173 で speed を計算 → battle.js は speed を1度も読まない
  },
  感応: {
    label: '気配に気づく', unit: 'scale', group: 'dead', tag: '心', dead: true,
    one: 'いまの版では、あなたの国では何にも効かない。',
    high: '隣の国が人を選ぶときには効く。あなたの国では何も起きない。',
    low: '何も起きない。',
    note: '60問の診断で使う軸なので、消さずに残してある。',
  },
};

// ============================================================ 生まれつき｜こころ（22）
const MIND = {
  胆力: {
    label: '度胸', unit: 'scale', group: 'strong', tag: '戦',
    one: '怖くても動けるか。',
    high: '恐怖に耐えて逃げなくなる。国の強さにも入る。',
    low: '固まって、逃げる。',
    note: '子どものうちに戦か狩りに置かないと、分からないままになる。'
      + 'なお、逃げにくさは腕（逃げにくさ）のほうが強く効く（6対4）。',
  },
  保身: {
    label: '逃げぐせ', unit: 'scale', group: 'strong', tag: '戦',
    one: '危ない場所から離れたい気持ち。',
    high: '戦場で逃げる。長になりたがらない。戦・狩り・畑をいやがるので、置いても力が出ない。',
    low: '踏み止まる。責任を引き受ける。',
  },
  勤勉: {
    label: '勤勉', unit: 'scale', group: 'strong', tag: '畑',
    one: '言われなくても手を動かすか。',
    high: '畑の取れ高が最大1.35倍。畑に置かれるのを望む。',
    low: '「怠け」の欲が強い。疲れにくく少し長生きするが、取れ高が落ちる。',
  },
  感受性: {
    label: '心の振れ幅', unit: 'scale', group: 'strong', tag: '心',
    one: '7つの欲すべてに掛かる倍率（0.5〜1.5倍）。',
    high: '欲が全部強くなる。不満も大きくなる。戦場で逃げやすい。恨みが溜まると暴動の音頭を取る。',
    low: '何が起きても淡白。欲が弱いぶん、欲から出る手柄も出ない。',
    note: 'この値だけは他とけたが違う。他の22項目の効き目を、まとめて増やしたり減らしたりする。',
  },
  統率素質: {
    label: '人をまとめる才', unit: 'scale', group: 'normal', tag: '戦',
    one: '生まれつき人がついてくるか。',
    high: '戦いで味方全員の力を底上げする。国の強さにも入る。',
    low: '号令が通らない。',
    note: '子どものうちに戦か狩りに置かないと、分からないままになる。'
      + '腕の「まとめた経験」とは別物で、こちらは一生変わらない。',
  },
  共同作業適性: {
    label: '力を合わせる才', unit: 'scale', group: 'normal', tag: '畑',
    one: '人と組んで働けるか。',
    high: '畑の取れ高が1.15倍になる。国の強さにも入る。',
    low: '取れ高が0.85倍まで落ちる。一人ぶんしか働けない。',
    note: '子どものうちに畑か狩りに置かないと、分からないままになる。',
  },
  誇り: {
    label: '誇り', unit: 'scale', group: 'normal', tag: '心',
    one: '頭を下げたくない気持ち。',
    high: '戦場で逃げにくくなる（35%減）。そのかわり戦のあと国への恨みを溜める。',
    low: '恥をかいても平気。恨みも残らない。',
    note: '身内を殺されると恨みが跳ね上がる。',
  },
  他責: {
    label: '人のせいにする', unit: 'scale', group: 'normal', tag: '戦',
    one: 'うまくいかない原因を、外に置くか自分に置くか。',
    high: '「怒り」の欲が強まり、戦う力が最大28%上がる。',
    low: '自分を責める。戦う力は上がらない。',
  },
  私欲: {
    label: '自分の取り分', unit: 'scale', group: 'normal', tag: '畑',
    one: '取り分へのこだわり。',
    high: '「強欲」の欲が強まり、取れ高が22%増える。そのかわり収穫を隠す。',
    low: '隠さないが、増やしもしない。',
  },
  序列意識: {
    label: '上下が気になる', unit: 'scale', group: 'normal', tag: '心',
    one: '自分の順位を気にするか。',
    high: '「嫉妬」の欲が強まり、腕の伸びが25%早くなる。',
    low: '腕の伸びが遅い。不平等でも怒らない。',
    note: '食べものを不平等に配ると不満を溜める。',
  },
  団結傾向: {
    label: '群れる', unit: 'scale', group: 'normal', tag: '戦',
    one: '仲間と一緒にいたいか。',
    high: '戦いの「戦う気持ち」が一番大きく上がる。',
    low: '戦う気持ちが上がらない。',
  },
  信仰性: {
    label: '信じやすい', unit: 'scale', group: 'normal', tag: '戦',
    one: '見えないものを信じるか。',
    high: '戦いの「戦う気持ち」が上がる。',
    low: '戦う気持ちが上がらない。',
  },
  自律: {
    label: '単独行動', unit: 'scale', group: 'normal', tag: '戦',
    one: '一人で決めたいか。',
    high: '戦いの「戦う気持ち」が下がる。',
    low: '群れの気持ちを乱さない。',
  },
  従順: {
    label: 'さからわない', unit: 'scale', group: 'normal', tag: '畑',
    one: '上の言うことを聞くか。',
    high: '収穫を隠さない。国への恨みが溜まりにくい。',
    low: '収穫をごまかす。恨みを溜める。',
  },
  野心: {
    label: '野心', unit: 'scale', group: 'normal', tag: '心',
    one: '上に立ちたい気持ち。',
    high: '長になりたがる。「傲慢」の欲が強まり、まとめる力が最大30%増える。',
    low: '席を譲る。畑に置いても嫌がらない。',
    note: '畑仕事をいやがるので、置いても取れ高が伸びない。',
  },
  情愛: {
    label: '情に厚い', unit: 'scale', group: 'normal', tag: '心',
    one: '身内を大事にするか。',
    high: '戦で身内が死ぬと強く恨む。長になると「死んだ者の家族に食べものを回したい」と言い出す。',
    low: '身内が死んでも動じない。',
  },
  頑迷: {
    label: '頑固', unit: 'scale', group: 'chief', tag: '心',
    one: '自分のやり方を変えないか。',
    high: '長になったとき、あなたが決めた数字を自分の慣れた数字に引き戻す。',
    low: '決めた数字どおりに動く。',
    note: '村のあいだは長がいないので、何も起きない。',
  },
  柔軟: {
    label: '切り替えが早い', unit: 'scale', group: 'chief', tag: '心',
    one: '頑固さを打ち消す。',
    high: '長になっても、あなたが決めた数字どおりに動く。',
    low: '頑固がそのまま出る。',
    note: '村のあいだは長がいないので、何も起きない。',
  },
  非情: {
    label: '切り捨てられる', unit: 'scale', group: 'chief', tag: '心',
    one: '人を切ることに迷いがないか。',
    high: '長になると「あれを殺したい」と言い出しやすい。',
    low: '殺す話を持ってこない。',
    note: '村のあいだは長がいないので、何も起きない。',
  },
  好奇心: {
    label: '好奇心', unit: 'scale', group: 'chief', tag: '心',
    one: '本人の力には一切効かない。',
    high: '長になるとやり方を変えたがる。捕虜を「知性」で選ぶとき引かれやすい。',
    low: '同じやり方を続ける。',
    note: '村のあいだは長がいないので、何も起きない。',
  },
  世代間伝承意欲: {
    label: '教えたがり', unit: 'scale', group: 'dead', tag: '心', dead: true,
    one: 'いまの版では、あなたの国では何にも効かない。',
    high: '隣の国が人を選ぶときには効く。あなたの国では何も起きない。',
    low: '何も起きない。',
    note: '60問の診断で使う軸なので、消さずに残してある。',
  },
  懐疑: {
    label: '疑い深い', unit: 'scale', group: 'dead', tag: '心', dead: true,
    one: 'いまの版では、あなたの国では何にも効かない。',
    high: '隣の国が人を選ぶときには効く。あなたの国では何も起きない。',
    low: '何も起きない。',
    note: '60問の診断で使う軸なので、消さずに残してある。',
  },
};

// ============================================================ 腕（5）
// 使った仕事だけ伸びる。子には一切受け継がれない。
const SKILL = {
  恐怖耐性: {
    label: '逃げにくさ', unit: 'scale', group: 'skill', tag: '戦',
    one: '戦場で踏み止まれるか。',
    high: '逃げなくなる。生まれつきの「度胸」より、こちらのほうが効く（6対4）。',
    low: '逃げる。逃げる者が出るたび、味方の戦う気持ちが大きく減る。',
    note: '伸びる場所：戦 ≫ 訓練 > 狩り。村はずれに住むと何もしなくても少し伸びる。',
  },
  戦技: {
    label: '戦いの腕', unit: 'scale', group: 'skill', tag: '戦',
    one: '戦い方を体が覚えているか。',
    high: '守りと体力が増える。「戦いの才」の効きも上がる。',
    low: '才があっても実戦では出せない。',
    note: '伸びる場所：戦 ≳ 訓練 ≫ 狩り。',
  },
  統率: {
    label: 'まとめた経験', unit: 'scale', group: 'skill', tag: '戦',
    one: '人を動かしたことがあるか。',
    high: '味方の底上げが増える。',
    low: '才があっても号令が通らない。',
    note: '生まれつきの「人をまとめる才」とは別物。伸びる場所：戦 > 訓練。それ以外では伸びない。',
  },
  農技: {
    label: '畑の腕', unit: 'scale', group: 'skill', tag: '畑',
    one: '畑仕事の慣れ。',
    high: '畑の取れ高が増える。「手先の器用さ」「力を合わせる才」の効きも上がる。',
    low: '取れ高が伸びない。',
    note: '伸びる場所：畑だけ。',
  },
  狩技: {
    label: '狩りの腕', unit: 'scale', group: 'skill', tag: '畑',
    one: '狩りの慣れ。',
    high: '狩りの取れ高が増える。',
    low: '取れ高が伸びない。',
    note: '伸びる場所：狩りだけ。',
  },
};

// 腕のまとまりの先頭に本文として出す4行（world.js の gainSkills）
export const SKILL_LEAD =
  '村はずれに住むと1.33倍早い。食べものが乏しいほど早い。若いほど早い。'
  + '「上下が気になる」が高いほど早い。腕は子には一切受け継がれない。';

// こころのまとまりの先頭に出す1行
export const MIND_LEAD =
  'こころの値は隠れて、数代あとの子に出てくることがある。';

// ============================================================ 個体の派生値（タイル・名簿・戦）
const IND = {
  citizenPower: {
    label: '使える力', unit: 'scale', group: 'derived', tag: '',
    one: '体と腕だけを1つの数に潰したもの。',
    high: '戦っても働いても役に立つ。国の強さに積み上がる。',
    low: 'どこに置いても伸びない。',
    note: '忠誠心・野心・裏切りやすさは、この数字に入っていない。'
      + 'まだ分かっていない力も入っていない。だから「戦いの才98・国への恨み100」は見抜けない。',
  },
  training: {
    label: '腕', unit: 'scale', group: 'derived', tag: '',
    one: '5つの腕の平均。使った仕事だけ伸びる。',
    high: '実戦で才を出せる。',
    low: '才があっても出せない。',
    note: '子には受け継がれない。',
  },
  fatigue: {
    label: '疲れ', unit: 'scale', group: 'derived', tag: '',
    one: '働くと溜まり、休むと抜ける。',
    high: '力が最大30%落ちる。子もできにくくなる。',
    low: '全力が出せる。',
    note: '「何もしない」に置くと抜ける。',
  },
  unmet: {
    label: '不満', unit: 'scale', group: 'derived', tag: '',
    one: '7つの欲のうち、満たされていない分の合計。',
    high: 'みんなの気分が下がる。国への恨みに変わっていく。',
    low: '何も言ってこない。',
    note: '「心の振れ幅」が掛かるので、同じ扱いでも個体によって溜まり方が違う。',
  },
  vitality: {
    label: '血の傷み', unit: 'scale', group: 'derived', tag: '血',
    one: '近い血どうしで子を作ると溜まる、見えない欠陥の量。',
    high: '何をしても力が出ない。寿命も縮む。',
    low: '生まれつきの力がそのまま出る。',
    note: 'よその血が入ると戻る。',
  },
  homeRankPct: {
    label: '相手の国の中での順位', unit: 'pct', group: 'derived', tag: '',
    one: 'よその国の人について、外から見えるのはこれだけ。',
    high: '相手の国では上位。ただし弱い国の上位1%が、こちらでは平均以下ということが起きる。',
    low: '相手の国では下位。',
    note: '実際の数は出ない。忠誠心も、まだ開いていない力も、この順位には入っていない。',
  },
  lineage: {
    label: '血すじ', unit: 'pct', group: 'derived', tag: '血',
    one: 'この一体の色のもと。誰の血が何割入っているか。',
    high: 'その血が濃い。色相がその血の色に寄る。',
    low: 'その血は薄い。',
    note: '色相は血すじだけを表す。状態や所属は色では表さない。',
  },
  expressed: {
    label: 'まだ分かっていない力', unit: 'none', group: 'derived', tag: '',
    one: '6つだけは、子どものうちにその場に置かれないと分からないまま。',
    high: '数が多いほど、この一体の本当の力が読めていない。',
    low: '全部分かっている。数字どおりの一体。',
    note: '戦の3つ（戦いの才・度胸・人をまとめる才）は戦か狩り、'
      + '作る3つ（手先の器用さ・覚えの早さ・力を合わせる才）は畑か狩りで開く。',
  },
  grudges: {
    label: '個人への恨み', unit: 'scale', group: 'derived', tag: '心',
    one: '誰か1人に対する恨み。',
    high: 'その相手を落としにいく。',
    low: '何も抱えていない。',
    note: '相手が死ぬと消える。国への恨みとは別物。',
  },
  indGrudge: {
    label: '国への恨み', unit: 'scale', group: 'derived', tag: '心',
    one: '国そのものへの恨み。',
    high: '収穫を隠す。暴動の側に立つ。',
    low: '素直に働く。',
    note: '消えない。親から子へ62%継がれる。連れ帰った者の恨みも一緒に入ってくる。',
  },
};

// ============================================================ 国の値（上帯・報告）
const NATION = {
  phase: {
    label: 'いま', unit: 'none', group: 'nation', tag: '',
    one: 'あなたの国の大きさの段階。',
    high: '部族。一体ずつ仕事を決められず、3人の長を通して動かす。',
    low: '村。10体でいっぱいになる。全員が目の前にいる。',
  },
  gen: {
    label: '世代', unit: 'gen', group: 'nation', tag: '',
    one: '全員が一つ年を取ると1つ進む。',
    high: '長く続いている。',
    low: 'まだ始まったばかり。',
  },
  pop: {
    label: '人口', unit: 'count', group: 'nation', tag: '',
    one: '生きている数。子どもも入る。',
    high: '国の強さが増える。畑の広さを超えると1人あたりの取れ高が落ちる。',
    low: '作る手が足りない。5を切ると立て直せない。',
  },
  food: {
    label: '食べもの', unit: 'count', group: 'nation', tag: '畑',
    one: 'ためてある量。',
    high: '飢饉を1回ぶん耐えられる。',
    low: '0になると、弱い者から順に餓死する。',
  },
  yieldRate: {
    label: '作る量', unit: 'count', group: 'nation', tag: '畑',
    one: '1回あたりに作る食べものの量。',
    high: 'ためた食べものが増えていく。',
    low: '食べる量を下回り続けると、備えが減っていく。',
    note: '食べる量と必ず並べて見る。割り算した結果は出さない。',
  },
  consumption: {
    label: '食べる量', unit: 'count', group: 'nation', tag: '畑',
    one: '1回あたりに食べる量。人数と「大食い」で決まる。',
    high: '同じ取れ高でも減っていく。',
    low: '少ない取れ高で回る。',
  },
  land: {
    label: '畑の広さ', unit: 'count', group: 'nation', tag: '畑',
    one: '取れ高の上限を決める、ただ1つの資源。',
    high: '人を増やしても取れ高が落ちない。',
    low: '人が畑の広さを超えると、1人あたりの取れ高が落ちる。',
    note: '畑に人を置くと広がる。放っておくと痩せる。',
  },
  morale: {
    label: 'みんなの気分', unit: 'scale', group: 'nation', tag: '心',
    one: '不満と恨みと、こみぐあいから決まる。',
    high: '子が生まれやすい。',
    low: '子ができる確率が半分以下（0.45倍）に落ちる。暴動が起きやすい。',
  },
  regimeGrudge: {
    label: '国への恨み', unit: 'scale', group: 'nation', tag: '心',
    one: '国民の恨みの平均。',
    high: '25でくすぶる。50で危ない。75でいつ暴れてもおかしくない。',
    low: '落ち着いている。',
    note: '消えない。放っておくと12世代でおよそ半分になる。',
  },
  nationPower: {
    label: '国の強さ', unit: 'index', group: 'nation', tag: '',
    one: '国ぜんたいを1つの数に潰したもの。',
    high: '相手より大きければ勝ちやすい。',
    low: '相手より小さければ負けやすい。',
    note: '上限が無い数なので、単独では意味がない。必ず相手と並べて見る。'
      + '人数・使える力・食べもの・気分が混ざっていて、中身は復元できない。',
  },
  transparency: {
    label: '見えやすさ', unit: 'scale', group: 'nation', tag: '心',
    one: '家柄ではなく手柄で役が決まる度合い。',
    high: '無名でも引き上げられる。',
    low: '家柄が全部決める。手柄のない有能な者が国を恨みはじめる。',
  },
  admixture: {
    label: '混ざり具合', unit: 'pct', group: 'nation', tag: '血',
    one: '1 − いちばん多い血の割合。',
    high: '50で完全に混ざった。色が溶けていく。',
    low: '0で分かれたまま。まだら。',
    note: '「よその血の量」とは別物。必ず2つ並べて見る。',
  },
  foreign: {
    label: 'よその血の量', unit: 'pct', group: 'nation', tag: '血',
    one: 'よそから来た血が全体の何割か。',
    high: 'よその血が多く入っている。',
    low: 'ほとんど自分たちの血だけ。',
    note: '量が多くても、混ざっていなければ「まだら」のまま。混ざり具合と並べて見る。',
  },
  homoz: {
    label: '血の濃さ', unit: 'pct', group: 'nation', tag: '血',
    one: '同じ遺伝子が2本そろっている割合。',
    high: '隠れた欠陥が表に出る。血の傷みが溜まる。',
    low: '隠れた欠陥が表に出にくい。',
  },
  density: {
    label: 'こみぐあい', unit: 'scale', group: 'nation', tag: '',
    one: '人口が畑の広さをどれだけ超えているか。',
    high: 'みんなの気分が下がる。',
    low: '広さに余裕がある。',
  },
  collapsing: {
    label: '飢えている', unit: 'none', group: 'nation', tag: '畑',
    one: '食べる量が作る量を上回り続けている。',
    high: 'これが唯一の滅び方。畑に人を回すか、人を減らすしかない。',
    low: '足りている。',
  },
};

// ============================================================ 役・住む場所・組
const ROLE_T = {
  'role.farm': {
    label: '畑', unit: 'none', group: 'role', tag: '畑',
    one: '食べものを作る。',
    high: '取れ高がいちばん多い。畑の腕が伸びる。畑を広げるのはここに置いた人だけ。',
    low: '', note: '死なない。',
  },
  'role.hunt': {
    label: '狩り', unit: 'none', group: 'role', tag: '畑',
    one: '食べものを作りながら、戦いの腕も伸びる。',
    high: '狩りの腕・戦いの腕・逃げにくさが伸びる。作る才と戦う才の両方が分かる。',
    low: '取れ高は畑より少ない。', note: '事故で死ぬことがある。',
  },
  'role.drill': {
    label: '訓練', unit: 'none', group: 'role', tag: '戦',
    one: '食べものは作らない。安全に戦いの腕が伸びる。',
    high: '戦いの腕・逃げにくさ・まとめた経験が伸びる。',
    low: '食べものを1つも作らない。', note: 'ここでは死なない。',
  },
  'role.war': {
    label: '戦', unit: 'none', group: 'role', tag: '戦',
    one: '実戦に出ている。',
    high: '逃げにくさがいちばん伸びる。',
    low: '', note: '死ぬ。',
  },
  'role.idle': {
    label: '何もしない', unit: 'none', group: 'role', tag: '',
    one: '食べるだけで何も作らない。',
    high: '疲れだけが抜ける。',
    low: '腕が1つも伸びない。', note: 'ここに置いたままにしない。',
  },
  'role.child': {
    label: '子ども', unit: 'none', group: 'role', tag: '増',
    one: '2歳になるまで。',
    high: '半分の量しか食べない。',
    low: '',
    note: 'この間にどこに置かれたかで、6つの力が分かるかどうかが決まる。',
  },
};

const DIST_T = {
  'dist.center': {
    label: 'まんなか', unit: 'none', group: 'dist', tag: '畑',
    one: '畑がよく取れる場所。',
    high: '畑の取れ高が1.10倍。',
    low: '狩りは0.90倍。腕の伸びが村はずれより遅い。',
  },
  'dist.frontier': {
    label: '村はずれ', unit: 'none', group: 'dist', tag: '戦',
    one: '狩りがよく取れて、腕が早く伸びる場所。',
    high: '狩りの取れ高が1.20倍。腕の伸びが1.33倍。逃げにくさが何もしなくても伸びる。',
    low: '畑の取れ高が0.88倍に落ちる。',
    note: '獣と飢えがあるので、放っておいても肝が据わっていく。',
  },
};

const BUREAU_T = {
  'bureau.military': {
    label: '戦の組', unit: 'none', group: 'bureau', tag: '戦',
    one: '誰を戦に出すかを受け持つ。',
    high: '長がいると、戦のきまりがその人柄を通ってから効く。',
    low: '長がいないと、あなたの数字がそのまま通る。報告も願いも来ない。',
    note: '訓練にどれだけ回すか、いつ降りるかも、この組が決める。',
  },
  'bureau.agri': {
    label: '食べものの組', unit: 'none', group: 'bureau', tag: '畑',
    one: '畑と狩りの割り振りを受け持つ。',
    high: '長がいると、食べもののきまりがその人柄を通ってから効く。',
    low: '長がいないと、あなたの数字がそのまま通る。報告も願いも来ない。',
    note: '狩りも受け持つので「畑の組」ではない。',
  },
  'bureau.civil': {
    label: '暮らしの組', unit: 'none', group: 'bureau', tag: '心',
    one: 'どこに住まわせるか、どう配るかを受け持つ。',
    high: '長がいると、暮らしのきまりがその人柄を通ってから効く。',
    low: '長がいないと、あなたの数字がそのまま通る。報告も願いも来ない。',
    note: 'よその血を混ぜるかどうかも、この組が受け持つ。',
  },
};

// ============================================================ 方針カード（12）
// 表示名の {n} には、いま入っている実際の値が差し込まれる。
// **sim の label（`上位N%を派遣`）は画面に出さない。**
const CARD = {
  'card.deploy_top': {
    label: '強い順に {n}% を戦に出す', unit: 'pct', group: 'card', tag: '戦',
    one: '誰を戦場に送るか。',
    high: '勝ちやすい。ただし負けたとき、強い者から死ぬ。',
    low: '弱い者が死ぬ。勝てない。',
    bureau: 'military', range: '0〜100%（はじめは40）',
  },
  'card.spare_old': {
    label: '{n}歳より上は戦に出さない', unit: 'age', group: 'card', tag: '戦',
    one: '老いた者を戦場から外す。',
    high: '腕のある者が残る。出せる数が減る。',
    low: '数はそろうが、老人が死ぬ。',
    bureau: 'military', range: '2〜12歳（はじめは7）',
  },
  'card.raise_young': {
    label: '若い者の {n}% を戦に出して育てる', unit: 'pct', group: 'card', tag: '戦',
    one: '若手を実戦に出す。',
    high: '早く育つ。そのぶん死ぬ。',
    low: '死なないが、腕が伸びない。',
    bureau: 'military', range: '0〜100%（はじめは20）',
  },
  'card.guards': {
    label: '大事な者に {n}人の護衛を付ける', unit: 'count', group: 'card', tag: '戦',
    one: '上位の者に護衛を付ける。',
    high: '護衛が代わりに死ぬ。',
    low: '大事な者が直に狙われる。',
    bureau: 'military', range: '0〜5人（はじめは0）',
  },
  'card.drill': {
    label: '{n}% を訓練に回す', unit: 'pct', group: 'card', tag: '戦',
    one: '訓練にどれだけ人を割くか。',
    high: '安全に腕が伸びる。そのぶん食べものを作らない。',
    low: '食べものは増えるが、戦えない。',
    bureau: 'military', range: '0〜60%（はじめは10）',
  },
  'card.surrender_at': {
    label: '戦う気持ちが {n} を切ったら降参する', unit: 'scale', group: 'card', tag: '戦',
    one: 'あなたが見ていない間の、降りかたの決めごと。',
    high: '早く降りる。人は死なないが、取られるものが増える。',
    low: '0にすると最後まで降参しない。',
    bureau: 'military', range: '0〜90（はじめは0）',
  },
  'card.hunt_ratio': {
    label: '{n}% を狩りに回す', unit: 'pct', group: 'card', tag: '畑',
    one: '畑と狩りの割り振り。',
    high: '戦いの腕が伸びる。取れ高は畑より少なく、事故で死ぬ。',
    low: '取れ高は増えるが、誰も戦えない。',
    bureau: 'agri', range: '0〜80%（はじめは30）',
  },
  'card.stockpile': {
    label: '食べものを {n} より減らさない', unit: 'count', group: 'card', tag: '畑',
    one: 'ここまで減ったら、みんな畑に回す。',
    high: '飢えにくい。戦いの支度が進まない。',
    low: '攻めに回せるが、一度の飢饉で死ぬ。',
    bureau: 'agri', range: '0〜60個（はじめは15）',
  },
  'card.frontier': {
    label: '{n}% を村はずれに住まわせる', unit: 'pct', group: 'card', tag: '心',
    one: 'どこに住まわせるか。',
    high: '狩りがよく取れ、腕が伸びやすい。畑の取れ高は落ちる。',
    low: '畑は伸びるが、腕が伸びない。',
    bureau: 'civil', range: '0〜100%（はじめは20）',
  },
  'card.ration_equal': {
    label: '食べものを等しく配る（{n}%）', unit: 'pct', group: 'card', tag: '心',
    one: '配り方。',
    high: '不満が減る。よく働く者が、それ以上働かなくなる。',
    low: '働く者がもっと働く。下の者が恨みを溜める。',
    bureau: 'civil', range: '0〜100%（はじめは50）',
  },
  'card.hereditary': {
    label: '役目を親から子へ継がせる（{n}%）', unit: 'pct', group: 'card', tag: '心',
    one: '誰に役を継がせるか。',
    high: '家柄で決まる。無名の才が塞がれ、恨みに変わる。',
    low: '手柄で決まる。順番を抜かされた者が恨む。',
    bureau: 'civil', range: '0〜100%（はじめは50）',
  },
  'card.mix_policy': {
    label: 'よその血を混ぜる（{n}%）', unit: 'pct', group: 'card', tag: '血',
    one: '部族になって最初の、いちばん大きな決めごと。',
    high: '混ざる。血の傷みが治り、色が溶けていく。',
    low: '分けたまま。よその血は入っても混ざらず、まだらのまま何代も続く。',
    bureau: 'civil', range: '0〜100%（はじめは50）',
  },
};

// ============================================================ 戦・捕虜・国境
const BATTLE = {
  'battle.cohesion': {
    label: '戦う気持ち', unit: 'scale', group: 'battle', tag: '戦',
    one: '部隊がまだ立っていられるか。',
    high: '崩れない。',
    low: '0になると崩れて逃げ出す。逃げる者が出るたびに大きく減る。',
  },
  'battle.atk': {
    label: '攻める力', unit: 'scale', group: 'battle', tag: '戦',
    one: '相手を削る力。',
    high: '相手の体力を早く削る。', low: '当てても相手が減らない。',
  },
  'battle.def': {
    label: '守る力', unit: 'scale', group: 'battle', tag: '戦',
    one: '受ける傷を減らす。',
    high: '倒れにくい。', low: '一撃が重い。',
  },
  'battle.hp': {
    label: '体力', unit: 'count', group: 'battle', tag: '戦',
    one: 'あと何発耐えられるか。',
    high: '長く立っていられる。', low: '0になると死ぬか、大怪我をする。',
  },
  'battle.acc': {
    label: '当たりやすさ', unit: 'pct', group: 'battle', tag: '戦',
    one: '「手先の器用さ」で決まる。',
    high: 'よく当たる。', low: 'よく外す。',
  },
  'battle.crit': {
    label: '急所に当たる率', unit: 'pct', group: 'battle', tag: '戦',
    one: '「手先の器用さ」で決まる。',
    high: '一撃で大きく削る。', low: '削りが平らになる。',
  },
  'battle.nerve': {
    label: '踏み止まる力', unit: 'scale', group: 'battle', tag: '戦',
    one: '「逃げにくさ（腕）」6割 ＋ 「度胸（生まれつき）」4割。',
    high: '逃げない。', low: '逃げる。',
  },
  'battle.flee': {
    label: '逃げる率', unit: 'pct', group: 'battle', tag: '戦',
    one: '踏み止まる力・心の振れ幅・逃げぐせ・誇りから決まる。',
    high: '真っ先に逃げる。味方の戦う気持ちを削る。',
    low: '踏み止まる。',
  },
  'battle.lead': {
    label: '味方の底上げ', unit: 'scale', group: 'battle', tag: '戦',
    one: '「人をまとめる才」×「まとめた経験」。',
    high: '味方全員が強くなる。', low: '一人ぶんの働きしかない。',
  },
  'battle.rout': {
    label: '敗走', unit: 'none', group: 'battle', tag: '戦',
    one: '戦う気持ちが折れて、部隊が崩れた状態。',
    high: '崩れたあと、逃げていた者から先に死ぬ。',
    low: '',
    note: '戦いの画面が閉じたあとに起きる。',
  },
  'battle.surrender': {
    label: '降参する', unit: 'none', group: 'battle', tag: '戦',
    one: '負けを認めて、渡すものを渡す。',
    high: '早く降りるほど渡すものが少ない。',
    low: '',
    note: '相手が受けないこともある。',
  },
  'battle.pursuit': {
    label: '追い討ち', unit: 'none', group: 'battle', tag: '戦',
    one: '降参を断られた状態。',
    high: '被害が跳ね上がる。',
    low: '',
  },
};

// 捕虜を引く軸（sim の CAPTIVE_AXES の key）
const AXIS = {
  'axis.総合': {
    label: '使える力', unit: 'none', group: 'axis', tag: '',
    one: '体と腕を全部混ぜた数の上位から引く。',
    high: 'どこに置いても働く者が来やすい。',
    low: '',
    note: '忠誠心は入っていない。まだ分かっていない力も入っていない。',
  },
  'axis.武': {
    label: '戦いの力', unit: 'none', group: 'axis', tag: '戦',
    one: '「戦いの才」と「戦いの腕」の上位から引く。',
    high: '次の戦で使える者が来やすい。', low: '',
  },
  'axis.知': {
    label: '知性', unit: 'none', group: 'axis', tag: '心',
    one: '「知性」と「好奇心」の上位から引く。',
    high: '国の強さに少し効く者が来やすい。', low: '',
  },
  'axis.統率': {
    label: '人をまとめる力', unit: 'none', group: 'axis', tag: '戦',
    one: '「人をまとめる才」の上位から引く。',
    high: '味方を底上げする者が来やすい。', low: '',
  },
  'axis.繁殖': {
    label: '子だくさん', unit: 'none', group: 'axis', tag: '増',
    one: '子ができやすい者の上位から引く。',
    high: '人口が早く増える。よその血も早く広がる。', low: '',
  },
  'axis.器用': {
    label: '手先の器用さ', unit: 'none', group: 'axis', tag: '畑',
    one: '「手先の器用さ」と「覚えの早さ」の上位から引く。',
    high: '畑と当てやすさに効く者が来やすい。', low: '',
  },
  'axis.頑健': {
    label: '丈夫さ', unit: 'none', group: 'axis', tag: '戦',
    one: '「丈夫さ」と「寿命」の上位から引く。',
    high: '死ににくく長く使える者が来やすい。', low: '',
  },
};

// 国境の3択
const BORDER = {
  'border.accept': {
    label: '国に入れる', unit: 'none', group: 'border', tag: '血',
    one: '人が1体増え、よその血が入る。',
    high: '血の傷みが治り、色が溶けはじめる。',
    low: '',
    note: 'その者が持ってきた国への恨みも、一緒に入る。'
      + '入れたあとに殺すと、それは粛清になって跳ね返る。',
  },
  'border.kill': {
    label: 'ここで殺す', unit: 'none', group: 'border', tag: '',
    one: 'いま代償はない。',
    high: '',
    low: 'この血は二度と手に入らない。',
    note: '3人を超えると、戦に出た者たちに漏れる。',
  },
  'border.return': {
    label: '送り返す', unit: 'none', group: 'border', tag: '',
    one: 'こちらの得はない。',
    high: '',
    low: '相手の国にはその血が残る。',
  },
};

// ============================================================ 願い（11）
// sim の text（`〜の具申：…不審の廉あり`）は開発用。画面は kind から組み立てる。
const PET = {
  'pet.讒言': {
    label: '悪口', unit: 'none', group: 'pet', tag: '心',
    one: '他の組の長を「あやしい」と言っている。',
    high: '通すと、言われた側のほうびが消えて汚名が付く。言った側を強く恨む。',
    low: '断ると、言った長が腐る。誇りが高いほど恨みを溜める。',
    body: '{組}の長 {A} が、{相手の組}の長 {B} を「あやしい」と言っている。',
    yes: '{B} の面目をつぶす', no: '取り合わない',
    yesEffect: '{B} のほうびが消え、汚名が付く。{B} が {A} を強く恨み、国への恨みも増える。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。{B} も {A} を恨む。',
  },
  'pet.予算要求': {
    label: 'もっとほしい', unit: 'none', group: 'pet', tag: '',
    one: '自分の組に、もっと人と物を回してほしいと言っている。',
    high: '通すと、その組に1割寄る。',
    low: '断ると、言った長が腐る。',
    body: '{組}の長 {A} が、{組}にもっと人と物を回してほしいと言っている。',
    yes: '{組}に寄せる', no: '今のまま',
    yesEffect: '{組}に1割寄る。減らされた組の長が {A} を恨む。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。',
  },
  'pet.引抜': {
    label: '人をよこせ', unit: 'none', group: 'pet', tag: '',
    one: '他の組が抱えている者を、自分の組に移したいと言っている。',
    high: '通すと、その者が移ってその役から動かせなくなる。',
    low: '断ると、言った長が腐る。',
    body: '{組}の長 {A} が、{B} を {組} に移したいと言っている。いまは {相手の組} が抱えている。',
    yes: '{B} を {組} へ', no: '動かさない',
    yesEffect: '{B} が {組} に移り、その役から動かせなくなる。前の組の長が恨む。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。',
  },
  'pet.粛清具申': {
    label: '殺したい', unit: 'none', group: 'pet', tag: '',
    one: '危ないから、と言って一人を殺したがっている。',
    high: '通すと、その者を殺す。証拠は要らない。',
    low: '断ると、言った長が腐る。狙われた者は助かる。',
    body: '{組}の長 {A} が、{B} を殺したいと言っている。危ないから、が理由。',
    yes: '{B} を殺す', no: 'ほうっておく',
    yesEffect: '{B} を殺す。証拠は要らない。疑われただけで死ぬ。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。{B} は {A} を恨む。',
  },
  'pet.開戦具申': {
    label: '戦をしたい', unit: 'none', group: 'pet', tag: '戦',
    one: '兵の腕がなまっている、と言って戦をしたがっている。',
    high: '通すと、戦の支度が始まる。',
    low: '断ると、言った長が腐る。',
    body: '{組}の長 {A} が、戦をしたいと言っている。兵の腕がなまっている、が理由。',
    yes: '支度を許す', no: 'やめさせる',
    yesEffect: '戦の支度が始まる。怒りの薄い者が国を少し恨む。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。',
  },
  'pet.温存': {
    label: '出したくない', unit: 'none', group: 'pet', tag: '戦',
    one: '強い者を戦に出したくないと言っている。',
    high: '通すと、出す数が減る。',
    low: '断ると、言った長が腐る。',
    body: '{組}の長 {A} が、強い者を戦に出したくないと言っている。',
    yes: '出す数を減らす', no: '予定どおり出す',
    yesEffect: '「強い順に出す」の割合が15減る。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。',
  },
  'pet.世襲固定': {
    label: '家で決めたい', unit: 'none', group: 'pet', tag: '心',
    one: '役目は親から子へ継がせたいと言っている。',
    high: '通すと、見えやすさが15下がる。',
    low: '断ると、言った長が腐る。',
    body: '{組}の長 {A} が、役目は親から子へ継がせたいと言っている。',
    yes: 'そうさせる', no: '認めない',
    yesEffect: '見えやすさが15下がる。手柄のない有能な者が国を恨みはじめる。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。',
  },
  'pet.抜擢': {
    label: '引き上げたい', unit: 'none', group: 'pet', tag: '心',
    one: '家は良くないが見込みがある者を、引き上げたいと言っている。',
    high: '通すと、見えやすさが10上がる。',
    low: '断ると、言った長が腐る。',
    body: '{組}の長 {A} が、{B} を引き上げたいと言っている。家は良くないが見込みがある、が理由。',
    yes: '{B} を引き上げる', no: '今のまま',
    yesEffect: '{B} にほうびが付き、見えやすさが10上がる。上下を気にする者が {B} を恨む。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。',
  },
  'pet.慰撫': {
    label: 'なぐさめたい', unit: 'none', group: 'pet', tag: '心',
    one: '死んだ者の家族に、食べものを回したいと言っている。',
    high: '通すと、その家族の国への恨みが30減る。',
    low: '断ると、言った長が腐る。',
    body: '{組}の長 {A} が、死んだ者の家族に食べものを回したいと言っている。',
    yes: '回す', no: '回さない',
    yesEffect: '{B} の国への恨みが30減る。食べものが減る。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。',
  },
  'pet.叙勲要求': {
    label: 'ほうびがほしい', unit: 'none', group: 'pet', tag: '心',
    one: '自分にほうびがほしいと言っている。',
    high: '通すと、その長にほうびが付く。',
    low: '断ると、言った長が腐る。',
    body: '{組}の長 {A} が、自分にほうびがほしいと言っている。',
    yes: '{A} にほうびを与える', no: '与えない',
    yesEffect: '{A} にほうびが付く。嫉妬深い者が {A} を恨む。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。',
  },
  'pet.増産': {
    label: '畑を広げたい', unit: 'none', group: 'pet', tag: '畑',
    one: '人手を回して畑を広げたいと言っている。',
    high: '通すと、狩り・訓練の者が畑に移る。',
    low: '断ると、言った長が腐る。',
    body: '{組}の長 {A} が、畑を広げたいと言っている。人手をこちらに回してほしい、が理由。',
    yes: '人手を畑へ', no: '回さない',
    yesEffect: '狩り・訓練の者が畑に移る。怒りっぽい者が国を恨む。',
    noEffect: '{A} が腐る。誇りが高いほど恨みを溜める。',
  },
};

// ============================================================ できごと（20）と年代記
const EVT = {
  'evt.創世': { label: 'はじまり', one: 'この国が始まった。' },
  'evt.誕生': { label: '生まれた', one: '子が生まれた。' },
  'evt.死亡': { label: '死んだ', one: '一体が死んだ。' },
  'evt.発現': { label: '力がはっきりした', one: '伏せられていた力が1つ分かった。' },
  'evt.潜伏形質の発現': { label: '隠れていた力が出た', one: '親には見えていなかった力が、子に出た。' },
  'evt.配役': { label: '置いた', one: '仕事を決めた。' },
  'evt.移住': { label: '住まいを変えた', one: '住む場所を変えた。' },
  'evt.任命': { label: '長にした', one: '組の長を決めた。' },
  'evt.裁定': { label: '決めた', one: '願いを通したか、断ったか。' },
  'evt.粛清': { label: '殺した', one: '自分の国の者を殺した。' },
  'evt.一揆': { label: '暴動が起きた', one: '国への恨みが溜まって、人が立ち上がった。' },
  'evt.隠匿': { label: '収穫を隠された', one: '作った量の一部が、蔵に入らなかった。' },
  'evt.開戦': { label: '戦が始まった', one: 'よその国と戦になった。' },
  'evt.戦終': { label: '戦が終わった', one: '勝ったか負けたか、死者は何人か。' },
  'evt.捕虜': { label: '連れ帰った', one: '相手の国から1体を連れ帰った。' },
  'evt.帰化': { label: '国に入れた', one: '連れ帰った者を国民にした。' },
  'evt.誅殺': { label: '国境で殺した', one: '国に入れる前に殺した。' },
  'evt.送還': { label: '送り返した', one: '連れ帰った者を相手の国へ返した。' },
  'evt.初戦の予兆': { label: '村がいっぱいになった', one: 'これ以上は増えない。先へ進む道は戦いだけ。' },
  'evt.フェーズ移行': { label: '部族になった', one: 'よその血が1体入り、村は部族になった。' },
};

const CHRON = {
  'chron.trueCause': {
    label: '本当のきっかけ', unit: 'none', group: 'chron', tag: '',
    one: '仕組みだけが知っている、もとになったできごと。',
    high: '裏が取れていれば、ここまで遡れる。',
    low: '取れていなければ、長の言い分で止まる。',
  },
  'chron.claimed': {
    label: '長が言っていること', unit: 'none', group: 'chron', tag: '',
    one: '誰のせいだと長が報告したか。',
    high: '', low: '',
    note: '本当とは限らない。数字は正確でも、なぜそうなったかは数字の中に無い。',
  },
  'chron.canon': {
    label: '公式の記録', unit: 'none', group: 'chron', tag: '',
    one: 'あなたがどちらを正しいことにしたか。',
    high: '', low: '',
    note: '部族の段階ではまだ使えない。',
  },
  'chron.revealed': {
    label: '裏が取れている', unit: 'none', group: 'chron', tag: '',
    one: 'このできごとの中身を、こちら側が確かに知っているか。',
    high: '本当のきっかけまで遡れる。',
    low: '長の言い分しか読めない。',
  },
  'chron.effects': {
    label: '何がどれだけ動いたか', unit: 'none', group: 'chron', tag: '',
    one: '恨み・気分・作る量・血すじ・誰のせいか、の5つだけ出所を持つ。',
    high: '', low: '',
  },
};

// ============================================================ まとめる
export const TERMS = Object.assign(
  Object.create(null),
  BODY, MIND, SKILL, IND, NATION,
  ROLE_T, DIST_T, BUREAU_T, CARD, BATTLE, AXIS, BORDER, PET, EVT, CHRON,
);

// できごとは label と one しか要らないので、残りの列をここで埋める。
// 手で20回書くと必ず抜けるので、書かせない。
for (const k of Object.keys(EVT)) {
  const t = TERMS[k];
  t.unit ??= 'none'; t.group ??= 'evt'; t.tag ??= '';
  t.high ??= ''; t.low ??= '';
}

// ---------------------------------------------------------------------------
// キーの一覧。自己点検（?dev=1）と test/glossary.js が同じものを見る。
// ---------------------------------------------------------------------------
export const GENE_KEYS = [...Object.keys(BODY), ...Object.keys(MIND)];
export const SKILL_KEYS = Object.keys(SKILL);
export const IND_KEYS = Object.keys(IND);
export const NATION_KEYS = Object.keys(NATION);
export const ROLE_KEYS = Object.keys(ROLE_T);
export const DIST_KEYS = Object.keys(DIST_T);
export const BUREAU_KEYS = Object.keys(BUREAU_T);
export const CARD_KEYS = Object.keys(CARD);
export const BATTLE_KEYS = Object.keys(BATTLE);
export const AXIS_KEYS = Object.keys(AXIS);
export const BORDER_KEYS = Object.keys(BORDER);
export const PET_KEYS = Object.keys(PET);
export const EVENT_KEYS = Object.keys(EVT);
export const CHRON_KEYS = Object.keys(CHRON);

/** 画面に出る語ぜんぶ。1つでも辞書から落ちたら検査が赤くなる。 */
export const SCREEN_KEYS = [
  ...GENE_KEYS, ...SKILL_KEYS, ...IND_KEYS, ...NATION_KEYS,
  ...ROLE_KEYS, ...DIST_KEYS, ...BUREAU_KEYS, ...CARD_KEYS,
  ...BATTLE_KEYS, ...AXIS_KEYS, ...BORDER_KEYS,
  ...PET_KEYS, ...EVENT_KEYS, ...CHRON_KEYS,
];

// 個体パネルの並び順。染色体順をやめ、**効き目の強い順**にする（R-979）。
export const GROUP_ORDER = ['strong', 'normal', 'skill', 'chief', 'dead'];

export const GROUP_TITLE = {
  strong: 'よく効く',
  normal: '効く',
  skill: '腕',
  chief: '長にしたときだけ効く',
  dead: 'いまの版では効かない',
};

export const GROUP_SUB = {
  strong: 'どこに置くかは、ここを見て決める',
  normal: '',
  skill: '使った仕事だけ伸びる。子には受け継がれない',
  chief: '村のあいだは何も起きない',
  dead: '数字は動くが、何にもつながっていない',
};

// 単位の見出し（ツールチップの右上）。R-975 の3種類に対応する。
const UNIT_HINT = {
  scale: '0〜100',
  pct: '％',
  count: 'かず',
  age: '歳',
  gen: '世代',
  index: '上限なし',
  none: '',
};

// ---------------------------------------------------------------------------
// 引くための関数
// ---------------------------------------------------------------------------

/** 辞書の項目。無ければ null（落とさない） */
export function term(key) {
  return (key != null && TERMS[key]) || null;
}

/** 表示名。辞書に無ければキーをそのまま返す（画面を落とさない） */
export function label(key) {
  const t = term(key);
  return t ? t.label : String(key ?? '');
}

/** 単位の見出し */
export function unitHint(key) {
  const t = term(key);
  return t ? (UNIT_HINT[t.unit] ?? '') : '';
}

/** その項目のまとまり */
export function groupOf(key) {
  const t = term(key);
  return t ? (t.group || 'normal') : 'normal';
}

/** いまの版で何にも効かないか */
export function isDead(key) {
  const t = term(key);
  return !!(t && t.dead);
}

/** 辞書に無いキーだけを返す。自己点検の本体。 */
export function missing(keys) {
  const out = [];
  for (const k of keys || []) {
    if (k == null) continue;
    if (!TERMS[k]) out.push(String(k));
  }
  return [...new Set(out)];
}

/** 「高いと何が起きるか」が空の項目。V-06 が数えるのはここ。 */
export function missingHigh(keys) {
  const out = [];
  for (const k of keys || []) {
    const t = TERMS[k];
    if (t && !(t.high && t.high.trim())) out.push(String(k));
  }
  return out;
}

/** カード名の {n} に実際の値を差し込む（R-974。`上位N%を派遣` を画面に出さない） */
export function cardLabel(cardId, value) {
  const t = term('card.' + cardId);
  if (!t) return String(cardId);
  return t.label.replace('{n}', value == null ? '—' : String(Math.round(value)));
}

/** 願い・できごとの型に、名前を差し込む */
export function fill(tpl, vars = {}) {
  if (!tpl) return '';
  let s = String(tpl);
  for (const k in vars) s = s.split('{' + k + '}').join(vars[k] ?? '');
  return s;
}

// ---------------------------------------------------------------------------
// 数値の3種類（R-975 / REQUIREMENTS 5-2）
//   めもり … 内部 0..1 のものを 0〜100 の整数で。単位記号は付けない
//   わりあい … 本当に割合であるものだけ % を付ける
//   かず   … 整数。小数は1桁も出さない
// 同じ量を片方で 0.65、片方で 65% と出すのを禁じるために、ここを通す。
// ---------------------------------------------------------------------------
export const scale01 = (v) => (Number.isFinite(v) ? String(Math.round(Math.max(0, Math.min(1, v)) * 100)) : '—');
export const ratio01 = (v) => (Number.isFinite(v) ? Math.round(v * 100) + '%' : '—');
export const count = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '—');
