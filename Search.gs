const SPEED_M_PER_MIN = { 徒歩: 65, 自転車: 200, 車: 400, 電車: 600 }; // 1分あたりの距離(m)
const DETOUR = 1.3; // 直線距離より道のりが長い分の見込み
const MAX_RESULTS = 15; // 1ページの表示件数。これを超えたときだけ、ページ送りが出る(予備の機能)
// 定休日が判断できない店(不定休など)は、通常営業の店と 7:3 の割合で、3を超えない範囲で混ぜる
const RATIO_NORMAL = 7,
  RATIO_UNCERTAIN = 3;

// ---- 時間帯の判定(すべて日本時間) ----
// 朝 = MORNING_START時〜LUNCH_START時前 / 昼 = LUNCH_START時〜DINNER_START時前 / 夜 = DINNER_START時〜翌DAY_BREAK時前 / それ以外は表示なし
// 0〜DAY_BREAK時前は「前日の営業日の夜」として、曜日・祝日を前日で判定する
// 朝は、シート「営業時間」(Hours.gs で取り込む)に営業時間がある店は、いま開いているかで決める。
// 営業時間が未取得の店は、シート「朝ジャンル設定」のキーワードに合うジャンルだけを出す。朝の予算は食べログにないので、昼の予算を目安にする
const DAY_BREAK = 5,
  MORNING_START = 6,
  LUNCH_START = 11,
  DINNER_START = 17;
const WEEKDAYS_ = [
  "月曜日",
  "火曜日",
  "水曜日",
  "木曜日",
  "金曜日",
  "土曜日",
  "日曜日",
];
// 祝日カレンダーは、IDが違ったり、名前が「日本の休日」「日本の祝日」だったりするので、順に探す
const HOLIDAY_CAL_IDS_ = [
  "ja.japanese#holiday@group.v.calendar.google.com",
  "japanese__ja@holiday.calendar.google.com",
  "en.japanese#holiday@group.v.calendar.google.com",
];
const HOLIDAY_CAL_NAMES_ = ["日本の休日", "日本の祝日", "Holidays in Japan"];
const HIDDEN_SHEET = "非表示リスト";

// ---- 安全対策の共通部品 ----
// 画面に見せてよいエラーは fail_ で作る。それ以外の予期しないエラーは、中身を画面に出さず、ログにだけ残す
function fail_(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}
function run_(fn) {
  try {
    return fn();
  } catch (e) {
    if (e && e.userFacing) throw e;
    console.error(e && e.stack ? e.stack : e);
    throw new Error("処理に失敗しました(管理者のログを確認してください)");
  }
}

// 短時間の連続アクセスを止める(鍵の総当たり・API料金の使い込み対策)
function rateLimit_(name, max, windowSec) {
  const cache = CacheService.getScriptCache();
  const key = "rl_" + name + "_" + Math.floor(Date.now() / (windowSec * 1000));
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const n = Number(cache.get(key) || 0) + 1;
    cache.put(key, String(n), windowSec + 5);
    if (n > max)
      throw fail_("アクセスが多すぎます。しばらく待ってからやり直してください");
  } finally {
    lock.releaseLock();
  }
}

// 1日あたりのGoogle API呼び出しの上限(スクリプトプロパティ PLACES_DAILY_MAX。既定400回)
function dailyBudget_(add) {
  const props = PropertiesService.getScriptProperties();
  const max = Number(props.getProperty("PLACES_DAILY_MAX")) || 400;
  const today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd");
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const cur = String(props.getProperty("PLACES_DAY") || "").split(":");
    const n = (cur[0] === today ? Number(cur[1]) || 0 : 0) + add;
    if (n > max)
      throw fail_("本日のGoogleマップ取得の上限(" + max + "回)に達しました");
    props.setProperty("PLACES_DAY", today + ":" + n);
  } finally {
    lock.releaseLock();
  }
}

function searchKey_() {
  const key = PropertiesService.getScriptProperties().getProperty("SEARCH_KEY");
  if (!key || key.length < 16)
    throw fail_(
      "SEARCH_KEY が未設定、または短すぎます(16文字以上のランダムな文字列にしてください)",
    );
  return key;
}
// 文字数や一致位置で時間差が出ない比較
function sameKey_(a, b) {
  a = String(a == null ? "" : a);
  b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < b.length; i++)
    d |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return d === 0;
}
// ---- 画面に渡す、期限つきの一時キー ----
// SEARCH_KEY 本体は、画面(ブラウザ)に載せない。画面を開くたびに、一時キーを発行して渡す。
// 一時キーは、スクリプトプロパティ SESSION_KEYS に { 一時キー: 期限(ms) } で持つ
const SESSION_PROP = "SESSION_KEYS";
const SESSION_TTL_SEC = 1800; // 一時キーの有効期間(30分)。画面を開いてから、この間だけ検索・削除・写真が使える
const SESSION_MAX = 20; // 同時に持つ一時キーの上限(超えたら古い順に削除)

function sessionLoad_() {
  try {
    return (
      JSON.parse(
        PropertiesService.getScriptProperties().getProperty(SESSION_PROP) ||
          "{}",
      ) || {}
    );
  } catch (e) {
    return {};
  }
}
function sessionIssue_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(3000);
  try {
    const now = Date.now(),
      all = sessionLoad_();
    Object.keys(all).forEach((k) => {
      if (!(all[k] > now)) delete all[k];
    }); // 期限切れを削除
    const keys = Object.keys(all).sort((a, b) => all[a] - all[b]);
    while (keys.length >= SESSION_MAX) delete all[keys.shift()];
    const key = Utilities.getUuid().replace(/-/g, "");
    all[key] = now + SESSION_TTL_SEC * 1000;
    PropertiesService.getScriptProperties().setProperty(
      SESSION_PROP,
      JSON.stringify(all),
    );
    return key;
  } finally {
    lock.releaseLock();
  }
}
function sessionValid_(k) {
  return /^[0-9a-f]{32}$/.test(k) && sessionLoad_()[k] > Date.now();
}

function checkKey_(k) {
  k = String(k == null ? "" : k);
  if (sessionValid_(k)) return; // 画面に渡した、期限つきの一時キー
  if (sameKey_(k, searchKey_())) return; // SEARCH_KEY 本体(ブックマークのURL・Slack内の処理)
  rateLimit_("badkey", 10, 600); // 間違った鍵は10分に10回まで
  throw fail_(
    /^[0-9a-f]{32}$/.test(k)
      ? "画面の有効期限が切れました。Slackで /tabelog をもう一度打つか、ページを開き直してください"
      : "forbidden",
  );
}
// <script> の中に安全に埋め込める文字列にする
function jsStr_(s) {
  return JSON.stringify(String(s))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.p === "ping")
    return ContentService.createTextOutput("OK tabelog saver (hours対応)");
  if (p.p === "hours") return hoursTargets_(p); // 営業時間の取得対象(Hours.gs)。SAVE_TOKEN で守る
  if (p.go && typeof goPage_ === "function") return goPage_(p.go); // ← この1行を足す
  try {
    checkKey_(p.k);
  } catch (err) {
    return HtmlService.createHtmlOutput(
      err && err.userFacing ? err.message : "error",
    );
  }
  if (p.loc && typeof saveLocation_ === "function") return saveLocation_(p); // iPhoneのショートカットから届く現在地(slack.gs)。鍵の確認のあとに処理する
  const k = jsStr_(sessionIssue_()); // 画面には SEARCH_KEY ではなく、期限つきの一時キーを渡す
  return HtmlService.createHtmlOutput(SEARCH_HTML_.replace("__KEY__", () => k))
    .setTitle("ごはん検索")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function distM_(a, b, c, d) {
  const R = 6371000,
    t = (x) => (x * Math.PI) / 180;
  const dLa = t(c - a),
    dLo = t(d - b);
  const s =
    Math.sin(dLa / 2) ** 2 +
    Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function yen_(n) {
  return "¥" + Number(n).toLocaleString("en-US");
}
function range_(x) {
  const lo = Number(x.lo),
    hi = Number(x.hi);
  if (hi >= 999999) return yen_(lo) + "〜";
  if (lo === 0) return "〜" + yen_(hi);
  return yen_(lo) + "〜" + yen_(hi).slice(1);
}

// ---- 日本時間・祝日 ----
function jstNow_() {
  const now = new Date();
  const fmt = (d, f) => Utilities.formatDate(d, "Asia/Tokyo", f);
  const hour = Number(fmt(now, "H")),
    min = fmt(now, "mm");
  const biz =
    hour < DAY_BREAK ? new Date(now.getTime() - 24 * 3600 * 1000) : now; // 営業日
  const wd = WEEKDAYS_[Number(fmt(biz, "u")) - 1]; // u: 1=月 … 7=日
  const period =
    hour >= DINNER_START || hour < DAY_BREAK
      ? "夜"
      : hour >= LUNCH_START
        ? "昼"
        : hour >= MORNING_START
          ? "朝"
          : "";
  const ymd = fmt(biz, "yyyy-MM-dd");
  const next = fmt(
    new Date(new Date(ymd + "T00:00:00+09:00").getTime() + 24 * 3600 * 1000),
    "yyyy-MM-dd",
  );
  const ctx = {
    period: period,
    wd: wd,
    wdi: Number(fmt(biz, "u")) - 1,
    mins: hour * 60 + Number(min),
    holUsed: false,
    holUnknown: false,
    text:
      "JST " +
      hour +
      ":" +
      min +
      "(" +
      wd.charAt(0) +
      (hour < DAY_BREAK ? "の営業日扱い" : "") +
      ")",
    _h: undefined,
    _n: undefined,
  };
  // 祝日・祝前日は必要になったときだけ調べる(true / false / null=判定できない)
  ctx.isHol = function () {
    if (ctx._h === undefined) ctx._h = isHoliday_(ymd);
    return ctx._h;
  };
  ctx.isNextHol = function () {
    if (ctx._n === undefined) ctx._n = isHoliday_(next);
    return ctx._n;
  };
  return ctx;
}

function isHoliday_(ymd) {
  const cache = CacheService.getScriptCache(),
    key = "hol" + ymd;
  const c = cache.get(key);
  if (c) return c === "1";
  try {
    const cal = holidayCal_();
    if (!cal) return null; // 祝日カレンダーが見つからない
    const s = new Date(ymd + "T00:00:00+09:00");
    const r =
      cal.getEvents(s, new Date(s.getTime() + 24 * 3600 * 1000)).length > 0;
    cache.put(key, r ? "1" : "0", 21600);
    return r;
  } catch (err) {
    return null;
  }
}

function holidayCal_() {
  for (let i = 0; i < HOLIDAY_CAL_IDS_.length; i++) {
    const c = CalendarApp.getCalendarById(HOLIDAY_CAL_IDS_[i]);
    if (c) return c;
  }
  for (let i = 0; i < HOLIDAY_CAL_NAMES_.length; i++) {
    const a = CalendarApp.getCalendarsByName(HOLIDAY_CAL_NAMES_[i]);
    if (a.length) return a[0];
  }
  // 最後の手段: 購読中のカレンダーから、IDに holiday を含み、日本のものを探す
  const all = CalendarApp.getAllCalendars();
  for (let i = 0; i < all.length; i++) {
    const id = all[i].getId(),
      nm = all[i].getName();
    if (/holiday/i.test(id) && /japan|日本/i.test(id + " " + nm)) return all[i];
  }
  return null;
}

// 初回に1度だけ、エディタから実行して「カレンダーの閲覧」を許可し、どのカレンダーを使うか確認する
function authorizeCalendar() {
  const cal = holidayCal_();
  if (!cal) {
    Logger.log("祝日カレンダーが見つかりません。購読中のカレンダー一覧:");
    CalendarApp.getAllCalendars().forEach((c) =>
      Logger.log(" - " + c.getName() + " / " + c.getId()),
    );
    return;
  }
  Logger.log("使うカレンダー: " + cal.getName() + " / " + cal.getId());
  ["2026-11-23", "2026-11-24", "2026-12-31"].forEach((ymd) => {
    const s = new Date(ymd + "T00:00:00+09:00");
    const ev = cal.getEvents(s, new Date(s.getTime() + 24 * 3600 * 1000));
    Logger.log(
      ymd +
        ": " +
        (ev.length
          ? ev
              .map((e) => e.getTitle() + "(" + e.getDescription() + ")")
              .join(" / ")
          : "予定なし"),
    );
  });
  Logger.log(
    "11/23(勤労感謝の日)に予定あり、11/24は予定なしなら、祝日の判定はできています",
  );
}

// 定休日の文字(例: 日曜日、祝日)で、いま休みか。true=休み / false=営業 / null=判断できない
function closedNow_(text, ctx) {
  const t = String(text || "").trim();
  if (!t || t === "-") return false; // 記載なし
  let unknown = false;
  const parts = t.split(/[、,，・\s]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i];
    if (w === ctx.wd) return true;
    if (w === "祝日") {
      ctx.holUsed = true;
      const h = ctx.isHol();
      if (h === null) {
        unknown = true;
        ctx.holUnknown = true;
      } else if (h) return true;
    } else if (w === "祝前日") {
      ctx.holUsed = true;
      const h = ctx.isNextHol();
      if (h === null) {
        unknown = true;
        ctx.holUnknown = true;
      } else if (h) return true;
    } else if (WEEKDAYS_.indexOf(w) < 0) {
      unknown = true; // 「第2火曜日」「不定休」など
    }
  }
  return unknown ? null : false;
}

// 画面の表示用(時刻だけ。カレンダーは読まない)
function jstInfo(q) {
  return run_(() => {
    checkKey_(q && q.k);
    const c = jstNow_();
    const rule =
      "朝=" +
      MORNING_START +
      "〜" +
      LUNCH_START +
      "時 / 昼=" +
      LUNCH_START +
      "〜" +
      DINNER_START +
      "時 / 夜=" +
      DINNER_START +
      "時〜翌" +
      DAY_BREAK +
      "時";
    return {
      text: c.period
        ? "いま " +
          c.text +
          " → " +
          c.period +
          "の営業の店だけ表示します(" +
          rule +
          ")"
        : "いま " +
          c.text +
          " → 朝・昼・夜のどの時間帯でもないため、店は表示しません(" +
          rule +
          ")",
    };
  });
}

// ---- 朝に開いていそうなジャンル(シート「朝ジャンル設定」。初回に自動作成。行を足す・消すで調整できる) ----
const MORNING_SHEET = "朝ジャンル設定";
const MORNING_DEFAULT_ = [
  ["カフェ", "モーニングのある店が多い"],
  ["喫茶", "喫茶店・純喫茶"],
  ["コーヒー", "コーヒー専門店"],
  ["パン", "パン屋・ベーカリー"],
  ["ベーカリー", ""],
  ["サンドイッチ", ""],
  ["モーニング", ""],
  ["朝食", ""],
  ["軽食", ""],
  ["食堂", ""],
  ["定食", ""],
  ["うどん", "讃岐うどんなど、早朝から開く店がある"],
  ["立ち食い", ""],
];
function morningWords_(ss) {
  let sh = ss.getSheetByName(MORNING_SHEET);
  if (!sh) {
    sh = ss.insertSheet(MORNING_SHEET);
    sh.getRange(1, 1, 1, 2).setValues([["ジャンルに含む文字", "備考"]]);
    sh.getRange(2, 1, MORNING_DEFAULT_.length, 2).setValues(MORNING_DEFAULT_);
    sh.setFrozenRows(1);
  }
  if (sh.getLastRow() < 2) return [];
  return sh
    .getRange(2, 1, sh.getLastRow() - 1, 1)
    .getValues()
    .map((r) => String(r[0]).trim())
    .filter(Boolean);
}

// ---- 非表示(削除)リスト:シート「非表示リスト」に残す。シート上でも編集できる ----
function ss_() {
  return SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty(SS_KEY),
  );
}
function hiddenSheet_(ss) {
  let sh = ss.getSheetByName(HIDDEN_SHEET);
  if (!sh) {
    sh = ss.insertSheet(HIDDEN_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([["URL", "店名", "削除日時"]]);
    sh.setFrozenRows(1);
  }
  return sh;
}
function hiddenSet_(ss) {
  const sh = ss.getSheetByName(HIDDEN_SHEET),
    set = {};
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1)
      .getValues()
      .forEach((r) => {
        if (r[0]) set[String(r[0])] = true;
      });
  }
  return set;
}
function safeCell_(s) {
  s = String(s == null ? "" : s).slice(0, 200);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function checkShopUrl_(url) {
  url = String(url);
  if (url.length > 300 || !/^https:\/\/tabelog\.com\/[^\s]*$/.test(url))
    throw fail_("対象外のURLです");
}

// 確定一覧から店を1件探す。画面から来た店名・住所は信用せず、必ずここで引き直す
function shopByUrl_(url) {
  const v = ss_().getSheetByName(FINAL_SHEET).getDataRange().getValues();
  const h = {};
  v[0].forEach((n, i) => {
    h[String(n).trim()] = i;
  });
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][h["URL"]]) === url) {
      return {
        url: url,
        name: String(v[i][h["店名"]]),
        addr: String(v[i][h["住所"]] || ""),
        lat: Number(v[i][h["緯度"]]),
        lng: Number(v[i][h["経度"]]),
        approx: v[i][h["位置精度"]] === "APPROXIMATE",
      };
    }
  }
  return null;
}

function hideShop(q) {
  return run_(() => {
    checkKey_(q.k);
    checkShopUrl_(q.url);
    rateLimit_("write", 30, 60);
    const shop = shopByUrl_(String(q.url));
    if (!shop) throw fail_("対象外のURLです"); // 一覧にない店は書き込まない
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const ss = ss_(),
        sh = hiddenSheet_(ss);
      if (!hiddenSet_(ss)[shop.url]) {
        sh.appendRow([
          shop.url,
          safeCell_(shop.name),
          Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm"),
        ]);
      }
    } finally {
      lock.releaseLock();
    }
    return true;
  });
}

function unhideShop(q) {
  return run_(() => {
    checkKey_(q.k);
    checkShopUrl_(q.url);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sh = ss_().getSheetByName(HIDDEN_SHEET);
      if (sh && sh.getLastRow() > 1) {
        const v = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
        for (let i = v.length - 1; i >= 0; i--)
          if (String(v[i][0]) === String(q.url)) sh.deleteRow(i + 2);
      }
    } finally {
      lock.releaseLock();
    }
    return true;
  });
}

function listHidden(q) {
  return run_(() => {
    checkKey_(q.k);
    const sh = ss_().getSheetByName(HIDDEN_SHEET);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh
      .getRange(2, 1, sh.getLastRow() - 1, 2)
      .getValues()
      .filter((r) => r[0])
      .map((r) => ({ url: String(r[0]), name: String(r[1]) }))
      .reverse()
      .slice(0, 100);
  });
}

// ---- 地名(入力欄)を、緯度経度にする。地名でないものには、直し方の分かるメッセージを返す ----
const PLACE_HINT_ =
  "駅名・地名・住所で入れてください(例: 博多駅、天神、福岡市中央区春吉)";
