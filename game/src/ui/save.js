// 診断結果（種族）の保存と復元。**世界の途中経過は保存しない。**
//
// 保存するのは「60問の答えから出た種族」だけ。次回起動時にこれがあれば、
// 60問をやり直さずに同じ種族で世界を始められる。
//
// localStorage が使えない環境（プライベートモード等）でも画面が落ちないように、
// 読み書きは全部 try で包んで、失敗したら「保存が無い」ものとして振る舞う。

const KEY = 'zoushoku.species.v1';

/**
 * @param rec {centroid, code, name, spread, responses}
 *   centroid  … 22座位の重心（要求値。normalizeArms を通したあとの値）
 *   code      … 6文字の種族コード
 *   name      … 種族名
 *   spread    … sim が二匹を引くときのばらけ幅（表示用）
 *   responses … 60問の生の回答（「答えを直す」で戻れるように）
 */
export function saveSpecies(rec) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...rec, savedAt: Date.now() }));
    return true;
  } catch (e) {
    console.warn('[save] 種族の保存に失敗した', e);
    return false;
  }
}

/** 保存された種族。無ければ null。壊れていたら捨てて null。 */
export function loadSpecies() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    // centroid が無い／壊れている記録は使えない
    if (!rec || !rec.centroid || typeof rec.centroid !== 'object') return null;
    if (!Object.keys(rec.centroid).length) return null;
    return rec;
  } catch (e) {
    console.warn('[save] 保存された種族が読めなかったので捨てる', e);
    try { localStorage.removeItem(KEY); } catch (_) { /* noop */ }
    return null;
  }
}

export function clearSpecies() {
  try { localStorage.removeItem(KEY); } catch (_) { /* noop */ }
}

/** 「3日前」のような相対表示。時計に依存するのは表示だけで、世界の挙動には入らない。 */
export function savedAgo(rec) {
  if (!rec || !rec.savedAt) return '';
  const d = Date.now() - rec.savedAt;
  const min = Math.floor(d / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  return `${Math.floor(hr / 24)}日前`;
}
