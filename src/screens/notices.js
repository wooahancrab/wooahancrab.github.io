// 공지: 대표·부대표가 올리고, 직원·매니저·중간관리자는 첫 화면 맨 위에서 읽고 '확인했어요'를 누른다.
// 읽기는 표(RLS), 쓰기(올리기·고치기·내리기·다시 번역)는 서버 함수 notices 만 한다 → 모두 api.notice* 를 통해서만(lib/api.js).
// 사용: mountNotices(자리 요소, 내 프로필, { inline }) — 자리 안을 스스로 그리고 다시 그린다. 공지가 없으면(읽는 사람) 자리는 비어 높이 0.
// 사용자가 쓴 글은 모두 글자(textContent)로만 넣는다(innerHTML 안 씀). 줄바꿈은 CSS white-space:pre-wrap.
// 화면 위치 유지: 다시 그릴 때 스크롤이 튀지 않게 한다(브라우저의 overflow-anchor 를 믿고, 지원하지 않는 브라우저는 직접 보정).
import { api } from "../lib/api.js";
import { h, toast, confirmDialog, bigToggle } from "../lib/ui.js";
import { dateOf, fmtHM, labelMD, todayKST } from "../lib/kst.js";
import { t, tx, lang } from "../lib/i18n.js";

// 공지를 올릴 수 있는 역할. 서버 SQL 함수 can_post_notice() 와 항상 같게 둔다.
// 회장(chairman)은 3단계에서 더했다. 역할을 바꿀 때는 여기와 그 SQL 함수 두 곳만 같이 고친다.
export const NOTICE_POSTER_ROLES = ["owner", "deputy", "chairman"];
export const canPostNotice = (role) => NOTICE_POSTER_ROLES.includes(role);

const TITLE_MAX = 60, BODY_MAX = 1500; // 서버 검사와 같게
const FOLD = 0; // 읽는 사람: 지난(읽은) 공지를 처음에 펼쳐 보여 주는 개수. 0 = '지난 공지 N개 더 보기' 한 줄만(첫 화면을 차지하지 않게)
const FOLD_UNREAD = 1; // 읽는 사람: 안 읽은 공지 카드를 처음에 보여 주는 개수. 확인하면 다음 것이 이어서 나온다(폰에서 탭 줄이 밀려 내려가지 않게)
const FOLD_POST = 2; // 올리는 사람: 목록을 처음에 보여 주는 개수(대표 첫 화면이 너무 길어지지 않게)
const MIN_REFRESH_MS = 60 * 1000; // 화면이 다시 보일 때 조용히 새로 불러오는 최소 간격

/* ---------- 작은 도우미 ---------- */
const isExpired = (n) => !!n.expires_on && n.expires_on < todayKST();
const ts = (n) => Date.parse(n.created_at) || 0;
const byNewest = (a, b) => (b.important ? 1 : 0) - (a.important ? 1 : 0) || ts(b) - ts(a); // 중요 먼저, 최신 먼저
const ymd = (iso) => { try { return iso ? labelMD(dateOf(iso)) : ""; } catch { return ""; } };
const dayLabel = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d ?? "") ? labelMD(d) : "");
const flip = (set, id) => { if (!set.delete(id)) set.add(id); };
// 같은 글자의 버튼(확인했어요·더 보기·고치기…)이 카드마다 반복되므로 스크린리더가 읽는 이름에 공지 제목을 덧붙인다(눈에 보이는 글자로 시작해야 한다)
const lab = (text, title) => (title ? `${text}: ${title}` : text);
// 번역이 없어 한국어 원문을 보여 주는 글은 읽는 언어를 한국어로 알려 준다(스크린리더 발음)
const lg = (v) => (v.note === "ko" || v.note === "orig" ? "ko" : null);
const needsTr = (n) => !(n.title_vi && n.body_vi && n.title_en && n.body_en); // 번역본이 하나라도 없다
const guessLong = (s) => String(s).length > 90 || String(s).split("\n").length > 3; // 줄 수를 잴 수 없을 때(화면에 붙기 전)의 짐작

// 오류 문장을 화면 언어로. DB·네트워크가 주는 영어 원문은 알아볼 수 있는 문장으로 바꾼다
function errMsg(e) {
  const m = String(e?.message ?? "");
  if (m && !/[가-힣]/.test(m)) return /failed to fetch|networkerror|load failed|network request failed/i.test(m) ? t("서버에 연결하지 못했어요") : t("처리하지 못했어요");
  return t(m || "처리하지 못했어요");
}