function resolvePlace_(raw) {
  // 絵文字・制御文字・余分な空白を取り除く
  const place = String(raw)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(place))
    throw fail_(
      "地名として読み取れません。絵文字や記号ではなく、文字で入れてください。" +
        PLACE_HINT_,
    );
  let r;
  try {
    r = Maps.newGeocoder().setRegion("jp").setLanguage("ja").geocode(place);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    if (/too many times|quota|limit/i.test(String(err && err.message)))
      throw fail_(
        "地図の検索回数が上限に達しました。しばらく待ってから、もう一度試してください。",
      );
    throw fail_(
      "地名を調べられませんでした。入力を変えて、もう一度試してください。",
    );
  }
  if (r.status === "OVER_QUERY_LIMIT")
    throw fail_(
      "地図の検索回数が上限に達しました。しばらく待ってから、もう一度試してください。",
    );
  if (r.status !== "OK" || !r.results || !r.results.length)
    throw fail_(
      "「" + place + "」は地名として見つかりませんでした。" + PLACE_HINT_,
    );
  const top = r.results[0];
  const inJapan =
    (top.address_components || []).some(
      (c) => (c.types || []).indexOf("country") >= 0 && c.short_name === "JP",
    ) ||
    (!(top.address_components || []).length &&
      /日本/.test(String(top.formatted_address)));
  if (!inJapan)
    throw fail_(
      "「" +
        place +
        "」は日本国内の場所として見つかりませんでした。" +
        PLACE_HINT_,
    );
  return {
    lat: top.geometry.location.lat,
    lng: top.geometry.location.lng,
    name: top.formatted_address,
    note: top.partial_match
      ? "「" +
        place +
        "」と完全に一致する場所がなかったため、「" +
        top.formatted_address +
        "」を起点にしました"
      : "",
  };
}

// ---- 画面から呼ばれる検索 ----
function searchShops(q) {
  return run_(() => {
    checkKey_(q.k);
    rateLimit_("search", 30, 60);

    // 画面から来た値は信用せず、型と範囲をここで確かめる
    const speed = Object.prototype.hasOwnProperty.call(SPEED_M_PER_MIN, q.mode)
      ? SPEED_M_PER_MIN[q.mode]
      : 0;
    const minutes = Number(q.minutes);
    if (!speed || !(minutes > 0) || minutes > 180)
      throw fail_("移動手段と時間を指定してください");
    const radiusM = (speed * minutes) / DETOUR; // 直線距離での半径

    const ctx = jstNow_(); // 朝・昼・夜は日本時間で自動判定
    if (!ctx.period) {
      return {
        originName: "",
        radiusM: radiusM,
        total: 0,
        items: [],
        page: 1,
        pages: 1,
        from: 0,
        to: 0,
        jst: ctx.text,
        closed: 0,
        uncertainHidden: 0,
        notice:
          DAY_BREAK +
          "時台は朝・昼・夜のどの時間帯でもないため、店を表示しません",
      };
    }

    let lat = Number(q.lat),
      lng = Number(q.lng),
      originName = "",
      placeNote = "";
    if (q.place) {
      if (String(q.place).length > 100)
        throw fail_("地名が長すぎます(100文字まで)。" + PLACE_HINT_);
      const pl = resolvePlace_(q.place);
      lat = pl.lat;
      lng = pl.lng;
      originName = pl.name;
      placeNote = pl.note;
    } else if (q.label) {
      originName = String(q.label)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, 40); // エリアのボタンから来た、表示用の名前
    }
    if (
      !isFinite(lat) ||
      !isFinite(lng) ||
      (q.lat === undefined && !q.place) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      throw fail_("起点が分かりません");

    const ss = ss_();
    const hidden = hiddenSet_(ss);
    const v = ss.getSheetByName(FINAL_SHEET).getDataRange().getValues();
    const h = {};
    v[0].forEach((n, i) => {
      h[String(n).trim()] = i;
    });
    ["店名", "URL", "状態", "テイスト", "緯度", "経度"].forEach((n) => {
      if (!(n in h)) throw new Error("確定一覧に列がありません: " + n);
    });
    const col = (r, n) => (n in h ? r[h[n]] : "");
    const has = (x) => x.lo !== "" && x.hi !== "";
    const st = tasteStats_(v, h, hidden); // 選択肢にしたテイスト(それ以外は「その他」)

    const mornWords = ctx.period === "朝" ? morningWords_(ss) : [];
    const hoursOf = ctx.period === "朝" ? hoursMap_(ss) : {}; // 営業時間を取り込んだ店
    const tastes = (Array.isArray(q.tastes) ? q.tastes : [])
      .slice(0, 10)
      .map((t) => String(t).slice(0, 20));
    const maxBudget =
      q.maxBudget && isFinite(Number(q.maxBudget)) && Number(q.maxBudget) > 0
        ? Number(q.maxBudget)
        : null;
    const items = [],
      uncertain = []; // 通常営業の店 / 定休日が判断できない店
    let closedCnt = 0;

    for (let i = 1; i < v.length; i++) {
      const r = v[i];
      if (col(r, "状態") !== "通常") continue; // 閉店・保留は載せない(従来どおり)
      if (hidden[String(col(r, "URL"))]) continue; // 削除した店
      if (col(r, "緯度") === "" || col(r, "経度") === "") continue;
      if (tastes.length) {
        const t = String(col(r, "テイスト"));
        if (tastes.indexOf(st.main.indexOf(t) >= 0 ? t : TASTE_OTHER) < 0)
          continue;
      }

      const x =
        ctx.period === "夜"
          ? { lo: col(r, "夜下限"), hi: col(r, "夜上限") }
          : { lo: col(r, "昼下限"), hi: col(r, "昼上限") }; // 朝の予算は食べログにないので、昼の予算を目安にする
      let hrs = null,
        openNow = null;
      if (ctx.period === "朝") {
        hrs = hoursOf[String(col(r, "URL"))];
        if (hrs) {
          // 営業時間が分かる店は、いま開いているかで決める
          openNow = hoursOpenAt_(hrs.rules, ctx.wdi, ctx.mins, ctx.isHol());
          if (openNow === false) continue;
        }
        if (openNow !== true) {
          // 分からない店は、朝に開いていそうなジャンルだけ
          const g = String(col(r, "ジャンル"));
          if (!mornWords.some((w) => g.indexOf(w) >= 0)) continue;
        }
      } else if (!has(x)) continue; // その時間帯は営業していない
      if (maxBudget !== null && has(x) && Number(x.lo) > maxBudget) continue;

      const la = Number(col(r, "緯度")),
        lo = Number(col(r, "経度"));
      const d = distM_(lat, lng, la, lo);
      if (d > radiusM) continue;

      const cl = closedNow_(col(r, "定休日"), ctx); // 今日が定休日・祝日休みの店は出さない
      if (cl === true) {
        closedCnt++;
        continue;
      }
      // 判断できない書き方の店(不定休・第2火曜日など)は、別に集めて、割合を守って混ぜる
      (cl === null ? uncertain : items).push({
        uncertain: cl === null,
        d: d,
        name: col(r, "店名"),
        url: col(r, "URL"),
        taste: col(r, "テイスト"),
        genre: col(r, "ジャンル"),
        area: col(r, "エリア(駅)"),
        rating: col(r, "総合点"),
        holiday: col(r, "定休日"),
        budget:
          ctx.period === "朝"
            ? "朝 " +
              (has(x) ? range_(x) + "(昼の目安)" : "予算不明") +
              (openNow === true
                ? " ・本日 " + hoursTodayText_(hrs.rules, ctx.wdi, ctx.isHol())
                : " ※営業時間は未確認")
            : ctx.period + " " + range_(x),
        approx: col(r, "位置精度") === "APPROXIMATE",
        map:
          "https://www.google.com/maps/search/?api=1&query=" +
          encodeURIComponent(col(r, "店名") + " " + col(r, "住所")),
      });
    }

    items.sort((a, b) => a.d - b.d);
    uncertain.sort((a, b) => a.d - b.d);
    const built = buildPages_(items, uncertain);
    const pages = built.pages;
    const page = Math.min(
      Math.max(1, Math.floor(Number(q.page)) || 1),
      Math.max(1, pages.length),
    );
    const offset = pages.slice(0, page - 1).reduce((n, p) => n + p.length, 0); // 前のページまでの件数
    const fmt = (it) => {
      it.distText =
        it.d >= 1000 ? (it.d / 1000).toFixed(1) + "km" : Math.round(it.d) + "m";
      it.walk =
        q.mode + "約" + Math.max(1, Math.round((it.d * DETOUR) / speed)) + "分";
      delete it.d;
      return it;
    };
    // ブラウザ画面は q.all=true で呼び、全ページ分を1回で受け取る(ページ送りは画面側で即時に切り替える)。Slackは従来どおり1ページ分だけ
    const allPages = q.all ? pages.map((p) => p.map(fmt)) : null;
    const top = allPages
      ? allPages[page - 1] || []
      : (pages[page - 1] || []).map(fmt);

    const notice = [
      placeNote,
      ctx.holUnknown
        ? "祝日カレンダーを読めないため、祝日休みの店は除外しています"
        : "",
    ]
      .filter(Boolean)
      .join(" / ");
    return {
      originName: originName,
      lat: lat,
      lng: lng,
      radiusM: radiusM,
      total: pages.reduce((n, p) => n + p.length, 0),
      items: top,
      pagesAll: allPages,
      page: page,
      pages: Math.max(1, pages.length),
      from: top.length ? offset + 1 : 0,
      to: offset + top.length,
      jst: ctx.text + "→" + ctx.period,
      closed: closedCnt,
      uncertainHidden: built.hidden,
      notice: notice,
    };
  });
}

// 通常営業の店を近い順に並べ、定休日が判断できない店は、各ページで 7:3 を超えない範囲で混ぜる(15件なら最大4件)。
// 通常営業の店が足りないページは、混ぜる数も減らす。入りきらない不定休の店は hidden に数える
function buildPages_(known, uncertain) {
  const pages = [];
  const cap = Math.floor(
    (MAX_RESULTS * RATIO_UNCERTAIN) / (RATIO_NORMAL + RATIO_UNCERTAIN),
  );
  let ki = 0,
    ui = 0;
  while (ki < known.length) {
    const ks = known.slice(ki, ki + MAX_RESULTS - cap);
    ki += ks.length;
    const quota = Math.min(
      cap,
      Math.floor((ks.length * RATIO_UNCERTAIN) / RATIO_NORMAL),
    );
    const us = uncertain.slice(ui, ui + quota);
    ui += us.length;
    pages.push(ks.concat(us).sort((a, b) => a.d - b.d));
  }
  return { pages: pages, hidden: uncertain.length - ui };
}

// ---- テイストの選択肢(確定一覧の中身から作る) ----
const TASTE_ORDER = ["和", "洋", "中華", "アジアン", "多国籍"]; // 並び順
const TASTE_OTHER = "その他";
const TASTE_MIN = 3; // この件数に満たないテイストは、独立した選択肢にせず「その他」にまとめる(0件は出さない)

function tasteStats_(v, h, hidden) {
  const counts = {};
  for (let i = 1; i < v.length; i++) {
    const r = v[i];
    if (r[h["状態"]] !== "通常" || hidden[String(r[h["URL"]])]) continue; // 検索の対象になる店だけ数える
    if (r[h["緯度"]] === "" || r[h["経度"]] === "") continue;
    const t = String(r[h["テイスト"]]);
    counts[t] = (counts[t] || 0) + 1;
  }
  const main = TASTE_ORDER.filter((t) => (counts[t] || 0) >= TASTE_MIN);
  let other = 0;
  Object.keys(counts).forEach((t) => {
    if (main.indexOf(t) < 0) other += counts[t];
  });
  return { counts: counts, main: main, other: other };
}

// ---- 起点の選択肢(保存した店が多いエリア。確定一覧の「エリア(駅)」から作る。中心は、そのエリアの店の位置の平均) ----
const AREA_MIN = 1; // これ未満の店しかないエリアは出さない(旅行先など、店が少ない地域も切替の候補に入れる)
const AREA_MAX = 400; // 出すエリアの数(店の多い順)。画面側で、いまの場所に近いものと遠いものに分けるので、多めに返す
const AREA_RADIUS_M = 2000; // 中心から、これより離れた店は、同じ名前の別の土地とみなして数えない
// 現在地(座標)を受け取ったときは、その周りの店だけで、エリアを作り直す(大阪にいれば大阪周辺。店が少なくても作る)
const AREA_LOCAL_KM = 5; // 現在地から、この距離までの店で作る(旅先で、10km先・40km先のエリアを「近く」に並べないため、狭くしてある)
const AREA_LOCAL_MIN = 1; // 周辺では、1軒だけの駅もエリアにする
const AREA_LOCAL_MAX = 14; // 周辺のエリアの数(現在地に近い順)

// 画面から呼ばれる: 起点にできるエリアと、それぞれの店の件数・中心の位置
function getAreaOptions(q) {
  return run_(() => {
    checkKey_(q && q.k);
    const ss = ss_(),
      v = ss.getSheetByName(FINAL_SHEET).getDataRange().getValues();
    const h = {};
    v[0].forEach((n, i) => {
      h[String(n).trim()] = i;
    });
    const qLat = Number(q && q.lat),
      qLng = Number(q && q.lng);
    const local =
      !!q &&
      q.lat !== undefined &&
      q.lat !== "" &&
      isFinite(qLat) &&
      isFinite(qLng) &&
      Math.abs(qLat) <= 90 &&
      Math.abs(qLng) <= 180;
    ["URL", "状態", "緯度", "経度", "エリア(駅)"].forEach((n) => {
      if (!(n in h)) throw new Error("確定一覧に列がありません: " + n);
    });
    const hidden = hiddenSet_(ss),
      g = {};
    for (let i = 1; i < v.length; i++) {
      const r = v[i];
      if (r[h["状態"]] !== "通常" || hidden[String(r[h["URL"]])]) continue;
      if (r[h["緯度"]] === "" || r[h["経度"]] === "") continue;
      if (
        local &&
        distM_(qLat, qLng, Number(r[h["緯度"]]), Number(r[h["経度"]])) >
          AREA_LOCAL_KM * 1000
      )
        continue; // 現在地の周り以外の店は、数えない
      const name = String(r[h["エリア(駅)"]])
        .split(/[、,，]/)[0]
        .trim(); // 先頭が、いちばん近い駅
      if (!name) continue;
      (g[name] || (g[name] = [])).push([
        Number(r[h["緯度"]]),
        Number(r[h["経度"]]),
      ]);
    }
    // 同じ名前の駅が別の土地にある(赤坂など)ので、中央値から AREA_RADIUS_M 以内の店だけで、数と中心を出す
    const med = (a) => {
      const b = a.slice().sort((x, y) => x - y),
        m = b.length >> 1;
      return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
    };
    const out = [];
    Object.keys(g).forEach((n) => {
      const mla = med(g[n].map((p) => p[0])),
        mlo = med(g[n].map((p) => p[1]));
      const near = g[n].filter(
        (p) => distM_(mla, mlo, p[0], p[1]) <= AREA_RADIUS_M,
      );
      if (near.length < (local ? AREA_LOCAL_MIN : AREA_MIN)) return;
      const la = near.reduce((t, p) => t + p[0], 0) / near.length,
        lo = near.reduce((t, p) => t + p[1], 0) / near.length;
      out.push({
        name: n,
        count: near.length,
        lat: Math.round(la * 1e6) / 1e6,
        lng: Math.round(lo * 1e6) / 1e6,
        d: local ? distM_(qLat, qLng, la, lo) : 0,
      });
    });
    out.sort(
      local
        ? (a, b) => a.d - b.d // 周辺は、現在地に近い順
        : (a, b) => b.count - a.count || (a.name < b.name ? -1 : 1),
    );
    return {
      local: local,
      options: out.slice(0, local ? AREA_LOCAL_MAX : AREA_MAX),
    };
  });
}

// 画面から呼ばれる: テイストの選択肢と、それぞれの店の件数
function getTasteOptions(q) {
  return run_(() => {
    checkKey_(q && q.k);
    const ss = ss_(),
      v = ss.getSheetByName(FINAL_SHEET).getDataRange().getValues();
    const h = {};
    v[0].forEach((n, i) => {
      h[String(n).trim()] = i;
    });
    ["URL", "状態", "テイスト", "緯度", "経度"].forEach((n) => {
      if (!(n in h)) throw new Error("確定一覧に列がありません: " + n);
    });
    const st = tasteStats_(v, h, hiddenSet_(ss));
    const options = st.main.map((t) => ({ name: t, count: st.counts[t] }));
    if (st.other > 0) options.push({ name: TASTE_OTHER, count: st.other });
    return { options: options };
  });
}

// ---- 店の写真(Googleマップ / Places API (New)) ----
// 必要な設定: スクリプトプロパティ MAPS_API_KEY(キーは画面には渡さない。サーバー側だけで使う)
const PHOTO_MAX = 3; // 1店あたりの写真の最大枚数
const PHOTO_WIDTH_PX = 480; // 写真の幅(px)
const PHOTO_CACHE_SEC = 3600; // 取得結果を覚えておく時間(秒)。写真のURLは期限があるので長くしない
const PLACE_SHEET = "PlaceID"; // 店 → 場所ID の対応表(場所IDは保存してよい)。初回に自動作成
const PLACES_HOST_ = "https://places.googleapis.com/v1/";
const PHOTO_HOST_RE_ =
  /^https:\/\/[a-z0-9.-]+\.(googleusercontent\.com|ggpht\.com)\//; // 写真の置き場はGoogleだけ

function mapsKey_() {
  const k = PropertiesService.getScriptProperties().getProperty("MAPS_API_KEY");
  if (!k) throw new Error("MAPS_API_KEY が未設定です");
  return k;
}

// Places API を呼ぶ。失敗しても検索は止めない(写真はなくても使える)ので、null を返す
function placesCall_(path, method, body, mask) {
  dailyBudget_(1);
  const headers = { "X-Goog-Api-Key": mapsKey_() }; // キーはURLに入れず、ヘッダーで送る(ログに残さない)
  if (mask) headers["X-Goog-FieldMask"] = mask;
  const opt = { method: method, headers: headers, muteHttpExceptions: true };
  if (body) {
    opt.contentType = "application/json";
    opt.payload = JSON.stringify(body);
  }
  return placesParse_(UrlFetchApp.fetch(PLACES_HOST_ + path, opt));
}

let PLACES_ERR_ = ""; // 直近のPlaces APIの失敗(状態コードだけ。画面に理由として出す)
function placesParse_(res) {
  const code = res.getResponseCode();
  if (code !== 200) {
    PLACES_ERR_ = "Places API " + code;
    console.error(
      "Places API " + code + ": " + res.getContentText().slice(0, 200),
    );
    return null;
  }
  try {
    return JSON.parse(res.getContentText());
  } catch (e) {
    return null;
  }
}

function md5_(s) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    s,
    Utilities.Charset.UTF_8,
  )
    .map((b) => ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2))
    .join("");
}

function normName_(s) {
  return String(s || "")
    .replace(/[\s　・･\-－ー()（）【】\[\]「」『』]/g, "")
    .toLowerCase();
}

// 別の店の写真を出さないための確認: 店名がおおむね一致し、位置が近いこと
function samePlace_(shop, place, lat, lng, approx) {
  const a = normName_(shop),
    b = normName_(place.displayName && place.displayName.text);
  if (!a || !b) return false;
  if (
    !(a.indexOf(b) >= 0 || b.indexOf(a) >= 0 || a.slice(0, 3) === b.slice(0, 3))
  )
    return false;
  if (!place.location || !isFinite(lat) || !isFinite(lng)) return true;
  return (
    distM_(lat, lng, place.location.latitude, place.location.longitude) <=
    (approx ? 3000 : 800)
  );
}

function findPid_(url) {
  const sh = ss_().getSheetByName(PLACE_SHEET);
  if (!sh || sh.getLastRow() < 2) return "";
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (let i = 0; i < v.length; i++)
    if (String(v[i][0]) === url) return String(v[i][1]);
  return "";
}

function savePid_(url, pid) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const ss = ss_();
    let sh = ss.getSheetByName(PLACE_SHEET);
    if (!sh) {
      sh = ss.insertSheet(PLACE_SHEET);
      sh.getRange(1, 1, 1, 3).setValues([["URL", "場所ID", "保存日時"]]);
      sh.setFrozenRows(1);
    }
    sh.appendRow([
      String(url),
      String(pid),
      Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm"),
    ]);
  } finally {
    lock.releaseLock();
  }
}

// 写真の作者表示のリンクは、Googleマップのものだけ通す
function safeAuthorUrl_(u) {
  u = String(u || "");
  if (u.indexOf("//") === 0) u = "https:" + u;
  return /^https:\/\/(maps\.google\.com|www\.google\.com\/maps)\//.test(u)
    ? u
    : "";
}

// 画面から呼ばれる: 店の写真(最大 PHOTO_MAX 枚)と、作者の表示用情報
function getShopPhotos(q) {
  return run_(() => {
    checkKey_(q.k);
    checkShopUrl_(q.url);
    if (!PropertiesService.getScriptProperties().getProperty("MAPS_API_KEY"))
      return { photos: [], off: true, why: "MAPS_API_KEY が未設定です" }; // キー未設定の間は、写真なしで動かす
    rateLimit_("photo", 60, 60);
    const shop = shopByUrl_(String(q.url)); // 店名・位置は一覧から引く(画面から来た値で、好きな検索をさせない)
    if (!shop) throw fail_("対象外のURLです");
    const url = shop.url,
      name = shop.name,
      addr = shop.addr,
      lat = shop.lat,
      lng = shop.lng,
      approx = shop.approx;
    const cache = CacheService.getScriptCache(),
      ck = "ph" + md5_(url);
    const hit = cache.get(ck);
    if (hit) return JSON.parse(hit); // 覚えている間は、Googleに料金のかかる問い合わせをしない

    // 場所IDが分かっていれば詳細から、なければ検索して場所IDを保存する
    PLACES_ERR_ = "";
    let place = null,
      pid = findPid_(url);
    if (pid)
      place = placesCall_(
        "places/" + encodeURIComponent(pid) + "?languageCode=ja",
        "get",
        null,
        "id,photos",
      );
    if (!place) {
      const body = {
        textQuery: (name + " " + addr).trim(),
        languageCode: "ja",
        regionCode: "JP",
        maxResultCount: 5,
      };
      if (isFinite(lat) && isFinite(lng))
        body.locationBias = {
          circle: { center: { latitude: lat, longitude: lng }, radius: 500 },
        };
      const r = placesCall_(
        "places:searchText",
        "post",
        body,
        "places.id,places.displayName,places.location,places.photos",
      );
      const cand = ((r && r.places) || []).find((c) =>
        samePlace_(name, c, lat, lng, approx),
      ); // 上位5件から、同じ店だけを選ぶ
      if (cand) {
        place = cand;
        if (!pid) savePid_(url, cand.id);
      }
    }

    const out = { photos: [] };
    const list = ((place && place.photos) || [])
      .filter((p) => /^places\/[\w-]+\/photos\/[\w-]+$/.test(String(p.name)))
      .slice(0, PHOTO_MAX);
    if (list.length) {
      dailyBudget_(list.length);
      const reqs = list.map((p) => ({
        url:
          PLACES_HOST_ +
          p.name +
          "/media?maxWidthPx=" +
          PHOTO_WIDTH_PX +
          "&skipHttpRedirect=true",
        headers: { "X-Goog-Api-Key": mapsKey_() },
        muteHttpExceptions: true,
      }));
      UrlFetchApp.fetchAll(reqs).forEach((res, i) => {
        const m = placesParse_(res);
        if (!m || !PHOTO_HOST_RE_.test(String(m.photoUri))) return;
        const at = (list[i].authorAttributions || [])[0] || {};
        out.photos.push({
          src: m.photoUri,
          by: String(at.displayName || "").slice(0, 60),
          byUrl: safeAuthorUrl_(at.uri),
        });
      });
    }
    if (!out.photos.length)
      out.why = PLACES_ERR_
        ? "取得エラー(" + PLACES_ERR_ + ")"
        : !place
          ? "Googleマップで同じ店を特定できませんでした"
          : "写真が登録されていません";
    if (!PLACES_ERR_) cache.put(ck, JSON.stringify(out), PHOTO_CACHE_SEC); // 通信エラーは覚えない(次に開いたとき、やり直す)
    return out;
  });
}

// 初回に1度だけ、エディタから実行する(外部サービスへの接続の許可を出し、写真が取れるか確認する)
function testPhotos() {
  const key = PropertiesService.getScriptProperties().getProperty("SEARCH_KEY");
  const v = ss_().getSheetByName(FINAL_SHEET).getDataRange().getValues();
  const h = {};
  v[0].forEach((n, i) => {
    h[String(n).trim()] = i;
  });
  const r = v
    .slice(1)
    .find((x) => x[h["状態"]] === "通常" && x[h["緯度"]] !== "");
  const res = getShopPhotos({ k: key, url: r[h["URL"]] });
  Logger.log(r[h["店名"]] + " → " + res.photos.length + "枚");
  Logger.log(JSON.stringify(res));
}