// 화면 언어에 맞춰 보여 줄 제목·본문. note: "" 한국어 화면 / "tr" 자동 번역본 / "orig" 번역이 있지만 원문을 보는 중 / "ko" 번역이 없어 한국어 원문을 보여 주는 중
function view(n, orig) {
  const l = lang();
  if (l === "ko") return { title: n.title, body: n.body, note: "" };
  const [tt, bb] = l === "vi" ? [n.title_vi, n.body_vi] : [n.title_en, n.body_en];
  if (tt && bb) return orig.has(n.id) ? { title: n.title, body: n.body, note: "orig" } : { title: tt, body: bb, note: "tr" };
  return { title: n.title, body: n.body, note: "ko" };
}

// 화면이 다시 보일 때 새로 불러오기: 문서에 한 번만 걸고, 사라진 화면(약한 참조)은 건너뛴다
const mounts = new Set();
const byHost = new WeakMap();
let visHooked = false;
function hookVisibility() {
  if (visHooked) return;
  visHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const ref of [...mounts]) {
      const m = ref.deref();
      if (!m) mounts.delete(ref); else m.onVisible();
    }
  });
}

/**
 * host 안에 공지를 그린다. profile.role 로 올리는 사람(대표·부대표) / 읽는 사람을 나눈다.
 * opts.inline: 이미 .page 안에 들어 있는 자리(좌우 여백을 다시 주지 않는다). opts.minRefreshMs: 다시 보일 때 새로 불러오는 최소 간격
 * 돌려주는 값: { reload(), destroy() }
 */