const SEARCH_HTML_ = `<!doctype html><meta charset="utf-8">
<style>
:root{--bg:#fafaf7;--fg:#1c1c1a;--mut:#6b6b66;--card:#fff;--line:#e3e1da;--acc:#16803c;--accfg:#fff;--danger:#b42318;--sel:#ffd9de;--selfg:#7a1a2c;--selbd:#f4a3b0;color-scheme:light dark;--g-bg:rgba(255,255,255,.4);--g-bd:rgba(255,255,255,.7);--g-sh:0 6px 20px rgba(20,60,35,.12),inset 0 1px 0 rgba(255,255,255,.7);--g-acc:rgba(14,98,44,.88);--g-card:rgba(255,255,255,.76);--g-line:rgba(20,60,35,.28);--g-sheen:rgba(255,255,255,.55);--n-d:#d6d4cb;--n-l:#fff;--b1:rgba(63,179,107,.4);--b2:rgba(255,196,120,.4);--b3:rgba(120,180,255,.36);--b4:rgba(220,140,255,.3)}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161614;--fg:#eceae4;--mut:#a09e96;--card:#1f1f1c;--line:#34332e;--acc:#3fb36b;--accfg:#0b1f12;--danger:#f08a80;--sel:#f5b8c4;--selfg:#4a0f1c;--selbd:#e88a9b;--g-bg:rgba(255,255,255,.12);--g-bd:rgba(255,255,255,.3);--g-sh:0 6px 20px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.28);--g-acc:rgba(72,190,118,.9);--g-card:rgba(24,24,22,.66);--g-line:rgba(255,255,255,.3);--g-sheen:rgba(255,255,255,.14);--n-d:#000;--n-l:#34342e;--b1:rgba(63,179,107,.55);--b2:rgba(255,160,90,.45);--b3:rgba(90,140,255,.5);--b4:rgba(170,110,255,.4)}}
:root[data-theme="dark"]{--bg:#161614;--fg:#eceae4;--mut:#a09e96;--card:#1f1f1c;--line:#34332e;--acc:#3fb36b;--accfg:#0b1f12;--danger:#f08a80;--sel:#f5b8c4;--selfg:#4a0f1c;--selbd:#e88a9b;--g-bg:rgba(255,255,255,.12);--g-bd:rgba(255,255,255,.3);--g-sh:0 6px 20px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.28);--g-acc:rgba(72,190,118,.9);--g-card:rgba(24,24,22,.66);--g-line:rgba(255,255,255,.3);--g-sheen:rgba(255,255,255,.14);--n-d:#000;--n-l:#34342e;--b1:rgba(63,179,107,.55);--b2:rgba(255,160,90,.45);--b3:rgba(90,140,255,.5);--b4:rgba(170,110,255,.4);color-scheme:dark}
:root[data-theme="light"]{color-scheme:light}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 12px}
fieldset{border:0;padding:0;margin:0 0 14px}
legend{font-size:13px;color:var(--mut);margin-bottom:6px;padding:0}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip input{position:absolute;opacity:0;pointer-events:none}
.chip span{display:inline-block;padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);cursor:pointer}
.chip small{margin-left:6px;font-size:12px;opacity:.7}
button.area{padding:8px 14px;border-radius:999px;background:var(--card);color:var(--fg);border:1px solid var(--line)}
button.area small{margin-left:6px;font-size:12px;opacity:.7}
button.area:hover{border-color:var(--acc)}
button.area[aria-pressed="true"]{background:var(--acc);color:var(--accfg);border-color:var(--acc)}
button.area[aria-pressed="true"] small{opacity:.85}
#histClear{padding:3px 12px;font-size:13px;margin-left:10px}
.chip input:checked+span{background:var(--acc);color:var(--accfg);border-color:var(--acc)}
.row{display:flex;gap:8px;flex-wrap:wrap}
select,input[type=text]{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
input[type=text]{flex:1;min-width:140px}
button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid var(--acc);background:var(--acc);color:var(--accfg);cursor:pointer}
button.sub{background:transparent;color:var(--acc)}
button.del{padding:6px 12px;font-size:14px;background:transparent;color:var(--danger);border-color:var(--danger)}
button:disabled{opacity:.5;cursor:default}
.mut{color:var(--mut);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}
.card.stub{border-style:dashed}
.card h3,.card h4{margin:0 0 4px;font-size:17px}
.card p{margin:2px 0}
.acts{display:flex;gap:12px;align-items:center;margin-top:6px;flex-wrap:wrap}
a{color:var(--acc)}
.tag{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:1px 8px;font-size:13px}
.cnt{font-size:20px;font-weight:700;margin:10px 0 6px}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip{position:absolute;left:8px;top:-60px;background:var(--acc);color:var(--accfg);padding:10px 14px;border-radius:8px;z-index:9}
.skip:focus{top:8px}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.chip input:focus-visible+span{outline:2px solid var(--acc);outline-offset:2px}
.ph-region{margin:0}
#tastes{position:relative}
#clearTaste{position:absolute;right:0;top:-6px;padding:3px 12px;font-size:13px}
.cnt:empty{display:none}
.cnt:focus{outline:none}   /* 見出しはキー操作の受け皿。枠は出さない */
.pager{margin:16px 0}
.pagination{display:flex;flex-wrap:nowrap;gap:4px;justify-content:center;align-items:center;list-style:none;margin:0;padding:0}
.pagination li{margin:0;flex:0 1 auto;min-width:0}
.pagination button{display:inline-flex;align-items:center;justify-content:center;width:37px;height:37px;min-width:0;padding:0;box-sizing:border-box;border:1px solid var(--line);border-radius:50%;background:var(--card);color:var(--fg);font:inherit;font-size:14px;line-height:1;cursor:pointer;user-select:none}
.pagination .button button{font-size:13px;white-space:nowrap}
.pagination .cur{display:flex}
.pagination .cur span{display:inline-flex;align-items:center;justify-content:center;width:37px;height:37px;box-sizing:border-box;border-radius:50%;background:var(--sel);color:var(--selfg);border:1px solid var(--selbd);font-weight:700;font-size:14px;line-height:1}
.pagination button:hover:not(:disabled){background:var(--line)}
.pagination button:active:not(:disabled){transform:scale(.92)}
.pagination button:disabled{color:var(--mut);opacity:.5;cursor:default}
.pagination button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.pagination button:active:not(:disabled){transform:none}}
.photos{margin:0 0 8px}
.ph-strip{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;margin:0;padding:0 0 4px;list-style:none;-webkit-overflow-scrolling:touch}
.ph-strip li{flex:0 0 78%;max-width:300px;scroll-snap-align:start}
.ph-strip img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;display:block;background:var(--line)}
.ph-by{font-size:12px;margin:2px 0 0;color:var(--mut)}
@media(prefers-reduced-motion:no-preference){.ph-strip li{animation:phin .4s ease both}@keyframes phin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}
/* ===== ラップ・ローディング(読み込みが終わるまで、本文は見せない) ===== */
html:not(.is-ready){overflow:hidden}
.wrap{opacity:0;visibility:hidden;transition:opacity .6s ease,visibility .6s ease}
.is-ready .wrap{opacity:1;visibility:visible}
.loading{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;transition:opacity .6s ease,visibility .6s ease}
.is-ready .loading{opacity:0;visibility:hidden}
.gcard{display:flex;flex-direction:column;align-items:center;gap:14px;padding:28px 40px;border-radius:20px;background:var(--g-bg);border:1px solid var(--g-bd);box-shadow:var(--g-sh);-webkit-backdrop-filter:blur(14px) saturate(150%);backdrop-filter:blur(14px) saturate(150%)}
.spin{width:40px;height:40px;border-radius:50%;border:4px solid var(--g-bd);border-top-color:var(--acc);animation:gspin 1s linear infinite}
.ltxt{margin:0;font-size:13px;letter-spacing:2px;color:var(--mut)}
@keyframes gspin{to{transform:rotate(360deg)}}
@keyframes gpulse{50%{opacity:.35}}
/* ===== 背景(グラスの後ろに色を置く。スクロールで少しずつずらす) ===== */
.bg{position:fixed;inset:0;overflow:hidden;z-index:-1;pointer-events:none}
.bg i{position:absolute;border-radius:50%;filter:blur(36px);transform:translate3d(0,calc(var(--sy,0)*var(--rate,0)*1px),0)}
.b1{width:320px;height:320px;left:-80px;top:6%;background:var(--b1);--rate:-.12}
.b2{width:280px;height:280px;right:-70px;top:38%;background:var(--b2);--rate:-.25}
.b3{width:300px;height:300px;left:25%;bottom:-90px;background:var(--b3);--rate:-.06}
/* ===== グラスモーフィズム(ボタン) ===== */
button{background:var(--g-acc);border-color:var(--g-bd);-webkit-backdrop-filter:blur(10px) saturate(150%);backdrop-filter:blur(10px) saturate(150%);box-shadow:var(--g-sh);transition:transform .15s ease,box-shadow .2s ease}
button.sub,button.del,button.area,.pagination button{background:var(--g-bg)}
button.sub,button.area,.pagination button{border-color:var(--g-bd)}
button.area[aria-pressed="true"]{background:var(--g-acc);border-color:var(--g-bd)}
button:hover:not(:disabled){transform:translateY(-1px)}
button:active:not(:disabled){transform:translateY(0)}
/* ===== ヘッダー(ページ内ナビ。見ている場所に合わせて光る) ===== */
.topbar{position:sticky;top:8px;z-index:5;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;margin:0 0 12px;border-radius:16px;background:var(--g-bg);border:1px solid var(--g-bd);box-shadow:var(--g-sh);-webkit-backdrop-filter:blur(12px) saturate(150%);backdrop-filter:blur(12px) saturate(150%)}
.topbar h1{margin:0;flex:1 1 auto}
.topnav{display:flex;gap:4px;order:3;flex:0 0 100%}
.topnav a{padding:6px 10px;border-radius:999px;text-decoration:none;color:var(--fg);font-size:14px}
.topnav a.is-current{background:var(--g-acc);color:var(--accfg)}
.sec,.grp{scroll-margin-top:calc(var(--hdr,160px) + 8px)}
/* ===== ニューモーフィズム(ダークモードのトグル) ===== */
#themeBtn{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;padding:4px 4px 4px 10px;border:0;border-radius:999px;background:transparent;color:var(--fg);box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}
#themeBtn:hover:not(:disabled),#themeBtn:active:not(:disabled){transform:none}
#themeBtn .tl{font-size:13px;font-weight:700;white-space:nowrap}
#themeBtn .trk{position:relative;display:flex;align-items:center;justify-content:space-between;width:68px;height:34px;padding:0 9px;box-sizing:border-box;border-radius:17px;border:2px solid var(--mut);background:var(--line);box-shadow:inset 3px 3px 6px var(--n-d),inset -3px -3px 6px var(--n-l);transition:background .25s ease}
#themeBtn .ic{font-size:14px;line-height:1}
#themeBtn .knob{position:absolute;top:2px;left:2px;width:26px;height:26px;border-radius:50%;background:#fff;box-shadow:2px 3px 6px var(--n-d),-1px -1px 4px var(--n-l);transition:left .25s ease}
#themeBtn[aria-checked="true"] .trk{background:var(--acc);border-color:var(--acc)}
#themeBtn[aria-checked="true"] .knob{left:36px}
/* ===== 多層のガラス(結果のカード・チップ・入力欄・エリアのナビ) ===== */
.card{background:var(--g-card);border-color:var(--g-bd);border-radius:16px;box-shadow:var(--g-sh);-webkit-backdrop-filter:blur(14px) saturate(150%);backdrop-filter:blur(14px) saturate(150%);transition:transform .2s ease,box-shadow .2s ease}
.card:hover{transform:translateY(-2px)}
.chip span,select,input[type=text],.tag{background:var(--g-card);border-color:var(--g-bd);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.chip input:checked+span{background:var(--g-acc);border-color:var(--g-bd)}
.gh{font-size:16px;margin:16px 0 2px;padding:0 2px}
.gh small{font-weight:400;color:var(--mut);font-size:13px}
.areanav{order:4;flex:0 0 100%;display:flex;gap:6px;overflow-x:auto;padding:2px 0 4px;min-height:36px;box-sizing:border-box;scrollbar-width:thin}
.areanav[hidden]{display:none}
.areanav a{flex:0 0 auto;white-space:nowrap;padding:4px 10px;border-radius:999px;text-decoration:none;color:var(--fg);font-size:12.5px;background:var(--g-card);border:1px solid var(--g-bd)}
.areanav a small{margin-left:4px;opacity:.75}
.areanav a.is-current{background:var(--g-acc);color:var(--accfg)}
@media(prefers-reduced-motion:no-preference){.card{animation:cardin .5s ease backwards;animation-delay:calc(min(var(--i,0),12)*50ms)}@keyframes cardin{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}}
/* ===== トグルもガラス(すりガラスの溝と、つやのあるつまみ) ===== */
#themeBtn .trk{border:1.5px solid var(--g-line);background:var(--g-bg);box-shadow:var(--g-sh);-webkit-backdrop-filter:blur(8px) saturate(160%);backdrop-filter:blur(8px) saturate(160%)}
#themeBtn .knob{background:linear-gradient(135deg,rgba(255,255,255,.98),rgba(255,255,255,.6));border:1px solid rgba(255,255,255,.85);box-shadow:0 2px 8px rgba(0,0,0,.3),inset 0 1px 0 #fff}
#themeBtn[aria-checked="true"] .trk{background:var(--g-acc);border-color:var(--g-line)}
.topbar,.card,.gcard,.areanav a{background-image:linear-gradient(135deg,var(--g-sheen),transparent 60%)}
#themeBtn .trk,#themeBtn[aria-checked="true"] .trk{background-image:linear-gradient(135deg,var(--g-sheen),transparent 60%)}
.areanav a.is-current{background-image:none}
/* ===== ガラスを強く(色の丸は中央の列の後ろに置く) ===== */
.bg i{filter:blur(48px)}
.b1{width:440px;height:440px;left:calc(50% - 420px);top:8%}
.b2{width:400px;height:400px;left:calc(50% + 40px);right:auto;top:30%}
.b3{width:420px;height:420px;left:calc(50% - 200px);bottom:-120px}
.b4{width:300px;height:300px;left:calc(50% + 120px);top:-60px;background:var(--b4);--rate:-.18}
.topbar,.card,.gcard{-webkit-backdrop-filter:blur(22px) saturate(180%);backdrop-filter:blur(22px) saturate(180%)}
.topbar{background-color:var(--g-card)}
button.sub,button.del,button.area,.pagination button{background-color:var(--g-card)}
.areanav a.is-empty{opacity:.75;border-style:dashed}
.areanav a.is-origin::before{content:"";display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:var(--acc);vertical-align:middle}
.areanav a.is-current.is-origin::before{background:var(--accfg)}
@media(min-width:768px){.areanav{flex-wrap:wrap;overflow:visible}}
@media(max-height:520px){.areanav{max-height:76px;overflow-y:auto}}
/* ===== エリアの縦スライダー(広い画面の右側)・トップへ戻る(クリスタル)・もっと見る ===== */
#topSent{position:absolute;top:0;left:0;width:1px;height:420px;pointer-events:none}
.topbar h1:focus{outline:none}
.moreBox{display:flex;justify-content:center;margin:14px 0}
.moreBox[hidden]{display:none}
.gem{background:radial-gradient(circle,rgba(0,0,0,.28),transparent 65%),linear-gradient(135deg,rgba(255,255,255,.6) 0,rgba(255,255,255,.08) 40%,rgba(255,255,255,.35) 62%,rgba(255,255,255,.06) 100%),conic-gradient(from calc(var(--prog,0)*360deg + 20deg),var(--b1),var(--b3),var(--b4),var(--b2),var(--b1));clip-path:var(--clip);-webkit-backdrop-filter:blur(8px) saturate(180%);backdrop-filter:blur(8px) saturate(180%)}
.rail{display:none;position:fixed;right:max(14px,env(safe-area-inset-right));top:50%;transform:translateY(-50%);z-index:15;width:44px;height:min(56vh,440px);touch-action:none;cursor:pointer;--p:0}
@media(min-width:768px){.rail:not([hidden]){display:block}}
.rtrack{position:absolute;left:50%;top:0;bottom:0;width:8px;margin-left:-4px;border-radius:4px;background:var(--g-bg);border:1px solid var(--g-line);box-shadow:var(--g-sh);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.rfill{position:absolute;left:0;right:0;top:0;height:calc(var(--p)*100%);border-radius:4px;background:linear-gradient(var(--b1),var(--b4))}
.rticks{position:absolute;inset:0}
.rticks i{position:absolute;left:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:var(--g-line)}
.rthumb{position:absolute;left:50%;top:calc(var(--p)*100%);width:26px;height:30px;margin:-15px 0 0 -13px;--clip:polygon(50% 0,100% 50%,50% 100%,0 50%);transition:top .3s ease}
.rbubble{position:absolute;right:38px;top:calc(var(--p)*100%);transform:translateY(-50%);white-space:nowrap;padding:4px 12px;border-radius:999px;font-size:13px;color:var(--fg);background:var(--g-card);border:1px solid var(--g-bd);box-shadow:var(--g-sh);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);transition:top .3s ease}
.rail:focus-visible{outline:2px solid var(--acc);outline-offset:4px;border-radius:22px}
.totop{position:fixed;right:max(18px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));z-index:20;width:64px;height:64px;padding:0;border:0;border-radius:0;background:none;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;display:grid;place-items:center;filter:drop-shadow(0 8px 16px rgba(0,0,0,.35));opacity:0;visibility:hidden;transform:translateY(24px) scale(.8);transition:opacity .5s ease,transform .5s ease,visibility .5s}
.totop.is-show{opacity:1;visibility:visible;transform:none}
.totop.is-show:hover:not(:disabled){transform:translateY(-3px) scale(1.06)}
.totop>*{grid-area:1/1}
.tt-ring{width:64px;height:64px;clip-path:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);background:conic-gradient(var(--acc) calc(var(--prog,0)*360deg),rgba(255,255,255,.2) 0)}
.tt-gem{width:52px;height:52px;--clip:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%)}
.tt-arrow{position:relative;color:#fff;filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))}
@media(prefers-reduced-motion:no-preference){.totop.is-show .tt-ring{animation:ttbob 3.2s ease-in-out infinite}.tt-gem{transform:rotate(calc(var(--prog,0)*120deg))}@keyframes ttbob{50%{transform:translateY(-4px)}}}
/* ===== スマホ(767px以下): ヘッダーを小さく・タップしやすい大きさに ===== */
a,button,label,select,summary{touch-action:manipulation}
.card h4 a,.card .acts a{display:inline-block;padding:4px 0}
#histClear,#clearTaste{min-height:32px}
@media(max-width:767px){
main{padding:10px}
.topbar{padding:6px 10px;gap:6px;top:4px;margin-bottom:8px}
.topbar h1{font-size:16px;flex:0 0 auto}
.topnav{order:0;flex:1 1 auto;justify-content:center;align-items:center;gap:2px}
.topnav a{padding:6px 7px;font-size:12.5px;min-height:34px;display:inline-flex;align-items:center}
#themeBtn{padding:0}
#themeBtn .tl{display:none}
.areanav{gap:5px;min-height:34px}
.areanav a{min-height:34px;display:inline-flex;align-items:center;padding:4px 11px}
}
/* ===== 動きを減らす設定・ぼかしが使えない環境では、すりガラスをやめて、ふつうの塗りにする ===== */
@media(prefers-reduced-motion:reduce){.spin{animation:gpulse 1.6s ease-in-out infinite}.wrap,.loading{transition:none}.bg i{transform:none}button:hover:not(:disabled),button:active:not(:disabled){transform:none}#themeBtn .knob{transition:none}.rthumb,.rbubble{transition:none}.totop{transition:opacity .2s}}
@media(prefers-reduced-transparency:reduce){button{background:var(--acc);-webkit-backdrop-filter:none;backdrop-filter:none}button.sub,button.del,button.area,.pagination button,.gcard,.topbar,.card,.chip span,select,input[type=text],.tag,.areanav a,.rbubble,#themeBtn .trk{background:var(--card);-webkit-backdrop-filter:none;backdrop-filter:none}.topnav a.is-current,.areanav a.is-current,#themeBtn[aria-checked="true"] .trk,button.area[aria-pressed="true"]{background:var(--acc)}}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){button{background:var(--acc)}button.sub,button.del,button.area,.pagination button,.gcard,.topbar,.card,.chip span,select,input[type=text],.tag,.areanav a,.rbubble,#themeBtn .trk{background:var(--card)}.topnav a.is-current,.areanav a.is-current,#themeBtn[aria-checked="true"] .trk,button.area[aria-pressed="true"]{background:var(--acc)}}
/* ===== 仕上げ: ガラス・スマホ・三角ボタン・登場 ===== */
/* --- ガラスの考え方: ①後ろに色(背景の丸) ②半透明の面(白を8〜35%) ③ぼかし+彩度 ④縁の光(上と左を明るく) ⑤うっすら斜めのつや ⑥影 --- */
:root{--g-bg:rgba(255,255,255,.30);--g-card:rgba(255,255,255,.32);--g-bd:rgba(255,255,255,.7);--g-bd-hi:rgba(255,255,255,.95);--g-bd-lo:rgba(255,255,255,.32);--g-sheen:rgba(255,255,255,.7);--g-sh:0 10px 30px rgba(31,45,120,.16),inset 0 1px 0 rgba(255,255,255,.85),inset 0 -1px 0 rgba(255,255,255,.2);--b1:rgba(63,179,107,.5);--b2:rgba(255,176,90,.5);--b3:rgba(90,150,255,.5);--b4:rgba(200,110,255,.42);--tt-tint:linear-gradient(135deg,rgba(40,110,210,.5),rgba(150,60,210,.42))}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--g-bg:rgba(255,255,255,.10);--g-card:rgba(255,255,255,.075);--g-bd:rgba(255,255,255,.24);--g-bd-hi:rgba(255,255,255,.5);--g-bd-lo:rgba(255,255,255,.1);--g-sheen:rgba(255,255,255,.2);--g-sh:0 12px 34px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.3),inset 0 -1px 0 rgba(255,255,255,.06);--b1:rgba(63,179,107,.6);--b2:rgba(255,150,80,.5);--b3:rgba(80,130,255,.58);--b4:rgba(170,100,255,.48);--tt-tint:linear-gradient(135deg,rgba(63,179,107,.45),rgba(150,90,255,.4))}}
:root[data-theme="dark"]{--g-bg:rgba(255,255,255,.10);--g-card:rgba(255,255,255,.075);--g-bd:rgba(255,255,255,.24);--g-bd-hi:rgba(255,255,255,.5);--g-bd-lo:rgba(255,255,255,.1);--g-sheen:rgba(255,255,255,.2);--g-sh:0 12px 34px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.3),inset 0 -1px 0 rgba(255,255,255,.06);--b1:rgba(63,179,107,.6);--b2:rgba(255,150,80,.5);--b3:rgba(80,130,255,.58);--b4:rgba(170,100,255,.48);--tt-tint:linear-gradient(135deg,rgba(63,179,107,.45),rgba(150,90,255,.4))}
.topbar,.card,.gcard,#areasWrap.open{background-color:var(--g-card);border-color:var(--g-bd-hi) var(--g-bd-lo) var(--g-bd-lo) var(--g-bd-hi);-webkit-backdrop-filter:blur(20px) saturate(185%);backdrop-filter:blur(20px) saturate(185%)}
.chip span,select,input[type=text],.tag,button.sub,button.area,button.del,.pagination button{border-color:var(--g-bd-hi) var(--g-bd-lo) var(--g-bd-lo) var(--g-bd-hi)}
button.area[aria-pressed="true"],.chip input:checked+span{border-color:var(--g-bd-hi)}
/* 背景の丸: スクロールで、縦と横にずらす(IntersectionObserver版のパララックスは、下の rv/pop) */
.bg i{transform:translate3d(calc(var(--sx,0)*var(--rx,0)*1px),calc(var(--sy,0)*var(--rate,0)*1px),0)}
.b1{--rx:.30}.b2{--rx:-.40}.b3{--rx:.25}.b4{--rx:-.20}
/* --- 説明の文字は、見た目には出さない(読み上げには残す)--- */
#now{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
fieldset{margin:0 0 8px}
/* --- 条件の欄を、小さく --- */
.chips{gap:6px}
.chip span{padding:5px 11px;font-size:14px}
.chip small{margin-left:4px}
.row.cond select{flex:1 1 0;min-width:0}
#budget{flex:1.25 1 0}#mode{flex:.8 1 0}
.row.org input[type=text]{min-width:90px}
.trow{display:flex;gap:8px;align-items:center}
.trow .chips{flex:1 1 auto;min-width:0}
.trow>button{flex:0 0 auto}
button.tiny{padding:3px 10px;font-size:12.5px;min-height:30px}
#tastes{position:static}
#clearTaste{position:static;top:auto;right:auto}
button.area{padding:5px 11px;font-size:14px}
#areaToggle{display:none;width:100%;margin:8px 0 0;align-items:center;gap:6px;justify-content:flex-start;text-align:left}
#areaToggle .car{margin-left:auto;transition:transform .2s ease}
#areaToggle[aria-expanded="true"] .car{transform:rotate(180deg)}
#areasWrap{margin-top:8px}
#histBox{margin-top:8px}
/* 削除した店: ゴミ箱の絵文字だけ。強調しない */
.topnav a.trash{font-size:16px;line-height:1;padding:5px 8px}
.topnav a.trash.is-current{background:none;color:var(--fg)}
#showhidden{padding:4px 10px;font-size:18px;line-height:1;background:transparent;box-shadow:none;border-color:transparent;-webkit-backdrop-filter:none;backdrop-filter:none;opacity:.7}
#showhidden:hover:not(:disabled){opacity:1}
/* --- エリアのナビ: バーを出さない(PCは折り返す。狭い画面は、ヘッダーから外す)--- */
@media(min-width:768px){.areanav{flex-wrap:wrap;overflow:visible;max-height:none}}
@media(max-height:520px){.areanav{max-height:none;overflow:visible;flex-wrap:wrap}}
@media(min-width:768px){.topbar{flex-wrap:wrap;gap:6px 10px;padding:6px 12px}.topbar h1{font-size:18px;flex:0 0 auto}.topnav{order:0;flex:1 1 auto;justify-content:flex-start;gap:2px}#themeBtn .tl{display:none}}
html:not(.has-results) .areanav{display:none}
/* ===== スマホ(767px以下): ヘッダーは1行。エリアは閉じた1行 ===== */
@media(max-width:767px){
  main{padding:8px 10px 28px}
  .topbar{flex-wrap:nowrap;top:4px;padding:5px 8px;gap:6px;margin:0 0 6px;border-radius:14px}
  .topbar h1{font-size:15px;white-space:nowrap;flex:0 0 auto}
  .topnav{order:0;flex:1 1 auto;justify-content:flex-end;gap:0}
  .topnav a{padding:5px 8px;font-size:12.5px;min-height:32px}
  .areanav{display:none}
  #themeBtn .trk{width:52px;height:28px;padding:0 7px;border-radius:14px}
  #themeBtn .ic{font-size:12px}
  #themeBtn .knob{width:22px;height:22px;top:2px;left:2px}
  #themeBtn[aria-checked="true"] .knob{left:26px}
  .chip small{display:none}
  .chip span{padding:4px 9px;font-size:13px}
  .trow .chips{gap:5px}
  select,input[type=text]{padding:7px 8px;font-size:15px}
  button{padding:8px 12px;font-size:15px}
  #areaToggle{display:flex}
  #areasWrap{display:none}
  #areasWrap.open{display:block;margin-top:6px;padding:8px;border-radius:14px;border:1px solid var(--g-bd);box-shadow:var(--g-sh)}
  #areasWrap .chips{gap:5px}
  #areasWrap button.area{padding:4px 9px;font-size:13px}
  #areasWrap button.area small{margin-left:3px;font-size:11px}
  .card{padding:10px 12px}
}
/* ===== スクロールの登場(IntersectionObserver): 画面に入る割合に合わせて、下から浮かび、少し奥から起きてくる ===== */
.rv{opacity:var(--ro,0);transform:translate3d(0,calc((var(--ry,26) + var(--hy,0))*1px),0) scale(calc(.97 + .03*var(--ro,0)));transition:opacity .25s linear,transform .25s linear}
.rv.rv-done{opacity:1;transform:translate3d(0,calc(var(--hy,0)*1px),0) scale(1);transition:opacity .4s ease,transform .6s cubic-bezier(.2,.8,.2,1)}
.card.rv{animation:none}
.card.rv:hover{--hy:-2}
.no-rv .rv{opacity:1;transform:none;transition:none}
/* 押したくなるボタン: 画面に入ると、ぽんと跳ねて出て、つやが一度走る。「さらに表示」は、そのあと、ゆっくり呼吸する */
.pushy{position:relative;overflow:hidden}
.pushy:not(.pop):not(.popped){opacity:0}
.no-rv .pushy:not(.pop):not(.popped){opacity:1}
.pushy::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.65) 50%,transparent 70%);transform:translateX(-130%)}
@keyframes popin{0%{opacity:0;transform:translate3d(0,18px,0) scale(.82)}55%{opacity:1;transform:translate3d(0,-4px,0) scale(1.06)}100%{opacity:1;transform:none}}
@keyframes sheen{from{transform:translateX(-130%)}to{transform:translateX(130%)}}
@keyframes breathe{50%{transform:scale(1.035)}}
@media(prefers-reduced-motion:no-preference){
  .pushy.pop{animation:popin .65s cubic-bezier(.34,1.56,.64,1) both}
  .pushy.pop::after{animation:sheen 1.1s ease .45s 1 both}
  .pushy.cta.popped:not(:hover):not(:active){animation:breathe 2.8s ease-in-out 1s infinite}
}
/* ===== トップへ戻る: 直角二等辺三角形。直角を、画面の右下の角に合わせる。すりガラス ===== */
.totop{position:fixed;right:0;bottom:0;left:auto;top:auto;z-index:20;width:92px;height:92px;padding:0;border:0;border-radius:0;background:none;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;display:block;filter:none;opacity:1;pointer-events:none;overflow:visible;visibility:hidden;transform:translate3d(40px,40px,0) scale(.5);transform-origin:100% 100%;transition:transform .7s cubic-bezier(.34,1.56,.64,1),visibility 0s linear .7s}
.totop.is-show{visibility:visible;transform:none;transition:transform .7s cubic-bezier(.34,1.56,.64,1),visibility 0s}
.totop.is-show:hover:not(:disabled){transform:scale(1.08)}
.totop.is-show:active:not(:disabled){transform:scale(.94);transition-duration:.12s}
.totop .tt-shadow{position:absolute;inset:0;filter:drop-shadow(-4px -4px 10px rgba(0,0,0,.35));pointer-events:none}
.totop .tt-tri,.totop .tt-edge,.totop .tt-face,.totop .tt-sheen{position:absolute;inset:0;clip-path:polygon(100% 0,100% 100%,0 100%)}
.totop .tt-tri{background:rgba(0,0,0,.4)}
.totop .tt-edge{background:linear-gradient(135deg,rgba(255,255,255,.95),rgba(255,255,255,.22) 50%,rgba(255,255,255,.7));pointer-events:auto;cursor:pointer}
.totop .tt-face{inset:1.5px 0 0 1.5px;background:linear-gradient(135deg,rgba(255,255,255,.34),rgba(255,255,255,.06) 60%,rgba(255,255,255,.2)),var(--tt-tint);-webkit-backdrop-filter:blur(16px) saturate(190%);backdrop-filter:blur(16px) saturate(190%);pointer-events:auto;cursor:pointer}
.totop .tt-sheen{pointer-events:none;background:linear-gradient(115deg,transparent 35%,rgba(255,255,255,.6) 50%,transparent 65%);transform:translateX(-130%)}
.totop .tt-arrow{position:absolute;right:calc(15px + env(safe-area-inset-right,0px));bottom:calc(15px + env(safe-area-inset-bottom,0px));width:26px;height:26px;color:#fff;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55));pointer-events:auto;cursor:pointer}
.totop:focus-visible{outline:none}
.totop:focus-visible .tt-edge{background:var(--acc)}
.totop:focus-visible .tt-face{background-color:rgba(255,255,255,.3)}
@keyframes ttsweep{0%{transform:translateX(-130%)}16%,100%{transform:translateX(130%)}}
@keyframes ttnudge{50%{transform:translateY(-3px)}}
@media(prefers-reduced-motion:no-preference){
  .totop.is-show .tt-sheen{animation:ttsweep 6s ease .6s infinite}
  .totop.is-show .tt-arrow{animation:ttnudge 2.4s ease-in-out 1.2s infinite}
}
@media(prefers-reduced-motion:reduce){.totop,.totop.is-show{transition:none}.totop{transform:none}.rv,.rv.rv-done{transition:none}}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.totop .tt-face{background:var(--acc)}#areasWrap.open{background:var(--card)}}
@media(prefers-reduced-transparency:reduce){.totop .tt-face{background:var(--acc);-webkit-backdrop-filter:none;backdrop-filter:none}#areasWrap.open{background:var(--card);-webkit-backdrop-filter:none;backdrop-filter:none}}
/* ===== ダーク: 黒を基調にした、落ち着いた配色(色の丸はグレー寄りに抑え、差し色はシャンパンゴールドだけ) ===== */
:root{--glow:rgba(22,128,60,.2);--tt-edge:linear-gradient(135deg,rgba(255,255,255,.95),rgba(255,255,255,.22) 50%,rgba(255,255,255,.7));--tt-ic:#fff}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b0b0c;--fg:#ece9e3;--mut:#9b978e;--card:#151516;--line:#2b2b2d;--acc:#d2bd8a;--accfg:#17130a;--danger:#e9998f;--g-bg:rgba(255,255,255,.06);--g-card:rgba(255,255,255,.05);--g-bd:rgba(255,255,255,.18);--g-bd-hi:rgba(255,255,255,.3);--g-bd-lo:rgba(255,255,255,.07);--g-line:rgba(255,255,255,.22);--g-sheen:rgba(255,255,255,.07);--g-sh:0 14px 36px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.14),inset 0 -1px 0 rgba(255,255,255,.03);--g-acc:rgba(210,189,138,.94);--n-d:#000;--n-l:#2a2a2c;--b1:rgba(150,160,176,.16);--b2:rgba(196,168,120,.13);--b3:rgba(112,122,142,.15);--b4:rgba(214,204,188,.08);--glow:rgba(210,189,138,.26);--tt-tint:linear-gradient(135deg,rgba(255,255,255,.16),rgba(210,189,138,.16));--tt-edge:linear-gradient(135deg,rgba(255,255,255,.75),rgba(210,189,138,.7) 50%,rgba(255,255,255,.4));--tt-ic:#f4eee0}}
:root[data-theme="dark"]{--bg:#0b0b0c;--fg:#ece9e3;--mut:#9b978e;--card:#151516;--line:#2b2b2d;--acc:#d2bd8a;--accfg:#17130a;--danger:#e9998f;--g-bg:rgba(255,255,255,.06);--g-card:rgba(255,255,255,.05);--g-bd:rgba(255,255,255,.18);--g-bd-hi:rgba(255,255,255,.3);--g-bd-lo:rgba(255,255,255,.07);--g-line:rgba(255,255,255,.22);--g-sheen:rgba(255,255,255,.07);--g-sh:0 14px 36px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.14),inset 0 -1px 0 rgba(255,255,255,.03);--g-acc:rgba(210,189,138,.94);--n-d:#000;--n-l:#2a2a2c;--b1:rgba(150,160,176,.16);--b2:rgba(196,168,120,.13);--b3:rgba(112,122,142,.15);--b4:rgba(214,204,188,.08);--glow:rgba(210,189,138,.26);--tt-tint:linear-gradient(135deg,rgba(255,255,255,.16),rgba(210,189,138,.16));--tt-edge:linear-gradient(135deg,rgba(255,255,255,.75),rgba(210,189,138,.7) 50%,rgba(255,255,255,.4));--tt-ic:#f4eee0}
/* ===== トップへ戻る: 形はそのまま。ボタンと分かるように、文字(TOP)・はっきりした縁・ホバーとクリックの反応を足す ===== */
.totop{width:104px;height:104px}
.totop .tt-edge{background:var(--tt-edge)}
.totop .tt-arrow{right:calc(15px + env(safe-area-inset-right,0px));bottom:calc(31px + env(safe-area-inset-bottom,0px));width:24px;height:24px;color:var(--tt-ic);transition:transform .2s ease}
.totop .tt-label{position:absolute;right:calc(13px + env(safe-area-inset-right,0px));bottom:calc(10px + env(safe-area-inset-bottom,0px));font:700 11px/1 system-ui,-apple-system,"Hiragino Sans",sans-serif;letter-spacing:.14em;color:var(--tt-ic);text-shadow:0 1px 2px rgba(0,0,0,.6);pointer-events:auto;cursor:pointer;transition:letter-spacing .25s ease}
.totop .tt-clip{position:absolute;inset:0;clip-path:polygon(100% 0,100% 100%,0 100%);pointer-events:none}
.totop .tt-pulse{position:absolute;right:0;bottom:0;width:30px;height:30px;margin:0 -15px -15px 0;border-radius:50%;border:2px solid var(--tt-ic);opacity:0}
.totop.is-click .tt-pulse{animation:ttpulse .6s ease-out}
@keyframes ttpulse{from{opacity:.9;transform:scale(.3)}to{opacity:0;transform:scale(6)}}
.totop .tt-face,.totop .tt-edge{transition:filter .2s ease}
.totop:active .tt-face{filter:brightness(1.35)}
.totop:active .tt-arrow,.totop:active .tt-label{color:#14110a;text-shadow:none}
@media(hover:hover){
  .totop.is-show:hover .tt-face{filter:brightness(1.35)}
  .totop.is-show:hover .tt-arrow,.totop.is-show:hover .tt-label{color:#14110a;text-shadow:none}   /* 明るくなった面の上でも、矢印と文字を読めるように */
  .totop.is-show:hover .tt-edge{filter:brightness(1.2) drop-shadow(0 0 6px var(--glow))}
  .totop.is-show:hover .tt-arrow{animation:none;transform:translateY(-5px)}
  .totop.is-show:hover .tt-label{letter-spacing:.24em}
}
/* ===== ホバー(マウス)とクリック/タップの反応 ===== */
button,.chip span,.areanav a,.topnav a{transition:transform .15s ease,box-shadow .2s ease,background-color .2s ease,border-color .2s ease,filter .2s ease}
@media(hover:hover){
  button:not(:disabled):not(.totop):not([role="switch"]):not([id="showhidden"]):hover{filter:brightness(1.14);box-shadow:var(--g-sh),0 0 0 3px var(--glow)}
  .chip span:hover,.areanav a:hover,.topnav a:hover{border-color:var(--g-bd-hi);box-shadow:0 0 0 3px var(--glow)}
  #themeBtn:hover .trk{box-shadow:var(--g-sh),0 0 0 3px var(--glow)}
  .card h4 a:hover,.card .acts a:hover{text-decoration-thickness:2px}
}
button:not(:disabled):not(.totop):not([role="switch"]):active{transform:scale(.97);filter:brightness(.9)}
.chip span:active,.areanav a:active,.topnav a:active{transform:scale(.95)}
#themeBtn:active .trk{transform:scale(.96)}
@media(prefers-reduced-motion:reduce){.totop .tt-pulse{display:none}.totop .tt-label,.totop .tt-arrow{transition:none}button:not(:disabled):active,.chip span:active,.areanav a:active,.topnav a:active,#themeBtn:active .trk{transform:none}}
/* ===== 仕上げ: ライトも落ち着いた配色に(背景の丸は無彩色寄り。差し色は、ダークと同じ系統の金) / 入力の途中経過を、条件の欄のすぐ下に出す ===== */
:root{--bg:#f3f1ed;--fg:#1d1c1a;--mut:#64605a;--card:#fbfaf7;--line:#dcd8d0;--acc:#7a5c1e;--accfg:#fff;--danger:#b3261e;--g-bg:rgba(255,255,255,.55);--g-card:rgba(255,255,255,.66);--g-bd:rgba(255,255,255,.8);--g-bd-hi:rgba(255,255,255,.95);--g-bd-lo:rgba(120,110,95,.2);--g-line:rgba(60,50,35,.28);--g-sheen:rgba(255,255,255,.6);--g-sh:0 10px 28px rgba(60,50,30,.14),inset 0 1px 0 rgba(255,255,255,.9),inset 0 -1px 0 rgba(255,255,255,.3);--g-acc:rgba(122,92,30,.94);--n-d:#d8d4cb;--n-l:#fff;--b1:rgba(160,150,135,.22);--b2:rgba(190,170,130,.18);--b3:rgba(140,145,155,.16);--b4:rgba(205,195,180,.14);--glow:rgba(122,92,30,.22);--tt-tint:linear-gradient(135deg,rgba(60,50,35,.5),rgba(122,92,30,.4));--tt-edge:linear-gradient(135deg,rgba(255,255,255,.95),rgba(220,200,150,.7) 50%,rgba(255,255,255,.7));--tt-ic:#fff}
.orgmsg{margin:8px 2px 0;padding:6px 10px;border-left:3px solid var(--acc);border-radius:6px;background:var(--g-card);font-size:14px;line-height:1.5;color:var(--fg)}
.orgmsg:empty{display:none}
.ver{margin:18px 0 0;text-align:center;font-size:11px;color:var(--mut);opacity:.6}
@media(max-width:767px){
  select,input[type=text]{font-size:16px}   /* 16px未満だと、iPhoneは入力欄をタップしたときに画面を拡大してしまう */
  .chip span{padding:6px 12px;font-size:14px}
  #areaToggle{min-height:44px;font-size:16px}
  #areasWrap button.area{padding:8px 12px;font-size:14px;min-height:40px}
  button{min-height:40px}
}
/* ===== エリア切替(1ボタン+すりガラスの一覧) / ヘッダーのナビは、ピルをやめて下線のタブに ===== */
.areabox{position:relative;margin-top:8px}
#areaToggle{display:flex;width:100%;min-height:44px;align-items:center;gap:8px;justify-content:flex-start;text-align:left;margin:0}
#areaToggle .car{margin-left:auto;transition:transform .2s ease}
#areaToggle[aria-expanded="true"] .car{transform:rotate(180deg)}
.areascrim{display:none}
.arealist{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:30;margin:0;padding:6px;list-style:none;max-height:min(60vh,380px);overflow-y:auto;border-radius:18px;background-color:var(--g-card);background-image:linear-gradient(135deg,var(--g-sheen),transparent 60%);border:1px solid var(--g-bd);box-shadow:var(--g-sh),0 24px 60px rgba(0,0,0,.35);-webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%)}
.arealist[hidden]{display:none}
.arealist:focus{outline:none}
.arealist li{display:flex;align-items:baseline;gap:12px;padding:12px 14px;border-radius:12px;cursor:pointer;touch-action:manipulation}
.arealist li+li{border-top:1px solid var(--g-bd-lo)}
.arealist .an{font-size:17px;font-weight:600;color:var(--fg)}
.arealist .as{font-size:12.5px;color:var(--mut)}
.arealist .ak{margin-left:auto;width:18px;text-align:center;color:var(--acc);font-weight:700}
.arealist li[aria-selected="true"] .ak::before{content:"✓"}
.arealist li.is-active{background:var(--glow)}
@media(hover:hover){.arealist li:hover{background:var(--glow)}}
@media(max-width:767px){
  .areascrim:not([hidden]){display:block;position:fixed;inset:0;z-index:29;background:rgba(0,0,0,.4)}
  .arealist{position:fixed;left:8px;right:8px;top:auto;bottom:calc(8px + env(safe-area-inset-bottom,0px));z-index:30;max-height:70vh;border-radius:22px}
  .arealist li{padding:15px 16px}
}
.arealist li.note{cursor:default;font-size:13px;color:var(--mut)}
.arealist li[data-act="here"] .an{color:var(--acc)}
.arealist li[data-act="far"]{border-top:1px solid var(--g-bd-lo)}
.arealist li[data-act="far"] .an{font-size:14px;font-weight:500;color:var(--mut)}
.areachips{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 6px}
.areahint{font-size:13px;margin:6px 2px}
#areaToggle{display:inline-flex;width:auto;min-height:36px;padding:6px 14px;font-size:13px;margin:2px 0 0}
@media(max-width:767px){
  .areachips{flex-wrap:nowrap;overflow-x:auto;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch;padding-bottom:6px}
  .areachips button.area{flex:0 0 auto;scroll-snap-align:start}
  #areaToggle{min-height:40px;font-size:14px}
}
.areanav{gap:16px;align-items:flex-end}
.areanav a,.areanav a.is-current,.areanav a.is-empty{background:none;background-image:none;border:0;border-radius:0;box-shadow:none;padding:6px 2px;color:var(--mut);font-size:13px;position:relative;opacity:1}
.areanav a::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:2px;background:var(--acc);transform:scaleX(0);transition:transform .25s ease}
.areanav a.is-current{color:var(--fg);font-weight:600}
.areanav a.is-current::after{transform:scaleX(1)}
@media(hover:hover){.areanav a:hover{color:var(--fg);border:0;box-shadow:none}}
</style>
<noscript><style>.wrap{opacity:1;visibility:visible}.pushy{opacity:1!important}.rv{opacity:1!important;transform:none!important}.loading{display:none}html:not(.is-ready){overflow:auto}</style></noscript>
<div class="bg" aria-hidden="true"><i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="b4"></i></div>
<div id="loading" class="loading" role="status"><div class="gcard"><div class="spin" aria-hidden="true"></div><p class="ltxt">読み込み中…</p></div></div>
<div class="wrap" id="wrap">
<div id="topSent" aria-hidden="true"></div>
<a class="skip" href="#count">検索結果へ移動</a>
<main lang="ja">
<header class="topbar"><h1 tabindex="-1">ごはん検索</h1><nav class="topnav" aria-label="ページ内の移動"><a href="#sec-cond">条件</a><a href="#sec-result">結果</a><a href="#sec-hidden" class="trash" aria-label="削除した店を見る"><span aria-hidden="true">🗑</span></a></nav><button type="button" id="themeBtn" role="switch" aria-checked="false" aria-label="ダークモード"><span class="tl" aria-hidden="true">ダーク OFF</span><span class="trk" aria-hidden="true"><span class="ic">☀️</span><span class="ic">🌙</span><span class="knob"></span></span></button><nav id="areanav" class="areanav" aria-label="エリアへ移動" hidden></nav></header>
<section id="sec-cond" class="sec">
<p id="now" class="mut">いま: 確認中...</p>
<fieldset id="tastes"><legend class="sr-only">テイスト</legend><div class="trow"><div class="chips" id="chips" aria-busy="true"></div><button type="button" id="clearTaste" class="sub tiny" aria-label="クリア(テイストの選択をすべて外す)" title="テイストの選択をクリア">✕</button></div></fieldset>
<fieldset><legend class="sr-only">予算・移動手段・所要時間</legend><div class="row cond">
<select id="budget" aria-label="予算の上限(下限がこの金額以下の店)"><option value="">予算:不問</option><option value="1000">〜1,000円</option><option value="2000">〜2,000円</option><option value="3000">〜3,000円</option><option value="5000">〜5,000円</option><option value="10000">〜10,000円</option></select>
<select id="mode" aria-label="移動手段"><option>徒歩</option><option>自転車</option><option>車</option><option>電車</option></select>
<select id="minutes" aria-label="所要時間(分)"><option value="5">5分以内</option><option value="10" selected>10分以内</option><option value="15">15分以内</option><option value="20">20分以内</option><option value="30">30分以内</option><option value="45">45分以内</option><option value="60">60分以内</option></select>
</div></fieldset>
<fieldset><legend class="sr-only">起点</legend><div class="row org">
<button id="here" class="pushy" aria-label="現在地で探す"><span aria-hidden="true">📍</span> 現在地</button>
<input type="text" id="place" aria-label="地名・駅名" placeholder="地名・駅名(例: 博多駅)">
<button id="byname" class="sub pushy" aria-label="地名で探す">探す</button>
</div>
<p id="orgMsg" class="orgmsg" role="status" aria-live="polite"></p>
<div id="areaBox" class="areabox" hidden>
<div id="areaChips" class="chips areachips" role="group" aria-label="近くのエリア"></div>
<p id="areaHint" class="mut areahint" hidden>現在地が分かると、近くのエリアがここに出ます</p>
<button type="button" id="areaToggle" class="sub" aria-haspopup="listbox" aria-expanded="false" aria-controls="areaList"><span aria-hidden="true">🗺</span><span id="areaSel">他の地域</span><span class="car" aria-hidden="true">▾</span></button>
<div id="areaScrim" class="areascrim" hidden></div>
<ul id="areaList" class="arealist" role="listbox" aria-label="他の地域のエリア" tabindex="-1" hidden></ul>
</div>
<div id="histBox" hidden><p class="sr-only" id="histLabel">最近の地名(押すと、入力欄に入れて探します)</p>
<div class="trow"><div class="chips" id="hist" role="group" aria-labelledby="histLabel"></div><button type="button" id="histClear" class="sub tiny" aria-label="最近の地名の履歴をすべて消す">消す</button></div></div></fieldset>
</section>
<section id="sec-result" class="sec">
<p id="msg" class="mut" role="status" aria-live="polite" tabindex="-1"></p>
<h2 id="count" class="cnt" tabindex="-1"></h2>
<nav id="pagerTop" class="pager" aria-label="ページ送り(上)"></nav>
<div id="list"></div>
<div id="moreBox" class="moreBox" hidden><button type="button" id="moreBtn" class="sub pushy cta">さらに表示</button></div>
<nav id="pager" class="pager" aria-label="ページ送り(下)"></nav>
</section>
<section id="sec-hidden" class="sec">
<p><button id="showhidden" class="sub" aria-expanded="false" aria-controls="hidden" aria-label="削除した店を見る"><span aria-hidden="true">🗑</span></button></p>
<div id="hidden"></div>
</section>
<p class="ver" aria-hidden="true">build 1116-c7</p>
</main>
<div id="areaRail" class="rail" role="slider" tabindex="0" aria-orientation="vertical" aria-label="エリアの切り替え(上下の矢印キーで、前後のエリアへ)" aria-valuemin="1" aria-valuemax="1" aria-valuenow="1" aria-valuetext="" hidden><div class="rtrack" aria-hidden="true"><div class="rfill"></div></div><div class="rticks" aria-hidden="true"></div><div class="rthumb gem" aria-hidden="true"></div><div class="rbubble" aria-hidden="true"></div></div>
<button type="button" id="toTop" class="totop" aria-label="ページの先頭へ戻る"><span class="tt-shadow" aria-hidden="true"><span class="tt-tri"></span></span><span class="tt-edge" aria-hidden="true"></span><span class="tt-face" aria-hidden="true"></span><span class="tt-sheen" aria-hidden="true"></span><svg class="tt-arrow" aria-hidden="true" viewBox="0 0 24 24" width="26" height="26"><path d="M12 4l8 9h-5v7H9v-7H4z" fill="currentColor"/></svg><span class="tt-label" aria-hidden="true">TOP</span><span class="tt-clip" aria-hidden="true"><span class="tt-pulse"></span></span></button>
</div>
<script>
var K = __KEY__;
var DEFAULT_TASTES = [{name:'和'},{name:'洋'},{name:'中華'},{name:'アジアン'},{name:'多国籍'}], SAVED_TASTES = [];
var LAST = null;
var ITEMS = [], HID = [], PH = {}, IO = null, PHOTOS_OFF = false, ORIGIN = null, LASTNAME = '', PAGING = false, PAGES = [], META = null, CUR = 1, DEL = {};
function $(id){return document.getElementById(id);}
/* ---- 読み込み: 条件の取得(3件)がそろうまで、ローディングを出す(最大8秒) ---- */
var SEARCHED=false, T0=Date.now(), PENDING_LOAD=3, REVEALED=false;
function revealPage(){ if(REVEALED) return; REVEALED=true; setTimeout(autoStart,1200); document.documentElement.classList.add('is-ready'); if(window.popGo) popGo(); var l=$('loading'); if(l) l.setAttribute('aria-hidden','true'); }
function loadDone(){ PENDING_LOAD--; if(PENDING_LOAD>0) return; setTimeout(revealPage,Math.max(0,500-(Date.now()-T0))); }
setTimeout(revealPage,8000);
/* ---- ダークモードのトグル(未設定なら端末の設定に従う) ---- */
(function(){
  var root=document.documentElement, btn=$('themeBtn'), tl=btn.querySelector('.tl');
  function sysDark(){ return !!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches); }
  function cur(){ return root.getAttribute('data-theme')||(sysDark()?'dark':'light'); }
  function paint(){ var d=cur()==='dark'; btn.setAttribute('aria-checked',d?'true':'false'); tl.textContent=d?'ダーク ON':'ダーク OFF'; }
  try{ var s=localStorage.getItem('gohan_theme'); if(s==='dark'||s==='light') root.setAttribute('data-theme',s); }catch(e){}
  btn.onclick=function(){ var n=cur()==='dark'?'light':'dark'; root.setAttribute('data-theme',n); try{localStorage.setItem('gohan_theme',n);}catch(e){} paint(); };
  paint();
})();
/* ---- ヘッダーのナビ: 画面の真ん中にあるセクションを IntersectionObserver で見つけて光らせる ---- */
(function(){
  var reduce=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches), links={};
  document.querySelectorAll('.topnav a').forEach(function(a){
    var id=a.getAttribute('href').slice(1); links[id]=a;
    a.onclick=function(ev){ ev.preventDefault(); var t=$(id); if(t&&t.scrollIntoView) t.scrollIntoView({behavior:reduce?'auto':'smooth',block:'start'}); };
  });
  function setCur(id){ Object.keys(links).forEach(function(k){ var on=(k===id); links[k].classList.toggle('is-current',on); if(on) links[k].setAttribute('aria-current','true'); else links[k].removeAttribute('aria-current'); }); }
  if(!('IntersectionObserver' in window)) return;
  var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting&&e.target.offsetHeight>0) setCur(e.target.id); }); },{root:null,rootMargin:'-50% 0px',threshold:0});
  Object.keys(links).forEach(function(id){ var el=$(id); if(el) io.observe(el); });
  /* ---- 背景のパララックス(スクロール量を、背景の丸へ渡す) ---- */
  var bg=document.querySelector('.bg'), busy=false;
  if(bg&&!reduce) window.addEventListener('scroll',function(){ if(busy) return; busy=true; requestAnimationFrame(function(){ var y=window.pageYOffset||0; bg.style.setProperty('--sy',String(Math.round(Math.sin(y/900)*420))); bg.style.setProperty('--sx',String(Math.round(Math.cos(y/1100)*260))); busy=false; }); },{passive:true});
})();
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function errText(e){return e&&e.message?e.message:String(e);}
function safeImg(u){u=String(u==null?'':u);return /^https:[/][/][a-z0-9.-]+[.](googleusercontent[.]com|ggpht[.]com)[/]/.test(u)?u:'';}
function safeUrl(u){u=String(u==null?'':u);return /^https:[/][/]/.test(u)?u:'#';}   // https以外(javascript:など)は通さない
var NEWTAB='<span class="sr-only">(新しいタブで開く)</span>';
function settings(){
  var t=[]; document.querySelectorAll('.taste:checked').forEach(function(e){t.push(e.value);});
  if(t.length===document.querySelectorAll('.taste').length) t=[];   // 全部選択 = 絞り込みなし(何も選ばなくても絞り込みなし)
  return {tastes:t,maxBudget:$('budget').value,mode:$('mode').value,minutes:Number($('minutes').value),k:K};
}
function save(){
  try{var s=settings();delete s.k;delete s.place;localStorage.setItem('gohan',JSON.stringify(s));}catch(e){}   // 鍵と、前回の地名の入力は、端末に保存しない
}
function restore(){
  try{
    var s=JSON.parse(localStorage.getItem('gohan')||'null'); if(!s) return;
    if(s.k){ delete s.k; localStorage.setItem('gohan',JSON.stringify(s)); }   // 以前の版が保存した鍵を消す
    SAVED_TASTES=s.tastes||[];   // 前回のテイストの選択を復元する(全選択・未選択のまま検索していた場合は保存が空になり、全選択で開く)
    $('budget').value=s.maxBudget||''; $('mode').value=s.mode||'徒歩'; $('minutes').value=String(s.minutes||10);
    if(s.place!==undefined){ delete s.place; localStorage.setItem('gohan',JSON.stringify(s)); }   // 前回の地名の入力は復元しない(以前の版が保存した分は消す)
  }catch(e){}
}
function go(origin,isHere){
  SEARCHED=true; cancelAuto();
  LAST=isHere?null:origin;   // 条件を変えたときの自動検索で、同じ起点(地名・駅)をもう一度使うため   // 検索を始めるときは、待機中の自動検索を取り消す
  var q=settings(); for(var n in origin) q[n]=origin[n];
  q.page=1; q.all=true;   // 全ページ分を1回で受け取る。ページ送りはサーバーに問い合わせない
  PAGES=[]; DEL={};
  save(); $('msg').textContent='検索中...'; orgSay(''); goToResults(); $('count').textContent=''; $('list').innerHTML=''; $('moreBox').hidden=true; $('pager').innerHTML=''; $('pagerTop').innerHTML='';
  google.script.run.withSuccessHandler(render)
    .withFailureHandler(function(e){
      $('msg').textContent=errText(e); msgShow();
      if(origin&&origin.place){ var pi=$('place'); pi.focus(); pi.select(); }   // 地名のエラーは、入力欄に戻って直せるようにする
    })
    .searchShops(q);
}
function cardInner(it,i){
  return '<div class="photos" data-i="'+i+'"></div>'
    +'<h4 id="t'+i+'"><a href="'+esc(safeUrl(it.url))+'" target="_blank" rel="noopener noreferrer">'+esc(it.name)+NEWTAB+'</a></h4>'
    +'<p class="mut">'+esc(it.taste)+' · '+esc(it.genre)+(it.area?' · '+esc(it.area):'')+'</p>'
    +'<p><b>'+(it.rating!==''?esc(it.rating):'-')+'</b>　'+esc(it.budget)+'</p>'
    +'<p>'+esc(it.distText)+'('+esc(it.walk)+')'+(it.approx?' <span class="mut">位置は目安</span>':'')+'</p>'
    +(it.holiday?'<p class="mut">定休日: '+esc(it.holiday)+'</p>':'')
    +(it.uncertain?'<p class="tag">⚠ 営業日は要確認(不定休など)</p>':'')
    +'<div class="acts"><a href="'+esc(safeUrl(it.map))+'" target="_blank" rel="noopener noreferrer">Googleマップで開く<span class="sr-only">: '+esc(it.name)+'(新しいタブで開く)</span></a>'
    +'<button class="del" data-act="del" data-i="'+i+'" aria-label="'+esc(it.name)+'を削除">この店を削除</button></div>';
}
function stubInner(it,i){
  return '<p id="t'+i+'">「'+esc(it.name)+'」を削除しました(次回から表示されません)</p>'
    +'<div class="acts"><button class="sub" data-act="undo" data-i="'+i+'" aria-label="'+esc(it.name)+'を元に戻す">戻す</button></div>';
}
function render(r){
  document.documentElement.classList.add('has-results');
  afterSuccess();   // 検索に成功したら、入力欄と地名のタグを更新する
  ORIGIN={lat:r.lat,lng:r.lng}; loadLocal();
  LASTNAME=r.originName||'';
  META=r; PAGES=(r.pagesAll&&r.pagesAll.length)?r.pagesAll:[r.items||[]];
  var km=r.radiusM>=1000?(r.radiusM/1000).toFixed(1)+'km':Math.round(r.radiusM)+'m';
  var m=(LASTNAME?'起点: '+LASTNAME:'起点: 現在地')+' / 半径およそ'+km+'(直線) / '+r.jst;
  if(r.closed) m+=' / 今日休みの店'+r.closed+'件を除外';
  if(r.uncertainHidden) m+=' / 営業日が不定の店は、全体の3割までの表示のため'+r.uncertainHidden+'件を省略';
  if(r.notice) m+=' / '+r.notice;
  $('msg').textContent=m;
  showPage(1,FROM_NAME?'search':false); FROM_NAME=false; goToResults();   // 結果を描いたあとにもう一度。検索開始時は、まだページが短くて、結果の先頭まで動けない
}
// 受け取り済みのデータから、指定ページを描画する(サーバーへは問い合わせない)
var BATCH=4, SHOWN=0, RORDER=[], GRPOF=[], MOREIO=null, RAILDRAG=false;
function reduceMotion(){ return !!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
// 受け取り済みのデータを、エリアごとに分け、4件ずつ描画する(写真のAPIも、画面に出したカードの分だけ)
function showPage(n,focus){
  var all=[], gs=[], total=META?META.total:0;
  PAGES.forEach(function(p){ p.forEach(function(it){ all.push(it); }); });
  ITEMS=all; CUR=1; GRPOF=[]; RORDER=[]; SHOWN=0;
  all.forEach(function(it,i){   // 店の最寄りのエリア(先頭の駅)ごとに、近い順のまま分ける
    var a=String(it.area||'').split('、')[0].trim()||'その他', g=null, k;
    for(k=0;k<gs.length;k++){ if(gs[k].name===a){ g=gs[k]; break; } }
    if(!g){ g={name:a,idx:[],id:'grp'+gs.length}; gs.push(g); }
    g.idx.push(i); GRPOF[i]=g;
  });
  gs.forEach(function(g){ g.idx.forEach(function(i){ RORDER.push(i); }); });
  $('count').textContent=total>0?'該当 '+total+' 件(エリアごと・近い順。'+BATCH+'件ずつ表示)':'該当 0 件';
  $('list').innerHTML=all.length?'':'<p class="mut">条件に合う店がありません。時間や予算を広げてみてください。</p>';
  $('pager').innerHTML=''; $('pagerTop').innerHTML=''; $('moreBox').hidden=true;
  buildAreaNav(gs);
  if(MOREIO){ MOREIO.disconnect(); MOREIO=null; }
  if('IntersectionObserver' in window) MOREIO=new IntersectionObserver(function(es){ if(es[0].isIntersecting&&SHOWN<RORDER.length) appendBatch(BATCH); },{root:null,rootMargin:'0px 0px 240px 0px',threshold:0});
  if(all.length) appendBatch(BATCH);
  if(focus) $('count').focus(focus==='search'?{preventScroll:true}:undefined);
}
function groupEl(g){
  var el=$(g.id); if(el) return el;
  el=document.createElement('section'); el.className='grp'; el.id=g.id; el.setAttribute('aria-label',g.name);
  el.innerHTML='<h3 class="gh">'+esc(g.name)+' <small>'+g.idx.length+'件</small></h3>';
  $('list').appendChild(el); if(AIO) AIO.observe(el); if(window.rvObserve&&el.firstChild) rvObserve(el.firstChild,1);
  return el;
}
function appendBatch(n){
  var end=Math.min(SHOWN+n,RORDER.length), j=0, i, it, art;
  for(;SHOWN<end;SHOWN++,j++){
    i=RORDER[SHOWN]; it=ITEMS[i]; art=document.createElement('article');
    art.className='card'+(DEL[it.url]?' stub':''); art.id='c'+i; art.setAttribute('aria-label',it.name); art.style.setProperty('--i',String(j));   // 同じ4件の中で、順に出る
    art.innerHTML=DEL[it.url]?stubInner(it,i):cardInner(it,i);
    groupEl(GRPOF[i]).appendChild(art); if(window.rvObserve) rvObserve(art,1+(j%3));
  }
  if(!PHOTOS_OFF) observePhotos();
  updateMore();
}
function updateMore(){
  var box=$('moreBox'), left=RORDER.length-SHOWN;
  box.hidden=left<=0;
  if(left<=0){ if(MOREIO) MOREIO.unobserve(box); return; }
  $('moreBtn').textContent='さらに'+Math.min(BATCH,left)+'件を表示(残り'+left+'件)'; if(window.popArm) popArm($('moreBtn'));
  if(MOREIO){ MOREIO.unobserve(box); MOREIO.observe(box); } else appendBatch(left);   // IntersectionObserverがない環境は、まとめて出す
}
$('moreBtn').onclick=function(){ var st=SHOWN, a; appendBatch(BATCH); a=document.querySelector('#c'+RORDER[st]+' h4 a'); if(a) a.focus({preventScroll:true}); };
// エリアへ移る: そのエリアの最後の店まで出してから、見出しへ動く(まだ出していない店があっても、飛べる)
function goGroup(g,instant){
  if(!g) return;
  var last=RORDER.indexOf(g.idx[g.idx.length-1]); if(last>=SHOWN) appendBatch(last+1-SHOWN);
  var t=$(g.id); if(t&&t.scrollIntoView) t.scrollIntoView({behavior:(instant||reduceMotion())?'auto':'smooth',block:'start'});
}
// ヘッダーのエリアのナビ: 「保存した店の多いエリア」(AREAS。地域ごとに、店のデータから作られる)を、すべて並べる。
// 結果に出ているエリアが、スクロールの位置に合わせて光る。結果にないエリアは点線で、押すとそのエリアの近くで探す。結果にあって、AREASにないエリアも、後ろに足す
var AIO=null, NAVGS=[], NAVLIST=[], CURG='', NAVHTML=null, NAVRT=null, NAVBOUND=false, NAVBUSY=false;
var WIDEMQ=window.matchMedia?window.matchMedia('(min-width: 768px)'):null;
function selectedArea(){ var v=$('place').value.trim(), i; if(!v) return ''; for(i=0;i<LOCAL.length;i++){ if(LOCAL[i].name===v) return v; } for(i=0;i<AREAS.length;i++){ if(AREAS[i].name===v) return v; } return ''; }   // 入力欄の地名が、エリアの名前と同じなら、選んでいるエリア
function hdrH(){ var t=document.querySelector('.topbar'); return t?Math.ceil(t.getBoundingClientRect().height)+8:150; }
// スマホは、条件の欄が縦に長く、結果が画面の外に出る。検索を始めたら結果の先頭へ、失敗したらメッセージへ動かす(押しても何も起きないように見えないように)
function goToResults(){ if(WIDEMQ&&WIDEMQ.matches) return; var t=$('sec-result'); if(t&&t.scrollIntoView) t.scrollIntoView({behavior:reduceMotion()?'auto':'smooth',block:'start'}); }
function msgShow(){ if(WIDEMQ&&WIDEMQ.matches) return; var m=$('msg'), r=m.getBoundingClientRect(); if(r.top<hdrH()||r.bottom>window.innerHeight) m.scrollIntoView({behavior:reduceMotion()?'auto':'smooth',block:'center'}); }
function navList(){   // ヘッダーのナビは、いま結果に出ている駅(エリア)のグループだけ。スクロールに合わせて光る
  return NAVGS.map(function(g){ return {name:g.name,g:g}; });
}
function renderNav(){
  var nav=$('areanav'), sel=selectedArea(), h='', c, wide=!!(WIDEMQ&&WIDEMQ.matches);
  NAVLIST=navList(); renderRail();
  if(!NAVLIST.length){ nav.hidden=true; nav.innerHTML=''; NAVHTML=null; return; }
  nav.hidden=false;
  NAVLIST.forEach(function(o,i){
    var cur=!!(o.g&&o.g.id===CURG);
    h+='<a href="#'+(o.g?o.g.id:'sec-cond')+'" data-i="'+i+'" class="'+(cur?'is-current ':'')+(o.g?'':'is-empty ')+(o.name===sel?'is-origin':'')+'"'+(cur?' aria-current="true"':'')+(o.g?'':' title="この検索結果にはありません。押すと、このエリアの近くで探します"')+'>'+esc(o.name)+'</a>';
  });
  if(h!==NAVHTML){ nav.innerHTML=h; NAVHTML=h; }
  c=nav.querySelector('.is-current'); if(c&&!wide) nav.scrollLeft=Math.max(0,c.offsetLeft-16);   // 狭い画面は横に滑らせて、見ているエリアを見える位置に
  document.documentElement.style.setProperty('--hdr',hdrH()+'px');
}
$('areanav').onclick=function(ev){
  var a=ev.target.closest?ev.target.closest('a'):null; if(!a) return; ev.preventDefault();
  var o=NAVLIST[Number(a.getAttribute('data-i'))]; if(!o) return;
  var reduce=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if(o.g){ goGroup(o.g); return; }
  if(o.area){ if(o.name===selectedArea()) unpick(); else pickPlace(o.area.name,{lat:o.area.lat,lng:o.area.lng,label:o.area.name}); }
};
// ---- エリアの縦スライダー(WAI-ARIA の slider)。広い画面の右側。ドラッグ・クリック・矢印キー/Home/End で、前後のエリアへ ----
function renderRail(){
  var r=$('areaRail'), n=NAVGS.length, cur=0, k, h='', tk;
  if(!r) return;
  r.hidden=n<2; if(n<2) return;
  NAVGS.forEach(function(g,j){ if(g.id===CURG) cur=j; });
  r.setAttribute('aria-valuemax',String(n)); r.setAttribute('aria-valuenow',String(cur+1)); r.setAttribute('aria-valuetext',NAVGS[cur].name+'('+(cur+1)+'/'+n+')');
  r.style.setProperty('--p',String(cur/(n-1)));
  r.querySelector('.rbubble').textContent=NAVGS[cur].name;
  tk=r.querySelector('.rticks');
  if(tk.getAttribute('data-n')!==String(n)){ for(k=0;k<n;k++) h+='<i style="top:'+(k/(n-1)*100)+'%"></i>'; tk.innerHTML=h; tk.setAttribute('data-n',String(n)); }
}
(function(){
  var r=$('areaRail');
  function idx(){ var i=-1; NAVGS.forEach(function(g,j){ if(g.id===CURG) i=j; }); return i; }
  function to(k,instant){ k=Math.max(0,Math.min(NAVGS.length-1,k)); CURG=NAVGS[k].id; renderNav(); goGroup(NAVGS[k],instant); }
  function pick(y,instant){ var b=r.getBoundingClientRect(), n=NAVGS.length, k; if(n<2) return; k=Math.round((y-b.top)/b.height*(n-1)); k=Math.max(0,Math.min(n-1,k)); if(NAVGS[k].id!==CURG) to(k,instant); }
  r.addEventListener('pointerdown',function(ev){ RAILDRAG=true; try{ r.setPointerCapture(ev.pointerId); }catch(e){} r.focus({preventScroll:true}); pick(ev.clientY,false); });
  r.addEventListener('pointermove',function(ev){ if(RAILDRAG) pick(ev.clientY,true); });
  function end(){ RAILDRAG=false; }
  r.addEventListener('pointerup',end); r.addEventListener('pointercancel',end);
  r.addEventListener('keydown',function(ev){
    var n=NAVGS.length, i=idx(), d={ArrowUp:-1,ArrowLeft:-1,PageUp:-1,ArrowDown:1,ArrowRight:1,PageDown:1}[ev.key], k;
    if(n<2) return;
    if(ev.key==='Home') k=0; else if(ev.key==='End') k=n-1; else if(d) k=i+d; else return;
    ev.preventDefault(); to(k);
  });
})();
// ---- トップへ戻るボタン: 先頭の見張り(IntersectionObserver)が画面から外れたら、ふわっと出る。スクロール量は --prog(0〜1)として、リングと結晶に渡す ----
(function(){
  var btn=$('toTop'), root=document.documentElement, busy=false, sent=$('topSent');
  function prog(){ busy=false; var m=Math.max(1,root.scrollHeight-window.innerHeight); root.style.setProperty('--prog',Math.min(1,Math.max(0,(window.pageYOffset||0)/m)).toFixed(3)); }
  window.addEventListener('scroll',function(){ if(!busy){ busy=true; requestAnimationFrame(prog); } },{passive:true});
  window.addEventListener('resize',prog);
  if('IntersectionObserver' in window&&sent) new IntersectionObserver(function(es){ btn.classList.toggle('is-show',!es[0].isIntersecting); },{threshold:0}).observe(sent);
  else window.addEventListener('scroll',function(){ btn.classList.toggle('is-show',(window.pageYOffset||0)>400); },{passive:true});
  btn.onclick=function(){ btn.classList.remove('is-click'); void btn.offsetWidth; btn.classList.add('is-click'); setTimeout(function(){ btn.classList.remove('is-click'); },650); window.scrollTo({top:0,behavior:reduceMotion()?'auto':'smooth'}); var h=document.querySelector('.topbar h1'); if(h) h.focus({preventScroll:true}); };
  prog();
})();
function buildAreaNav(gs){
  var vh=window.innerHeight||800, hh=hdrH(), mid=Math.max(0,Math.round(hh+(vh-hh)/2-20)), bot=Math.max(0,Math.round((vh-hh)/2-20));
  if(AIO){ AIO.disconnect(); AIO=null; }
  gs.forEach(function(g,gi){ g.id='grp'+gi; });
  NAVGS=gs; CURG=''; NAVHTML=null;
  if(!NAVBOUND){
    NAVBOUND=true;
    window.addEventListener('resize',function(){ clearTimeout(NAVRT); NAVRT=setTimeout(function(){ buildAreaNav(NAVGS); },200); });   // 画面の幅や高さが変わったら、判定の位置を作り直す
    window.addEventListener('scroll',function(){   // いちばん下まで来たら、最後のエリアにする(真ん中まで届かないため)
      if(NAVBUSY||!NAVGS.length) return; NAVBUSY=true;
      requestAnimationFrame(function(){ NAVBUSY=false; if(SHOWN<RORDER.length) return; var last=NAVGS[NAVGS.length-1].id; if((window.innerHeight+(window.pageYOffset||0))>=document.documentElement.scrollHeight-4&&CURG!==last){ CURG=last; renderNav(); } });
    },{passive:true});
  }
  renderNav();
  if(!gs.length||!('IntersectionObserver' in window)) return;
  AIO=new IntersectionObserver(function(es){ if(RAILDRAG) return; es.forEach(function(e){ if(e.isIntersecting) CURG=e.target.id; else if(e.target.id===CURG&&e.boundingClientRect.top>0){ var k=0; NAVGS.forEach(function(g,j){ if(g.id===CURG) k=j; }); CURG=k>0?NAVGS[k-1].id:''; } }); renderNav(); },{root:null,rootMargin:'-'+mid+'px 0px -'+bot+'px 0px',threshold:0});   // ヘッダーの下の、見える範囲の真ん中にあるエリア
  document.querySelectorAll('#list .grp').forEach(function(el){ AIO.observe(el); });
}
// ページ番号は常に最大3つ(現在のページを中心に。先頭・末尾では寄せる)。スマホでも同じ並び
function pageList(page,pages){
  var n=Math.min(3,pages), s=Math.min(Math.max(1,page-1),pages-n+1), a=[], i;
  for(i=0;i<n;i++) a.push(s+i);
  return a;
}
// 3ページ以上: 最初 前へ [番号3つ] 次へ 最後 / 2ページ以下: 前へ [番号] 次へ。押せないボタンも残す(並びが動かないように)
function renderPager(page,pages,total){
  if(!(total>0)){ $('pager').innerHTML=''; $('pagerTop').innerHTML=''; return; }
  var wide=pages>=3;
  function btn(label,p,aria,off){
    return '<li class="button"><button type="button" data-page="'+p+'" aria-label="'+aria+'"'+(off?' disabled':'')+'>'+label+'</button></li>';
  }
  var h='<ul class="pagination" role="list">';
  if(wide) h+=btn('最初',1,'最初のページ',page<=1);
  h+=btn('前へ',page-1,'前のページ',page<=1);
  pageList(page,pages).forEach(function(n){
    if(n===page) h+='<li class="cur"><span aria-current="page" aria-label="'+n+'ページ目(現在のページ)">'+n+'</span></li>';
    else h+='<li class="num"><button type="button" data-page="'+n+'" aria-label="'+n+'ページ目へ">'+n+'</button></li>';
  });
  h+=btn('次へ',page+1,'次のページ',page>=pages);
  if(wide) h+=btn('最後',pages,'最後のページ('+pages+'ページ目)',page>=pages);
  $('pager').innerHTML=h+'</ul>'; $('pagerTop').innerHTML=$('pager').innerHTML;
}
function onPage(ev){
  var b=ev.target.closest?ev.target.closest('button[data-page]'):null; if(!b||b.disabled||!ORIGIN) return;
  // ページを移っても、画面の位置は動かさない(下のページ送りを押したら、そのまま下のページ送りを押せる位置に残す)
  var box=ev.currentTarget, lis=box.querySelectorAll('li'), idx=-1, k;
  for(k=0;k<lis.length;k++){ if(lis[k].contains(b)){ idx=k; break; } }
  var before=box.getBoundingClientRect().top;
  showPage(Number(b.getAttribute('data-page')));
  var after=box.getBoundingClientRect().top;
  if(after!==before) window.scrollBy(0,after-before);
  var nl=box.querySelectorAll('li'), nb=idx>=0&&nl[idx]?nl[idx].querySelector('button:not([disabled])'):null;
  if(nb) nb.focus({preventScroll:true}); else $('count').focus({preventScroll:true});   // 同じ位置のボタンに、フォーカスも残す
}
$('pager').onclick=onPage; $('pagerTop').onclick=onPage;
$('list').onclick=function(ev){
  var b=ev.target.closest?ev.target.closest('button[data-act]'):null; if(!b) return;
  var i=Number(b.getAttribute('data-i')), act=b.getAttribute('data-act');
  var it=ITEMS[i], card=$('c'+i); if(!it||!card) return;
  b.disabled=true;
  if(act==='del'){
    google.script.run.withSuccessHandler(function(){
      DEL[it.url]=1; card.className='card stub'; card.innerHTML=stubInner(it,i);
      card.querySelector('button').focus();
    }).withFailureHandler(function(e){b.disabled=false;$('msg').textContent='削除に失敗しました: '+errText(e);})
    .hideShop({url:it.url,name:it.name,k:K});
  }else if(act==='undo'){
    google.script.run.withSuccessHandler(function(){
      delete DEL[it.url]; card.className='card'; card.innerHTML=cardInner(it,i); loadPhotos(i); card.querySelector('h4 a').focus();
    }).withFailureHandler(function(e){b.disabled=false;$('msg').textContent='戻せませんでした: '+errText(e);})
    .unhideShop({url:it.url,k:K});
  }
};
function renderHidden(){
  var h='';
  HID.forEach(function(s,i){
    h+='<div class="card" id="h'+i+'"><p>'+esc(s.name)+'</p><div class="acts">'
      +'<a href="'+esc(safeUrl(s.url))+'" target="_blank" rel="noopener noreferrer">食べログで開く<span class="sr-only">: '+esc(s.name)+'(新しいタブで開く)</span></a>'
      +'<button class="sub" data-act="restore" data-i="'+i+'" aria-label="'+esc(s.name)+'を元に戻す">戻す</button></div></div>';
  });
  $('hidden').innerHTML=h||'<p class="mut">削除した店はありません。</p>';
}
$('showhidden').onclick=function(){
  if($('hidden').innerHTML){$('hidden').innerHTML='';$('showhidden').setAttribute('aria-label','削除した店を見る');$('showhidden').setAttribute('aria-expanded','false');return;}
  $('hidden').innerHTML='<p class="mut">読み込み中...</p>';
  google.script.run.withSuccessHandler(function(a){HID=a||[];renderHidden();$('showhidden').setAttribute('aria-label','削除した店を閉じる');$('showhidden').setAttribute('aria-expanded','true');})
    .withFailureHandler(function(e){$('hidden').innerHTML='<p class="mut">エラー: '+esc(errText(e))+'</p>';})
    .listHidden({k:K});
};
$('hidden').onclick=function(ev){
  var b=ev.target.closest?ev.target.closest('button[data-act="restore"]'):null; if(!b) return;
  var i=Number(b.getAttribute('data-i')), s=HID[i], card=$('h'+i); if(!s||!card) return;
  b.disabled=true;
  google.script.run.withSuccessHandler(function(){
    card.className='card stub'; card.innerHTML='<p>「'+esc(s.name)+'」を戻しました(次回の検索から表示されます)</p>'; card.setAttribute('tabindex','-1'); card.focus();
  }).withFailureHandler(function(e){b.disabled=false;$('msg').textContent='戻せませんでした: '+errText(e);})
  .unhideShop({url:s.url,k:K});
};
// 現在地: 速い方式(Wi-Fi・基地局)で先に探し、取れなければGPSで。経過と失敗の理由は、ボタンのすぐ下に出す
function autoStart(){   // 「近くに店あるかな、今から行こうかな」: 開いたら、押さなくても、近くの店が出る
  if(SEARCHED||$('here').disabled) return;   // もう探し始めている(Slackのリンクなど)ときは、しない
  geoProbe(function(){
    if(GEOB){ geoGranted(function(g){ if(g&&!SEARCHED&&!$('here').disabled) $('here').click(); }); return; }   // 外のページに、許可済みか聞く
    try{
      if(navigator.permissions&&navigator.permissions.query&&navigator.geolocation) navigator.permissions.query({name:'geolocation'}).then(function(st){
        if(st.state==='granted'&&!SEARCHED&&!$('here').disabled) $('here').click();
      },function(){});
    }catch(e){}
  });
}
/* ---- 現在地の取得: 入れ子の画面(GitHub Pages → GAS → この画面)では、ブラウザが位置情報を止めることがある(特にスマホ)。
   いちばん外のページ(index.html)が位置を取って渡してくれるときは、そちらを使う。なければ、この画面で直接取る ---- */
var GEOB=null;   // null=未確認 / true=外のページが取ってくれる / false=この画面で直接取る
function geoProbe(cb){
  if(GEOB!==null){ cb(); return; }
  if(window.top===window){ GEOB=false; cb(); return; }
  var id='h'+Date.now()+Math.random().toString(36).slice(2,6), fin=false, t=null;
  function on(ev){ var d=ev.data; if(d&&d.type==='tabelog-geo-ack'&&d.id===id){ GEOB=true; end(); } }
  function end(){ if(fin) return; fin=true; window.removeEventListener('message',on); clearTimeout(t); if(GEOB===null) GEOB=false; cb(); }
  window.addEventListener('message',on); t=setTimeout(end,1200);
  try{ window.top.postMessage({type:'tabelog-geo-hello',id:id},'*'); }catch(e){ end(); }
}
function getPos(ok,err,o){   // navigator.geolocation.getCurrentPosition と同じ形で呼べる
  geoProbe(function(){
    if(GEOB){
      var id='g'+Date.now()+Math.random().toString(36).slice(2,6), tmo=(o&&o.timeout)||15000, hi=!!(o&&o.enableHighAccuracy), t=null;
      function on(ev){ var d=ev.data; if(!d||d.type!=='tabelog-geo-result'||d.id!==id) return; clearTimeout(t); window.removeEventListener('message',on); if(d.ok) ok({coords:{latitude:d.lat,longitude:d.lng,accuracy:d.acc}}); else err({code:d.code||2}); }
      window.addEventListener('message',on);
      t=setTimeout(function(){ window.removeEventListener('message',on); err({code:3}); },tmo+3000);
      try{ window.top.postMessage({type:'tabelog-geo',id:id,o:{timeout:tmo,maximumAge:(o&&o.maximumAge)||0,enableHighAccuracy:hi}},'*'); }catch(e){ clearTimeout(t); window.removeEventListener('message',on); err({code:2}); }
      return;
    }
    if(!navigator.geolocation){ err({code:2}); return; }
    navigator.geolocation.getCurrentPosition(ok,err,o);
  });
}
geoProbe(function(){});   // 画面を開いたときに先に確かめておく(押したときの待ちをなくす)
function geoGranted(cb){   // 外のページ(index.html)に、位置情報が許可済みかを聞く(許可の確認は出ない)
  var id='p'+Date.now()+Math.random().toString(36).slice(2,6), t=null;
  function on(ev){ var d=ev.data; if(!d||d.type!=='tabelog-geo-perm-result'||d.id!==id) return; clearTimeout(t); window.removeEventListener('message',on); cb(!!d.granted); }
  window.addEventListener('message',on); t=setTimeout(function(){ window.removeEventListener('message',on); cb(false); },1500);
  try{ window.top.postMessage({type:'tabelog-geo-perm',id:id},'*'); }catch(e){ clearTimeout(t); window.removeEventListener('message',on); cb(false); }
}
function hereBusy(on){ var b=$('here'); b.disabled=!!on; b.innerHTML=on?'<span aria-hidden="true">⏳</span> 取得中…':'<span aria-hidden="true">📍</span> 現在地'; }
function hereErr(c){
  if(c===1) return '位置情報が許可されていません。iPhoneは「設定 › プライバシーとセキュリティ › 位置情報サービス › Safari」を「このAppの使用中」にして、ページを開き直してください。許可できないときは、「エリアから選ぶ」か地名で探せます。';
  if(c===2) return '現在地を特定できませんでした。電波のよい場所でもう一度押すか、エリア・地名で探してください。';
  return '時間内に現在地を取得できませんでした。もう一度押すか、エリア・地名で探してください。';
}
$('here').onclick=function(){
  PEND=null;
  hereBusy(true); orgSay('現在地を取得中…(許可を聞かれたら「許可」を押してください)');
  function ok(p){ hereBusy(false); orgSay(''); HOME={lat:p.coords.latitude,lng:p.coords.longitude}; loadLocal(); go({lat:p.coords.latitude,lng:p.coords.longitude},true); }
  function ng(e){ hereBusy(false); orgSay(hereErr(e.code)); }
  getPos(ok,function(e){
    if(e.code===1){ ng(e); return; }   // 許可されていない: やり直しても同じ
    getPos(ok,ng,{enableHighAccuracy:true,timeout:15000,maximumAge:0});
  },{enableHighAccuracy:false,timeout:8000,maximumAge:300000});
};
var FROM_NAME=false;   // 地名での検索のあと、結果の見出しにフォーカスを移すための目印
$('byname').onclick=function(){
  var v=$('place').value.trim();
  if(!v){$('msg').textContent='地名を入れてください';orgSay('地名を入れてください');msgShow();return;}
  $('place').blur();   // 入力が確定したら、入力欄のカーソルの点滅を止める(スマホのキーボードも閉じる)
  FROM_NAME=true; PEND=null;
  go({place:v});
};
function photoHtml(it,ph){
  if(!ph||!ph.length) return '';
  var h='<div class="ph-region" role="region" tabindex="0" aria-label="'+esc(it.name)+'の写真('+ph.length+'枚)"><ul class="ph-strip" role="list">';
  ph.forEach(function(p,n){
    h+='<li><figure style="margin:0"><img src="'+esc(safeImg(p.src))+'" alt="'+esc(it.name)+'の写真 '+(n+1)+'/'+ph.length+'" width="300" height="225" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
      +'<figcaption class="ph-by">写真: '+(p.byUrl?'<a href="'+esc(safeUrl(p.byUrl))+'" target="_blank" rel="noopener noreferrer">'+esc(p.by||'投稿者')+'</a>':esc(p.by||'投稿者'))+'(Googleマップ)</figcaption></figure></li>';
  });
  return h+'</ul></div>';
}
function loadPhotos(i){
  var it=ITEMS[i], box=document.querySelector('#c'+i+' .photos'); if(!it||!box||PHOTOS_OFF) return;
  if(PH[it.url]!==undefined){ box.innerHTML=photoHtml(it,PH[it.url]); return; }
  box.setAttribute('aria-busy','true');
  function done(list,why){
    PH[it.url]=list||[]; var b=document.querySelector('#c'+i+' .photos');
    if(b&&ITEMS[i]===it){ b.removeAttribute('aria-busy'); b.innerHTML=photoHtml(it,PH[it.url])||(why?'<p class="ph-by">写真なし: '+esc(why)+'</p>':''); }   // 取得中にページを移っていたら、別の店の欄には書かない
  }
  google.script.run.withSuccessHandler(function(r){ if(r&&r.off) PHOTOS_OFF=true; done(r&&r.photos,r&&r.why); })
    .withFailureHandler(function(e){
      var b=document.querySelector('#c'+i+' .photos');   // 失敗は覚えない(次に表示したとき、もう一度取りに行く)
      if(b&&ITEMS[i]===it){ b.removeAttribute('aria-busy'); b.innerHTML='<p class="ph-by">写真を取得できませんでした: '+esc(errText(e))+'</p>'; }
    })
    .getShopPhotos({url:it.url,k:K});
}
function observePhotos(){
  if(IO){IO.disconnect();IO=null;}
  var els=document.querySelectorAll('#list .photos');
  if(!('IntersectionObserver' in window)){ for(var n=0;n<els.length;n++) loadPhotos(Number(els[n].getAttribute('data-i'))); return; }
  IO=new IntersectionObserver(function(es){
    es.forEach(function(en){ if(en.isIntersecting){ IO.unobserve(en.target); loadPhotos(Number(en.target.getAttribute('data-i'))); } });
  },{rootMargin:'200px'});
  for(var m=0;m<els.length;m++) IO.observe(els[m]);
}
function buildChips(opts){
  var h='';
  opts.forEach(function(o){
    h+='<label class="chip"><input type="checkbox" class="taste" value="'+esc(o.name)+'"'+(!SAVED_TASTES.length||SAVED_TASTES.indexOf(o.name)>=0?' checked':'')+'><span>'+esc(o.name)
      +(o.count!=null?'<small>'+esc(String(o.count))+'件</small>':'')+'</span></label>';
  });
  $('chips').innerHTML=h; $('chips').removeAttribute('aria-busy');
}
var AREAS=[];
function buildAreas(list){   // 候補は、スプレッドシートの「エリア(駅)」から作ったもの(サーバー側 getAreaOptions)。タグは並べず、ボタンの中の一覧に入れる
  AREAS=list||[];
  $('areaBox').hidden=!(AREAS.length||LOCAL.length);
  renderAreaChips(); markSel($('place').value);
}
// テイストを選んで2秒、ほかに操作がなければ、現在地で自動検索する(選択の途中で動かないよう、操作のたびに待ち直す)
var AUTO=null;
function cancelAuto(){ if(AUTO){ clearTimeout(AUTO); AUTO=null; } }
var PEND=null;   // タグで選んだ起点(2秒後の検索に使う)
function armAuto(){
  cancelAuto();
  AUTO=setTimeout(function(){
    AUTO=null;
    var t=$('place').value.trim();   // 入力欄の地名を優先(直前の起点と同じなら、そのまま使う)。空なら現在地
    var o=PEND||(t?((LAST&&(LAST.place||LAST.label||'')===t)?LAST:{place:t}):null);
    PEND=null;
    if(o) go(o); else $('here').click();
  },2000);
}
function orgSay(t){ var m=$('orgMsg'); if(m) m.textContent=t||''; }   // 条件の欄のすぐ下に出す。結果の欄は、スマホだと画面の外になるため
function changed(){ armAuto(); var t='条件を変えました。2秒そのままなら、検索します'; $('msg').textContent=t; orgSay(t); }   // 条件を変える操作は、すべてここを通す

// ---- 地名のタグ(保存したエリア / 最近の地名)----
function markSel(name){   // 入力欄と同じ名前のタグに、色をつける
  name=String(name||'').trim();
  document.querySelectorAll('button.area').forEach(function(b){
    b.setAttribute('aria-pressed',(name&&b.getAttribute('data-name')===name)?'true':'false');
  });
  renderNav();   // 押してあるエリアが変わったら、ヘッダーのナビも変える
  areaToggleLabel();
}
function unpick(){   // 選んだ地名のタグを、もう一度押したとき: 色・入力欄・検索条件(起点)をすべて外す。検索はしない
  cancelAuto(); PEND=null; LAST=null; $('place').value=''; markSel(''); areasOpen(false);
  $('msg').textContent='選択を外しました。次の検索は、現在地(または入力した地名)で行います'; orgSay('選択を外しました。次の検索は、現在地(または入力した地名)で行います');
}
function pickPlace(name,origin){   // タグを選ぶ: 入力欄に入れて、色をつけ、2秒待って検索する
  PEND=origin; FROM_NAME=true; $('place').value=name; markSel(name); areasOpen(false); changed(); orgSay('「'+name+'」を選びました。2秒後に探します(もう一度押すと取り消し)');
}
var HKEY='gohan_places', HMAX=8, HIST=[];
function okPlace(v){   // 履歴に残してよい入力か(空・長すぎる・制御文字・タグに使う記号を除く)
  if(typeof v!=='string') return false; v=v.trim();
  if(v.length<1||v.length>30) return false;
  for(var i=0;i<v.length;i++){ if(v.charCodeAt(i)<32) return false; }
  return !/[<>"&]/.test(v);
}
function histLoad(){ try{ var a=JSON.parse(localStorage.getItem(HKEY)||'[]'); HIST=(Array.isArray(a)?a:[]).filter(okPlace).slice(0,HMAX); }catch(e){ HIST=[]; } }
function histSave(){ try{ localStorage.setItem(HKEY,JSON.stringify(HIST)); }catch(e){} }
function buildHist(){
  var h='';
  HIST.forEach(function(p,i){
    h+='<button type="button" class="area hist" data-i="'+i+'" data-name="'+esc(p)+'" aria-pressed="false">'+esc(p)+'</button>';
  });
  $('hist').innerHTML=h; $('histBox').hidden=!HIST.length; markSel($('place').value);
}
function histAdd(v){ v=v.trim(); HIST=HIST.filter(function(x){return x!==v;}); HIST.unshift(v); HIST=HIST.slice(0,HMAX); histSave(); buildHist(); }
function afterSuccess(){   // 検索に成功するたびに、入力欄と履歴を更新する
  var o=LAST;
  if(!o){ $('place').value=''; markSel(''); return; }   // 現在地での検索: 入力欄は空にする
  var name=o.place||o.label||'';
  $('place').value=name; markSel(name);
  if(o.place&&okPlace(o.place)) histAdd(o.place);   // 地名で検索できたものだけ、新しい順に履歴へ
}
$('hist').onclick=function(ev){
  var b=ev.target.closest?ev.target.closest('button.hist'):null; if(!b) return;
  if(b.getAttribute('aria-pressed')==='true'){ unpick(); return; }
  var p=HIST[Number(b.getAttribute('data-i'))]; if(!p) return;
  pickPlace(p,{place:p});
};
$('histClear').onclick=function(){ HIST=[]; histSave(); buildHist(); $('msg').textContent='最近の地名の履歴を消しました'; };
$('chips').onchange=function(ev){ var t=ev.target; if(t&&t.classList&&t.classList.contains('taste')) changed(); };
$('clearTaste').onclick=function(){ document.querySelectorAll('.taste').forEach(function(e){ e.checked=false; }); changed(); };
['mode','minutes','budget'].forEach(function(id){ $(id).addEventListener('change',changed); });   // 移動手段・分数・予算: 変えて2秒操作がなければ検索
$('place').addEventListener('input',function(){ cancelAuto(); PEND=null; markSel($('place').value); });   // 地名を入力し始めたら、待機中の自動検索は取り消す
$('place').addEventListener('keydown',function(ev){
  if(ev.key!=='Enter'||ev.isComposing||ev.keyCode===229) return;   // 日本語の変換を確定するEnterでは、検索しない
  ev.preventDefault(); $('byname').click();                       // 変換が終わったあとのEnterで、地名で検索する
});
/* ---- エリア切替: ボタンを押すと、すりガラスの一覧が開く(WAI-ARIA の listbox)。矢印キー・Home/End・Enter・Escで操作。スマホは下から出る ---- */
var AACT=-1, HOME=null, AFAR=false, NEAR_KM=5, LOCAL=[], LOCALKEY='', LOCALREADY=false, ALIST=[];   // HOME=現在地(取れたもの)。エリアの近い/遠いは、いまの検索の起点(なければ現在地)から測る
function basePt(){ return HOME||ORIGIN; }   // 基準は、現在地(なければ検索の起点)。エリアを選んで起点が変わっても、タグは入れ替えない
function kmTo(a){   // 起点からの距離(km)。起点が分からなければ -1
  var b=basePt();
  if(!b||!isFinite(a.lat)||!isFinite(a.lng)) return -1;
  var t=Math.PI/180, dLa=(a.lat-b.lat)*t, dLo=(a.lng-b.lng)*t;
  var x=Math.sin(dLa/2)*Math.sin(dLa/2)+Math.cos(b.lat*t)*Math.cos(a.lat*t)*Math.sin(dLo/2)*Math.sin(dLo/2);
  return 12742*Math.asin(Math.sqrt(x));
}
function kmText(d){ return d<10?d.toFixed(1)+'km':Math.round(d)+'km'; }
function areaToggleLabel(){   // 近くのタグにないエリア(遠い地域)を選んでいるときだけ、ボタンに名前を出す
  var s=selectedArea(), t=$('areaSel'), inLocal=false, i;
  if(!t) return;
  for(i=0;i<LOCAL.length;i++){ if(LOCAL[i].name===s) inLocal=true; }
  t.textContent=(s&&!inLocal)?('エリア: '+s):'他の地域';
}
function renderAreaChips(){   // いまの場所(ブラウザの位置情報)の周りの店から自動で作ったエリアを、タグで出す。福岡なら福岡、大阪なら大阪
  var c=$('areaChips'), hint=$('areaHint'), b=basePt(), cur=selectedArea(), h='';
  if(!c) return;
  if(b&&LOCALREADY){
    LOCAL.forEach(function(a,i){ h+='<button type="button" class="area" data-name="'+esc(a.name)+'" data-i="'+i+'" aria-pressed="'+(a.name===cur?'true':'false')+'">'+esc(a.name)+'<small>'+esc(String(a.count))+'件</small></button>'; });
    if(!LOCAL.length) h='<span class="mut">いまの場所の近くに、保存した店のあるエリアはありません</span>';
  } else if(b) h='<span class="mut">近くのエリアを調べています…</span>';
  c.innerHTML=h; hint.hidden=!!b;
}
function loadLocal(){   // いまの場所(現在地。なければ検索の起点)の周りの店から、エリアを作ってもらう。5kmほど動くまでは、取り直さない
  var b=basePt(); if(!b) return;
  var key=(Math.round(b.lat*20)/20)+','+(Math.round(b.lng*20)/20);
  if(key===LOCALKEY) return;
  LOCALKEY=key; LOCALREADY=false; renderAreaChips();
  google.script.run.withSuccessHandler(function(r){
    if(LOCALKEY!==key) return;   // 取得中に、場所が変わっていたら捨てる
    LOCAL=(r&&r.options)||[];
    if(!(r&&r.local)) LOCAL=LOCAL.filter(function(x){ var d=kmTo(x); return d>=0&&d<=NEAR_KM; });   // サーバーが古く、全国の一覧が返ってきたときも、近いものだけを入れる
    LOCALREADY=true;
    $('areaBox').hidden=!(AREAS.length||LOCAL.length);
    areaToggleLabel(); renderAreaChips();
    if($('areaToggle').getAttribute('aria-expanded')==='true') areaBuild();
  }).withFailureHandler(function(){ if(LOCALKEY===key) LOCALKEY=''; }).getAreaOptions({k:K,lat:b.lat,lng:b.lng});
}
function areaBuild(){   // 一覧(ボタンの中)は、近くのタグに出ていない、遠い地域のエリア。近い順
  var cur=selectedArea(), b=basePt(), far=[], h='', seen={};
  ALIST=[];
  function note(t){ return '<li class="note" role="presentation">'+t+'</li>'; }
  function row(a){
    var d=kmTo(a), i=ALIST.length; ALIST.push(a);
    return '<li id="ao'+i+'" role="option" data-i="'+i+'" aria-selected="'+(a.name===cur?'true':'false')+'"><span class="an">'+esc(a.name)+'</span><span class="as">保存した店 '+esc(String(a.count))+'軒'+(d>=0?' · 約'+kmText(d):'')+'</span><span class="ak" aria-hidden="true"></span></li>';
  }
  h+='<li id="ao-here" role="option" data-act="here" aria-selected="false"><span class="an">📍 現在地</span><span class="as">'+(b?'いまの場所の近くを探す':'位置情報で、いまの場所の近くを探す')+'</span><span class="ak" aria-hidden="true"></span></li>';
  if(b&&LOCALREADY) LOCAL.forEach(function(a){ seen[a.name]=1; });
  AREAS.forEach(function(a){ var d=kmTo(a); if(!seen[a.name]&&(!b||d<0||d>NEAR_KM)) far.push({a:a,d:d}); });
  if(b) far.sort(function(x,y){ return x.d-y.d; });
  far.forEach(function(o){ h+=row(o.a); });
  if(!far.length) h+=note('ほかの地域のエリアは、ありません');
  $('areaList').innerHTML=h;
}
function areaAct(k){
  var items=$('areaList').querySelectorAll('li[role="option"]'); if(!items.length) return;
  AACT=Math.max(0,Math.min(items.length-1,k));
  [].forEach.call(items,function(li,j){ li.classList.toggle('is-active',j===AACT); });
  $('areaList').setAttribute('aria-activedescendant',items[AACT].id);
  if(items[AACT].scrollIntoView) items[AACT].scrollIntoView({block:'nearest'});
}
function areasOpen(on){
  var l=$('areaList'), b=$('areaToggle'); if(!l||!b) return;
  if(on&&!AREAS.length) return;
  if(on){ loadLocal(); areaBuild(); }
  if(!on) AFAR=false;   // 閉じたら、「他の地域」は畳んだ状態に戻す
  l.hidden=!on; $('areaScrim').hidden=!on; b.setAttribute('aria-expanded',on?'true':'false');
  if(on){ var its=l.querySelectorAll('li[role="option"]'), k=0, j; for(j=0;j<its.length;j++){ if(its[j].getAttribute('aria-selected')==='true'){ k=j; break; } } areaAct(k); l.focus({preventScroll:true}); }
}
function areaSelect(a){   // 選んだら、すぐ探す(選んでいるエリアをもう一度選ぶと、取り消す)
  if(!a) return;
  areasOpen(false);
  if(a.name===selectedArea()){ unpick(); return; }
  cancelAuto(); PEND=null; FROM_NAME=true; $('place').value=a.name; markSel(a.name);
  go({lat:a.lat,lng:a.lng,label:a.name});
}
function areaPick(i){ areaSelect(ALIST[i]); }
function areaGo(li){   // 一覧の1行を選んだとき(エリア / 現在地 / 他の地域の開け閉め)
  if(!li) return;
  var act=li.getAttribute('data-act');
  if(act==='here'){ areasOpen(false); cancelAuto(); PEND=null; $('place').value=''; markSel(''); $('here').click(); return; }
  if(act==='far'){ AFAR=!AFAR; areaBuild(); var its=$('areaList').querySelectorAll('li[role="option"]'), j; for(j=0;j<its.length;j++){ if(its[j].id==='ao-far'){ areaAct(j); break; } } return; }
  areaPick(Number(li.getAttribute('data-i')));
}
$('areaChips').onclick=function(ev){ var bt=ev.target.closest?ev.target.closest('button.area'):null; if(bt) areaSelect(LOCAL[Number(bt.getAttribute('data-i'))]); };
$('areaToggle').onclick=function(){ areasOpen($('areaToggle').getAttribute('aria-expanded')!=='true'); };
$('areaScrim').onclick=function(){ areasOpen(false); $('areaToggle').focus(); };
$('areaList').onclick=function(ev){ var li=ev.target.closest?ev.target.closest('li[role="option"]'):null; if(li) areaGo(li); };
$('areaList').addEventListener('keydown',function(ev){
  var k=ev.key;
  if(k==='ArrowDown'){ ev.preventDefault(); areaAct(AACT+1); }
  else if(k==='ArrowUp'){ ev.preventDefault(); areaAct(AACT-1); }
  else if(k==='Home'){ ev.preventDefault(); areaAct(0); }
  else if(k==='End'){ ev.preventDefault(); areaAct(9999); }
  else if(k==='Enter'||k===' '){ ev.preventDefault(); areaGo($('areaList').querySelectorAll('li[role="option"]')[AACT]); }
  else if(k==='Escape'){ ev.preventDefault(); areasOpen(false); $('areaToggle').focus(); }
  else if(k==='Tab'){ areasOpen(false); }
});
geoProbe(function(){   // 位置情報が許可済みなら、開いた時点で現在地を取る(許可の確認は出さない)。エリアの一覧を、いまの場所の近くだけにするため
  function take(){ getPos(function(p){ HOME={lat:p.coords.latitude,lng:p.coords.longitude}; loadLocal(); },function(){},{enableHighAccuracy:false,timeout:8000,maximumAge:600000}); }
  if(GEOB){ geoGranted(function(g){ if(g) take(); }); return; }
  try{
    if(navigator.permissions&&navigator.permissions.query&&navigator.geolocation) navigator.permissions.query({name:'geolocation'}).then(function(st){ if(st.state==='granted') take(); },function(){});
  }catch(e){}
});
document.addEventListener('pointerdown',function(ev){ var b=$('areaBox'); if($('areaToggle').getAttribute('aria-expanded')==='true'&&b&&!b.contains(ev.target)) areasOpen(false); });
/* ---- ゴミ箱(ヘッダー): 押すと、削除した店の一覧を開く ---- */
(function(){ var a=document.querySelector('.topnav a.trash'); if(a) a.addEventListener('click',function(){ if(!$('hidden').innerHTML) $('showhidden').click(); }); })();
/* ---- スクロールの登場(IntersectionObserver)。transform と opacity だけ動かす ---- */
(function(){
  var root=document.documentElement;
  if(!('IntersectionObserver' in window)||reduceMotion()){ root.classList.add('no-rv'); window.rvObserve=function(){}; window.popArm=function(){}; window.popGo=function(){}; document.querySelectorAll('.pushy').forEach(function(b){ b.classList.add('popped'); }); return; }
  var th=[], i; for(i=0;i<=20;i++) th.push(i/20);
  // 画面に入る割合(0〜1)を、そのまま「浮かび具合」に使う。深さ(1〜3)が大きいほど、大きく動く。下から入るときは下から、上から入るときは上から
  var rv=new IntersectionObserver(function(es){
    es.forEach(function(e){
      var t=e.target; if(t.classList.contains('rv-done')) return;
      var r=e.intersectionRatio, up=e.boundingClientRect.top<0, d=Number(t.getAttribute('data-rv'))||1, s=up?-1:1;
      if(r>=.92||(up&&!e.isIntersecting)){ t.classList.add('rv-done'); t.style.removeProperty('--ry'); t.style.removeProperty('--ro'); rv.unobserve(t); return; }
      t.style.setProperty('--ry',(s*(1-r)*22*d).toFixed(1));
      t.style.setProperty('--ro',Math.min(1,r*1.5).toFixed(2));
    });
  },{root:null,rootMargin:'0px 0px -4% 0px',threshold:th});
  window.rvObserve=function(el,d){ if(!el||el.classList.contains('rv')) return; el.setAttribute('data-rv',String(d||1)); el.classList.add('rv'); rv.observe(el); };
  // 押したくなるボタン: 画面に入ったら、ぽんと跳ねて出る(読み込み画面が閉じたあとから始める)
  var pio=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ pio.unobserve(e.target); e.target.classList.add('pop'); } }); },{threshold:.4});
  document.addEventListener('animationend',function(ev){ var t=ev.target; if(ev.animationName==='popin'&&t.classList&&t.classList.contains('pop')){ t.classList.remove('pop'); t.classList.add('popped'); } },true);
  window.popArm=function(el){ if(!el) return; el.classList.remove('pop','popped'); if(root.classList.contains('is-ready')) pio.observe(el); };
  window.popGo=function(){ document.querySelectorAll('.pushy:not(.popped)').forEach(function(b){ pio.observe(b); }); };
  setTimeout(function(){ document.querySelectorAll('.pushy:not(.pop):not(.popped)').forEach(function(b){ b.classList.add('popped'); }); },6000);   // 万一、跳ねる処理が動かなくても、ボタンは必ず見える
})();
restore();
histLoad(); buildHist();
google.script.run.withSuccessHandler(function(r){ loadDone(); buildChips((r&&r.options&&r.options.length)?r.options:DEFAULT_TASTES); })
  .withFailureHandler(function(){ loadDone(); buildChips(DEFAULT_TASTES); }).getTasteOptions({k:K});
google.script.run.withSuccessHandler(function(r){ loadDone(); buildAreas(r&&r.options); })
  .withFailureHandler(function(e){ loadDone(); buildAreas([]); $('msg').textContent='エリアの一覧を取得できませんでした: '+errText(e); orgSay('エリアの一覧を取得できませんでした: '+errText(e)); }).getAreaOptions({k:K});
google.script.run.withSuccessHandler(function(r){loadDone();$('now').textContent=r.text;})
  .withFailureHandler(function(){loadDone();$('now').textContent='';}).jstInfo({k:K});
</script>`;