export function mountNotices(host, profile, opts = {}) {
  byHost.get(host)?.destroy();
  host.classList.add("nt-host");
  host.classList.toggle("inline", !!opts.inline);
  const poster = canPostNotice(profile?.role);
  const minGap = opts.minRefreshMs ?? MIN_REFRESH_MS;

  let items = [], itemsJson = "";
  let loaded = false, loadErr = "", loading = false, lastAt = 0, dead = false;
  let editing = false;
  let stores = null; // 사업장 목록(쓰기 창에서 처음 열 때 불러온다)
  const seenUnread = new Set(); // 이번에 열려 있는 동안 한 번이라도 안 읽음이던 공지: 확인해도 제자리에 접힌 줄로 남는다(목록이 튀지 않게)
  const localRead = new Map(); // 방금 내가 확인한 것: 서버에 닿기 전에 불러온 목록이 되돌리지 못하게 한다
  const full = new Set(); // 본문을 펼친 카드
  const open = new Set(); // 펼친 읽은 줄
  const orig = new Set(); // 원문으로 보는 공지
  const stats = new Map(); // 확인 현황(올리는 사람): id -> {n, m}
  const busy = new Set(); // 다시 번역·내리는 중인 공지
  let showAllUnread = false, showAllRead = false, showAllPost = false;
  let statsRun = false;

  /* ---------- 화면 위치 유지 ---------- */
  // 크롬·파이어폭스는 overflow-anchor 로 맨 위 공지가 늦게 생겨도 보던 내용이 그대로다. 지원하지 않는 브라우저(사파리 등)는
  // 사용자가 공지 자리를 지나 아래로 내려 본 상태일 때만 늘어난/줄어든 높이만큼 스크롤을 보정한다. 맨 위에 있을 때는 밀려도 된다
  const nativeAnchor = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");
  function stable(fn) {
    if (nativeAnchor || !host.isConnected || window.scrollY <= 0) return fn();
    // 공지 바로 아래 요소가 얼마나 움직였는지로 잰다(자리가 비어 display:none 일 때도 맞다). 아래 요소가 아직 화면 위쪽 선보다 아래에 보이면 밀려도 된다
    const ref = host.nextElementSibling;
    const pos = () => (ref ? ref.getBoundingClientRect().top : host.offsetHeight);
    const b0 = pos();
    fn();
    if (ref && b0 > 0) return;
    const d = pos() - b0;
    if (d) window.scrollBy(0, d);
  }

  /* ---------- 데이터 ---------- */
  async function load() {
    if (loading || dead) return;
    loading = true;
    let rows = null, err = "";
    try { const r = await api.noticeList(); rows = Array.isArray(r) ? r : []; } catch (e) { err = errMsg(e); console.warn("[공지] 불러오지 못했어요:", e?.message); }
    loading = false;
    if (dead) return;
    lastAt = Date.now();
    if (err) { if (!loaded) { loadErr = err; render(); } return; } // 이미 목록이 있으면 조용히 그대로 둔다
    for (const r of rows) {
      const lr = localRead.get(r.id);
      if (lr && !r.read_at) r.read_at = lr;
      if (!r.read_at) seenUnread.add(r.id);
    }
    const json = JSON.stringify(rows), same = json === itemsJson && loaded && !loadErr;
    loaded = true; loadErr = "";
    if (same) return; // 달라진 게 없으면 다시 그리지 않는다(위치·펼침 그대로)
    items = rows; itemsJson = json;
    render();
    if (poster) loadStats();
  }

  // 확인 현황 숫자(올리는 사람): 보이는 공지 몇 개만 불러온다. 한 번 실패하면 그만두고, 눌렀을 때 오류를 보여 준다
  async function loadStats(force = false) {
    if (!poster || statsRun || dead) return;
    statsRun = true;
    try {
      const ids = postList().slice(0, showAllPost ? 20 : FOLD_POST).map((n) => n.id).filter((id) => force || !stats.has(id));
      for (const id of ids) {
        if (dead) break;
        try { const s = await api.noticeStatus(id); stats.set(id, { n: s.confirmed.length, m: s.targets }); paintStat(id); } catch { break; }
      }
    } finally { statsRun = false; }
  }
  const statText = (s) => t("{n}/{m}명 확인", { n: s.n, m: s.m });
  function paintStat(id) { // 버튼 글자만 바꾼다(다시 그리지 않는다)
    const s = stats.get(id);
    if (!s) return;
    for (const el of host.querySelectorAll("[data-nt-stat]")) {
      if (el.dataset.ntStat !== id) continue;
      el.textContent = statText(s);
      el.setAttribute("aria-label", lab(el.textContent, el.closest("[data-nt]")?.querySelector(".nt-title")?.textContent));
    }
  }

  const setRead = (id, at) => { const n = items.find((x) => x.id === id); if (n) n.read_at = at; };
  function upsert(row) { // 서버가 돌려준 공지 한 줄을 목록에 반영한다(읽음·사업장 이름은 가진 것을 이어 쓴다)
    if (!row?.id) return;
    const prev = items.find((x) => x.id === row.id);
    const sn = row.store_id ? (stores?.find((s) => s.id === row.store_id)?.display_name || stores?.find((s) => s.id === row.store_id)?.name || row.store_name || prev?.store_name || "") : "";
    const merged = { read_at: prev?.read_at ?? null, ...row, store_name: sn };
    items = prev ? items.map((x) => (x.id === row.id ? merged : x)) : [merged, ...items];
  }

  /* ---------- 읽는 사람: 확인했어요 ---------- */
  function confirmRead(n) {
    if (localRead.has(n.id)) return;
    const at = new Date().toISOString();
    localRead.set(n.id, at);
    setRead(n.id, at); // 낙관적: 먼저 접힌 줄로 바꾸고 서버에는 뒤에서 남긴다
    render();
    api.noticeRead(n.id).catch((e) => {
      localRead.delete(n.id); setRead(n.id, null); render();
      toast(errMsg(e) === t("서버에 연결하지 못했어요") ? t("서버에 연결하지 못했어요") : t("확인을 남기지 못했어요. 다시 눌러 주세요"), 4000);
    });
  }

  /* ---------- 공통 조각 ---------- */
  // 목록을 더 펼치는 버튼: 눌러도 키보드 위치가 사라지지 않게, 새로 나온 첫 공지로 포커스를 옮긴다
  const moreBtn = (label, onclick) => h("button", { type: "button", class: "btn weak slim nt-all", onclick: () => { const before = shownIds(); onclick(); focusNew(before); } }, label);
  const topRow = (n, extra) => h("div", { class: "nt-top" },
    n.important && h("span", { class: "badge bad" }, t("중요")),
    isExpired(n) && h("span", { class: "badge" }, t("만료")),
    extra,
    h("span", { class: "muted nt-date" }, ymd(n.created_at)));
  // 자동 번역 라벨·원문 보기 토글(한국어 화면에서는 없다)
  function noteRow(n, v) {
    if (!v.note) return null;
    return h("div", { class: "nt-note" },
      h("span", { class: "badge" + (v.note === "tr" ? " info" : "") }, v.note === "tr" ? t("자동 번역") : t("한국어 원문")),
      v.note !== "ko" && h("button", { type: "button", class: "linkbtn", "data-nk": "orig:" + n.id, "aria-label": lab(v.note === "tr" ? t("원문 보기") : t("번역 보기"), v.title), onclick: () => { flip(orig, n.id); render(); } }, v.note === "tr" ? t("원문 보기") : t("번역 보기")));
  }
  // 본문 + (길면) 더 보기. 줄 수는 화면에 붙은 뒤 재서 정한다(meas 에 모아 두었다가 fitMore)
  function bodyBlock(n, v, meas) {
    const isFull = full.has(n.id);
    const body = h("div", { class: "nt-body" + (isFull ? "" : " clamp"), lang: lg(v) }, v.body);
    const row = h("div", { class: "nt-morerow", hidden: !isFull && !guessLong(v.body) },
      h("button", { type: "button", class: "linkbtn", "data-nk": "more:" + n.id, "aria-expanded": isFull ? "true" : "false", "aria-label": lab(isFull ? t("접기") : t("더 보기"), v.title), onclick: () => { flip(full, n.id); render(); } }, isFull ? t("접기") : t("더 보기")));
    meas.push({ body, row, full: isFull });
    return [body, row];
  }
  function fitMore(meas) {
    if (!host.isConnected) return;
    for (const m of meas) m.row.hidden = m.full ? false : !(m.body.scrollHeight > m.body.clientHeight + 1);
  }
  // 줄 수는 화면에 붙은 뒤에야 잴 수 있다. 자리(host)가 공지보다 늦게 붙거나(총괄·대표 첫 화면) 폭이 바뀌면(휴대폰 회전) 다시 잰다.
  // 안 그러면 잘린 글에 '더 보기'가 없어 끝까지 읽을 방법이 없다. 크기 변화 알림 안에서 바로 고치지 않고 다음 프레임에 한 번만 잰다
  let refitQueued = false, ro = null;
  function refit() {
    refitQueued = false;
    if (dead || !host.isConnected) return;
    for (const body of host.querySelectorAll(".nt-body.clamp")) {
      const row = body.nextElementSibling;
      if (row && row.classList.contains("nt-morerow")) row.hidden = !(body.scrollHeight > body.clientHeight + 1);
    }
  }
  if (typeof ResizeObserver === "function") {
    ro = new ResizeObserver(() => { if (!refitQueued) { refitQueued = true; requestAnimationFrame(refit); } });
    ro.observe(host);
  }

  /* ---------- 읽는 사람 화면 ---------- */
  function unreadCard(n, meas) {
    const v = view(n, orig);
    return h("div", { class: "card nt-card unread", "data-nt": n.id },
      topRow(n), h("b", { class: "nt-title", lang: lg(v) }, v.title), bodyBlock(n, v, meas), noteRow(n, v),
      h("button", { type: "button", class: "btn ghost slim nt-ok", "data-nk": "ok:" + n.id, "aria-label": lab(tx("공지", "확인했어요"), v.title), onclick: () => confirmRead(n) },
        h("span", { "aria-hidden": "true" }, "✓ "), tx("공지", "확인했어요")));
  }
  function readLine(n) { // 읽은 공지: 한 줄(✓ 제목 · 날짜), 눌러서 펼친다
    const v = view(n, orig), isOpen = open.has(n.id);
    return h("div", { class: "nt-rl" + (isOpen ? " open" : ""), "data-nt": n.id },
      h("button", { type: "button", class: "item", "data-nk": "row:" + n.id, "aria-expanded": isOpen ? "true" : "false", onclick: () => { flip(open, n.id); render(); } },
        h("span", { class: "nt-ltxt", lang: lg(v) }, h("span", { "aria-hidden": "true" }, "✓ "), v.title, h("span", { class: "muted" }, " · " + ymd(n.created_at))), h("span", { class: "chev", "aria-hidden": "true" })),
      isOpen && h("div", { class: "nt-detail" },
        n.important && h("div", null, h("span", { class: "badge bad" }, t("중요"))),
        h("b", { class: "nt-title", lang: lg(v) }, v.title), h("div", { class: "nt-body", lang: lg(v) }, v.body), noteRow(n, v)));
  }
  function readerNodes(meas) {
    const out = [];
    const vis = items.filter((n) => !isExpired(n));
    if (!vis.length) return out; // 공지가 없으면 아무것도 그리지 않는다
    const A = vis.filter((n) => seenUnread.has(n.id)).sort(byNewest);
    const B = vis.filter((n) => !seenUnread.has(n.id)).sort(byNewest);
    let list = null; // 이어지는 한 줄들은 한 덩어리(.rowlist)로 묶는다
    const line = (n) => { if (!list) { list = h("div", { class: "rowlist nt-lines" }); out.push(list); } list.append(readLine(n)); };
    let budget = showAllUnread ? Infinity : FOLD_UNREAD, hidden = 0;
    for (const n of A) {
      if (n.read_at) line(n);
      else if (budget > 0) { budget--; list = null; out.push(unreadCard(n, meas)); }
      else hidden++;
    }
    if (hidden) { list = null; out.push(moreBtn(t("공지 {n}개 더 보기", { n: hidden }), () => { showAllUnread = true; render(); })); }
    const shown = showAllRead ? B : B.slice(0, FOLD);
    for (const n of shown) line(n);
    if (B.length > shown.length) { list = null; out.push(moreBtn(t("지난 공지 {n}개 더 보기", { n: B.length - shown.length }), () => { showAllRead = true; render(); })); }
    return out;
  }

  /* ---------- 올리는 사람 화면 ---------- */
  const postList = () => items.slice().sort((a, b) => (isExpired(a) ? 1 : 0) - (isExpired(b) ? 1 : 0) || byNewest(a, b)); // 올라가 있는 것 먼저, 만료된 것은 뒤
  function postCard(n, meas) {
    const v = view(n, orig), st = stats.get(n.id);
    const meta = [t("대상: {name}", { name: n.store_id ? (n.store_name || "") : t("전 사업장") }), n.created_name, n.expires_on && t("{date}까지", { date: dayLabel(n.expires_on) })].filter(Boolean).join(" · ");
    return h("div", { class: "card nt-card post" + (isExpired(n) ? " off" : ""), "data-nt": n.id },
      topRow(n, needsTr(n) && h("span", { class: "badge warn" }, t("번역 없음"))),
      h("b", { class: "nt-title", lang: lg(v) }, v.title), h("div", { class: "muted" }, meta),
      bodyBlock(n, v, meas), noteRow(n, v),
      h("div", { class: "nt-acts" },
        h("button", { type: "button", class: "btn ghost slim", "data-nt-stat": n.id, "data-nk": "stat:" + n.id, "aria-label": lab(st ? statText(st) : t("확인 현황"), v.title), onclick: () => showStatus(n) }, st ? statText(st) : t("확인 현황")),
        h("button", { type: "button", class: "btn ghost slim", "data-nk": "edit:" + n.id, "aria-label": lab(t("고치기"), v.title), onclick: () => openEditor(n) }, t("고치기")),
        needsTr(n) && h("button", { type: "button", class: "btn ghost slim", "data-nk": "retr:" + n.id, "aria-label": lab(busy.has(n.id) ? t("번역 중…") : t("다시 번역"), v.title), disabled: busy.has(n.id), onclick: () => retranslate(n) }, busy.has(n.id) ? t("번역 중…") : t("다시 번역")),
        h("button", { type: "button", class: "btn danger slim", "data-nk": "rm:" + n.id, "aria-label": lab(t("내리기"), v.title), disabled: busy.has(n.id), onclick: () => removeNotice(n) }, t("내리기"))));
  }
  function posterNodes(meas) {
    const out = [h("div", { class: "nt-bar" }, h("button", { type: "button", class: "btn ghost slim", "data-nk": "write", onclick: () => openEditor(null) }, t("📢 공지 쓰기")))];
    if (loadErr && !loaded) out.push(h("p", { class: "err nt-err", role: "alert" }, t("공지를 불러오지 못했어요: {msg}", { msg: loadErr }), " ",
      h("button", { type: "button", class: "linkbtn", "data-nk": "retry", onclick: () => { loadErr = ""; load(); } }, t("다시 시도"))));
    const list = postList();
    if (list.length) {
      out.push(h("div", { class: "sub-title" }, t("올라가 있는 공지")));
      const shown = showAllPost ? list : list.slice(0, FOLD_POST);
      for (const n of shown) out.push(postCard(n, meas));
      if (list.length > shown.length) out.push(moreBtn(t("공지 {n}개 더 보기", { n: list.length - shown.length }), () => { showAllPost = true; render(); loadStats(); }));
    }
    return out;
  }

  /* ---------- 그리기 ---------- */
  // 키보드 포커스 유지: 다시 그리면 눌렀던 버튼이 새로 만들어져 포커스가 사라지므로, 그리기 전에 포커스가 있던 버튼의 열쇠(data-nk)를 적어 두었다가
  // 같은 버튼에 돌려준다. 그 버튼이 없어졌으면(확인한 공지·내린 공지) 가까운 버튼으로. wantKey: 눌렀을 때 버튼이 잠겨 포커스를 잃는 경우(다시 번역)를 위해 미리 적어 둔다
  let wantKey = null;
  const keyOf = (el) => (el && el !== host && host.contains(el) ? el.getAttribute("data-nk") : null);
  const byKey = (k) => [...host.querySelectorAll("[data-nk]")].find((e) => e.getAttribute("data-nk") === k);
  function refocus(k) {
    if (!k) return;
    const [kind, id] = k.split(":");
    const near = kind === "ok" ? "row:" + id : kind === "retr" ? "edit:" + id : kind === "rm" ? "write" : null;
    const el = byKey(k) ?? (near && byKey(near));
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
  const shownIds = () => new Set([...host.querySelectorAll("[data-nt]")].map((e) => e.getAttribute("data-nt")));
  function focusNew(before) { // '더 보기'로 새로 나온 첫 공지의 첫 버튼으로 포커스를 옮긴다
    const el = [...host.querySelectorAll("[data-nt]")].find((e) => !before.has(e.getAttribute("data-nt")));
    // 숨겨진 '더 보기' 줄 안의 버튼은 포커스를 받지 못하므로 보이는 첫 버튼을 고른다
    [...(el?.querySelectorAll("button, input, select, textarea") ?? [])].find((b) => !b.disabled && !b.closest("[hidden]"))?.focus({ preventScroll: true });
  }

  function render() {
    if (dead) return;
    const fk = wantKey ?? keyOf(document.activeElement);
    wantKey = null;
    stable(() => {
      const meas = [];
      host.replaceChildren(...(poster ? posterNodes(meas) : readerNodes(meas)));
      fitMore(meas);
    });
    refocus(fk);
  }

  /* ---------- 창(.overlay/.dialog): 저장이 실패해도 닫지 않고 오류를 보여 준다 ---------- */
  // 열 때 창으로 포커스를 옮기고(제목을 이름으로 읽어 준다), Tab 이 창 밖으로 나가지 않게 가두며, 닫으면 눌렀던 버튼으로 돌려준다. ov.onEsc 가 있으면 Esc 로 닫는다
  let dlgSeq = 0;
  function dialog(...kids) {
    const box = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", tabindex: "-1" }, ...kids);
    const ov = h("div", { class: "overlay" }, box);
    const hd = box.querySelector("h2");
    if (hd) { hd.id = "nt-dlg-" + (++dlgSeq); box.setAttribute("aria-labelledby", hd.id); }
    box.style.outline = "0";
    const opener = keyOf(document.activeElement);
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && ov.onEsc) { e.preventDefault(); ov.onEsc(); return; }
      if (e.key !== "Tab") return;
      const f = [...box.querySelectorAll("button, input, select, textarea")].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1], cur = document.activeElement;
      if (e.shiftKey ? cur === first || cur === box : cur === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    });
    ov.close = () => { ov.remove(); refocus(opener); };
    document.body.append(ov);
    box.focus({ preventScroll: true });
    return ov;
  }
  function toggleRow(label, init, onChange, locked) { // 켜고 끄는 큰 버튼(bigToggle)을 눌러도 창이 다시 그려지지 않게 이 줄만 바꾼다
    let on = init;
    const wrap = h("div");
    const paint = (focus) => {
      const b = bigToggle(label, on, () => { if (locked()) return; on = !on; onChange(on); paint(true); });
      wrap.replaceChildren(b);
      if (focus) b.focus();
    };
    paint(false);
    return wrap;
  }

  async function openEditor(n) {
    if (editing) return;
    editing = true;
    if (stores == null) { try { stores = await api.listStores(); } catch { stores = null; } }
    const isNew = !n;
    let important = !!n?.important, push = true, saving = false;
    const titleIn = h("input", { type: "text", class: "inp", maxlength: String(TITLE_MAX), placeholder: t("제목 (60자까지)"), autocomplete: "off", "aria-label": t("제목"), value: n?.title ?? "" });
    const bodyIn = h("textarea", { class: "inp", rows: "6", maxlength: String(BODY_MAX), placeholder: t("직원들에게 알릴 내용을 적어 주세요"), "aria-label": t("내용"), value: n?.body ?? "" });
    const tCnt = h("span", { class: "hint" }), bCnt = h("span", { class: "hint" });
    const count = () => { tCnt.textContent = `${titleIn.value.length}/${TITLE_MAX}`; bCnt.textContent = `${bodyIn.value.length}/${BODY_MAX}`; };
    titleIn.addEventListener("input", count); bodyIn.addEventListener("input", count); count();
    const list = [...(stores ?? [])];
    if (n?.store_id && !list.some((s) => s.id === n.store_id)) list.push({ id: n.store_id, display_name: n.store_name || "" }); // 사업장 목록을 못 불러와도 지금 대상은 그대로 둔다
    const storeSel = h("select", { class: "inp", "aria-label": t("대상") }, h("option", { value: "" }, t("전 사업장")), list.map((s) => h("option", { value: s.id }, s.display_name || s.name || "")));
    storeSel.value = n?.store_id ?? "";
    const dateIn = h("input", { type: "date", class: "inp", "aria-label": t("보이는 날짜 끝 (선택)") });
    if (isNew || !n.expires_on || n.expires_on >= todayKST()) dateIn.min = todayKST();
    dateIn.value = n?.expires_on ?? "";
    const errEl = h("p", { class: "err nt-err", role: "alert", hidden: true });
    const saveBtn = h("button", { type: "button", class: "btn primary" }, t("저장"));
    const cancelBtn = h("button", { type: "button", class: "btn ghost" }, t("취소"));
    const fail = (m) => { errEl.textContent = m; errEl.hidden = false; };
    const lock = (on) => { saving = on; saveBtn.disabled = on; cancelBtn.disabled = on; saveBtn.textContent = on ? t("저장하는 중…") : t("저장"); };
    const ov = dialog(
      h("h2", null, isNew ? t("공지 쓰기") : t("공지 고치기")),
      h("div", { class: "nt-lblrow" }, h("span", { class: "lbl" }, t("제목")), tCnt), titleIn,
      h("div", { class: "nt-lblrow" }, h("span", { class: "lbl" }, t("내용")), bCnt), bodyIn,
      h("span", { class: "lbl" }, t("대상")), storeSel,
      toggleRow(t("중요한 공지로 표시"), important, (v) => { important = v; }, () => saving),
      h("span", { class: "lbl" }, t("보이는 날짜 끝 (선택)")), dateIn,
      h("div", { class: "nt-lblrow" }, h("span", { class: "hint" }, t("비우면 내릴 때까지 보여요")),
        h("button", { type: "button", class: "linkbtn", onclick: () => { if (!saving) dateIn.value = ""; } }, t("날짜 지우기"))),
      isNew && toggleRow(t("알림으로도 보내기"), push, (v) => { push = v; }, () => saving),
      isNew && h("p", { class: "hint" }, t("직원 휴대폰으로 알림이 가요. 고칠 때는 다시 보내지 않아요.")),
      errEl, saveBtn, cancelBtn);
    const done = () => { ov.close(); editing = false; };
    cancelBtn.addEventListener("click", () => { if (!saving) done(); });
    ov.onEsc = () => { if (!saving && titleIn.value === (n?.title ?? "") && bodyIn.value === (n?.body ?? "")) done(); }; // 쓰던 글이 있으면 Esc 로는 닫지 않는다(실수로 잃지 않게)
    saveBtn.addEventListener("click", async () => {
      if (saving) return; // 두 번 눌러도 한 번만
      const title = titleIn.value.trim(), body = bodyIn.value.trim(), exp = dateIn.value || null;
      errEl.hidden = true;
      if (!title) { fail(t("제목을 적어 주세요")); titleIn.focus(); return; }
      if (!body) { fail(t("내용을 적어 주세요")); bodyIn.focus(); return; }
      if (exp && exp < todayKST() && exp !== (n?.expires_on ?? null)) { fail(t("지난 날짜는 고를 수 없어요")); return; }
      lock(true);
      let r;
      try { r = await api.noticeSave({ id: n?.id, title, body, store_id: storeSel.value || null, important, expires_on: exp, push: isNew && push }); }
      catch (e) { lock(false); fail(errMsg(e)); return; } // 실패하면 창을 닫지 않고 쓴 내용을 그대로 둔다
      done();
      upsert(r?.notice);
      if (r?.notice?.id) stats.delete(r.notice.id);
      render();
      if (r?.translated === false) toast(t("저장했어요. 번역은 하지 못해 한국어로만 보여요 (나중에 '다시 번역')"), 6000);
      else if (isNew && push && r?.pushed > 0) toast(t("저장했어요. 알림 {n}명에게 보냈어요", { n: r.pushed }), 4000);
      else toast(t("저장했어요"));
      loadStats();
    });
    titleIn.focus({ preventScroll: true });
  }

  function showStatus(n) { // 확인한 사람·아직 안 한 사람
    const box = h("div", { class: "stack" });
    const v = view(n, orig);
    const closeBtn = h("button", { type: "button", class: "btn primary", onclick: () => ov.close() }, t("닫기"));
    const ov = dialog(h("h2", null, t("확인 현황")), h("p", { class: "muted", lang: lg(v) }, v.title), box, closeBtn);
    ov.onEsc = () => ov.close();
    const person = (p, when) => h("div", { class: "lrow" },
      h("span", null, p.name || "", p.job_title && h("span", { class: "muted" }, " · " + p.job_title)),
      when && h("span", { class: "muted" }, when));
    const section = (label, rows, make) => h("div", null, h("h3", { class: "cat-title" }, label), rows.length ? rows.map(make) : h("p", { class: "muted" }, t("없어요")));
    async function fetchIt() {
      box.replaceChildren(h("p", { class: "muted" }, t("불러오는 중…")));
      try {
        const s = await api.noticeStatus(n.id);
        stats.set(n.id, { n: s.confirmed.length, m: s.targets }); paintStat(n.id);
        box.replaceChildren(h("div", { class: "stack" },
          h("p", null, h("b", null, statText(stats.get(n.id)))),
          s.targets === 0 && !s.confirmed.length && !s.pending.length && h("p", { class: "muted" }, t("확인할 직원이 아직 없어요")),
          section(t("확인한 사람 {n}명", { n: s.confirmed.length }), s.confirmed, (p) => person(p, p.at ? `${ymd(p.at)} ${fmtHM(p.at)}` : "")),
          section(t("아직 확인 안 한 사람 {n}명", { n: s.pending.length }), s.pending, (p) => person(p, ""))));
      } catch (e) {
        box.replaceChildren(h("p", { class: "err" }, errMsg(e)), h("button", { type: "button", class: "btn ghost slim", onclick: fetchIt }, t("다시 시도")));
      }
    }
    fetchIt();
  }

  async function retranslate(n) {
    if (busy.has(n.id)) return;
    wantKey = "retr:" + n.id; // 누르면 버튼이 잠겨 포커스를 잃으므로, 끝난 뒤 돌려준다
    busy.add(n.id); render();
    try {
      const r = await api.noticeRetranslate(n.id);
      upsert(r?.notice);
      toast(r?.translated ? t("번역했어요") : t("번역하지 못했어요. 잠시 뒤에 다시 해 주세요"), r?.translated ? 2600 : 5000);
    } catch (e) { toast(errMsg(e), 5000); }
    busy.delete(n.id); wantKey = "retr:" + n.id; render();
  }

  const asking = new Set(); // 내릴지 묻는 창이 떠 있는 공지: 빠르게 두 번 눌러도 창이 겹쳐 뜨지 않게
  async function removeNotice(n) {
    if (busy.has(n.id) || asking.has(n.id)) return;
    asking.add(n.id);
    const yes = await confirmDialog(t("이 공지를 내릴까요?"), [view(n, orig).title, t("내리면 직원 화면에서 사라져요")], t("취소"), t("내리기")); // 화면 언어로 보이는 제목을 보여 준다
    asking.delete(n.id);
    if (!yes) { refocus("rm:" + n.id); return; } // 공용 확인창은 포커스를 돌려주지 않으므로 누르던 버튼으로 돌려준다
    wantKey = "rm:" + n.id;
    busy.add(n.id); render();
    try {
      await api.noticeRemove(n.id);
      items = items.filter((x) => x.id !== n.id); stats.delete(n.id);
      busy.delete(n.id); wantKey = "rm:" + n.id; render(); // 내린 공지의 버튼은 없으니 '공지 쓰기' 버튼으로
      toast(t("내렸어요"));
    } catch (e) { busy.delete(n.id); wantKey = "rm:" + n.id; render(); toast(errMsg(e), 5000); }
  }

  /* ---------- 시작·정리 ---------- */
  const handle = {
    reload: () => load(),
    destroy() { dead = true; ro?.disconnect(); host.replaceChildren(); byHost.delete(host); mounts.delete(ref); },
    onVisible() { // 화면이 다시 보일 때 조용히 새로 불러온다(60초에 한 번 이하, 붙어 있는 자리만)
      if (dead || !host.isConnected || loading || Date.now() - lastAt < minGap) return;
      load().then(() => { if (poster && !dead) loadStats(true); });
    },
  };
  const ref = typeof WeakRef === "function" ? new WeakRef(handle) : { deref: () => handle };
  byHost.set(host, handle);
  mounts.add(ref);
  hookVisibility();
  render(); // 올리는 사람은 '공지 쓰기' 줄이 바로 보이고, 읽는 사람은 비어 있다(높이 0)
  load();
  return handle;
}
