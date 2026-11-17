// 말로 업무지시: 문장을 AI가 해석한다. 받는 사람·업무·날짜가 모두 분명하면 바로 지시하고(방금 지시 목록에서 바로 취소),
// 애매하면(이름이 여럿·못 찾음·묶음·경고·같은 업무 진행 중·긴 글) '확인 카드'로 사람이 확인한 뒤 지시한다.
// 쓸 수 있는 사람: 대표·부대표(전 직원), 매니저·중간관리자(내 담당 직원만). 직원은 쓸 수 없다.
// AI는 아무것도 저장하지 않는다. 저장은 항상 기존 업무지시(api.tkCreate)를 사람마다 한 번씩 부른다.
import { api, isDemo } from "../lib/api.js";
import { h, toast, confirmDialog, seg, bigToggle } from "../lib/ui.js";
import { labelMD, dateOf, todayKST, parseDate, addDays } from "../lib/kst.js";
import { t, tx, lang, dowNames } from "../lib/i18n.js";
import { askSafety, isSafetyAsk, isSafety } from "../lib/tr.js";

const MAX_TEXT = 600;
const MAX_ROWS = 40;
const MAX_MINE = 30;
const TOP_ROLES = ["owner", "deputy"];
const LEAD_ROLES = ["manager", "supervisor"];
// 화면에 보이는 한국어는 화면을 그릴 때 t()로 만든다(모듈 맨 위에서는 화면 언어가 아직 한국어라서 표를 함수로 둔다)
const REPEAT_VALUES = ["none", "daily", "weekly", "monthly"];
const repeatLabels = () => ({ none: t("한 번"), daily: t("매일"), weekly: t("매주"), monthly: t("매달") });
const repeatOpts = () => { const l = repeatLabels(); return REPEAT_VALUES.map((v) => [v, l[v]]); };
const repLine = (rep) => t("{rep} 반복", { rep: repeatLabels()[rep] });

const errKo = () => ({
  auth: t("로그인이 풀렸어요. 앱을 닫았다가 다시 열어 로그인해 주세요."),
  forbidden: t("이 계정은 말로 업무지시를 쓸 수 없어요."),
  disabled: t("AI 업무지시가 지금 꺼져 있어요."),
  limit: t("오늘 쓸 수 있는 AI 사용 한도를 다 썼어요."),
  no_key: t("AI 연결 열쇠가 아직 등록되지 않았어요."),
  key_bad: t("AI 연결 열쇠가 맞지 않아요."),
  credit: t("AI 사용 충전금이 바닥났거나 월 한도에 닿았어요."),
  busy: t("AI가 지금 바빠요. 잠시 뒤에 다시 시도해 주세요."),
  timeout: t("AI 답이 너무 늦어서 멈췄어요. 이번 시도는 횟수에 들어갔을 수 있어요. 잠시 뒤에 다시 시도해 주세요."),
  bad_input: t("문장을 확인해 주세요. 1자 이상 600자 이하로 써야 해요."),
  bad_output: t("AI 답을 이해하지 못했어요. 문장을 조금 바꿔서 다시 시도해 주세요."),
  refused: t("AI가 이 문장은 처리하지 않았어요. 업무 내용만 짧게 다시 써 주세요."),
  server: t("서버에 문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요."),
  network: t("서버에 연결하지 못했어요. 인터넷 상태를 확인하고 다시 시도해 주세요."),
  demo: t("데모 모드에서는 쓸 수 없어요."),
});
// 설정·한도 문제는 누가 풀어야 하는지가 역할마다 달라서 뒤에 한 줄을 붙인다
const fixTop = () => ({
  disabled: t("설정에서 켜야 쓸 수 있어요."),
  limit: t("내일 다시 쓰거나 직접 지시해 주세요."),
  no_key: t("열쇠 등록이 끝나야 쓸 수 있어요."),
  key_bad: t("열쇠를 다시 확인해 주세요."),
  credit: t("충전·한도를 확인해 주세요."),
});
const fixLead = () => ({
  disabled: t("대표에게 알려 주세요."),
  limit: t("내일 다시 써 주세요."),
  no_key: t("대표에게 알려 주세요."),
  key_bad: t("대표에게 알려 주세요."),
  credit: t("대표에게 알려 주세요."),
});

// 연결 확인 4단계와, 오류 코드가 어느 단계에서 난 것인지
const pingSteps = () => [["auth", t("로그인 확인")], ["role", t("사용 권한 확인")], ["key", t("AI 열쇠 확인")], ["model", t("AI 응답 확인")]];
const FAIL_STEP = { auth: "auth", forbidden: "role", disabled: "role", no_key: "key", key_bad: "key", credit: "key", busy: "model", timeout: "model", bad_output: "model", refused: "model", server: "model" };

// 서버(ai 함수)가 돌려주는 한국어 경고(받는 사람·마감일 검사). 값(날짜·이름·요일)이 들어간 문구는 {자리}를 찾아 채워 번역한다
const WARN_KEYS = [
  "전화번호·긴 숫자는 가려서 AI에게 보냈어요",
  "글의 '{week} 주 {dow}요일'에 맞춰 마감일을 {date}({dws})로 정했어요. 날짜를 확인해 주세요",
  "글에는 '{dow}요일'이라고만 쓰셨는데 가장 가까운 {dow}요일은 {first}이에요(마감일은 {due}). 날짜를 확인해 주세요",
  "마감일을 알아듣지 못해서 비웠어요. 직접 골라 주세요",
  "지난 날짜({date})라서 마감일을 비웠어요. 직접 골라 주세요",
  "너무 먼 날짜({date})라서 마감일을 비웠어요. 직접 골라 주세요",
  "달력(6주) 밖 날짜예요. 날짜를 한 번 더 확인해 주세요",
  "마감일 '{text}'을(를) 정하지 못했어요. 직접 골라 주세요",
  "반복 업무는 첫 마감일이 있어야 해요. 마감일을 정해 주세요",
  "매달 {d}일 반복은 다음 달부터 30일, 2월 이후엔 28일로 굳어져요. 월말 업무는 28일 이하로 정하거나 매달 직접 지시해 주세요",
  "글에는 {dow}요일이라고 쓰셨는데 마감일은 {dow2}요일이에요. 날짜를 확인해 주세요",
  "글에는 '{w}'라고 쓰셨는데 마감일은 {date}({dws})이에요. 날짜를 확인해 주세요",
  "글에는 '{w}'라고 쓰셨는데 마감일이 비어 있어요. 마감일을 정해 주세요",
  "'{label}' 묶음 지시는 문장에서 찾지 못해 뺐어요. 받는 사람 이름을 직접 적어 주세요",
  "'{label}' 조건에 맞는 직원이 없어요",
  "'{label}' 조건이 사업장·직책 이름과 정확히 같지 않아 비슷한 이름을 모두 넣었어요. 목록을 꼭 확인해 주세요",
  "'{label}'은(는) 직책이 '직원'인 사람만 넣어서 다른 직책 {n}명이 빠졌어요. 전원에게 시킬 일이면 사업장만 적고 직책은 빼서 다시 써 주세요",
  "문장에 나온 {names}이(가) 받는 사람에 없어요. 확인해 주세요",
  "받는 사람을 알아듣지 못했어요. 이름을 확인해 주세요",
  "이름이 여러 명과 맞거나 확실하지 않아요. 받는 사람을 직접 골라 주세요",
  "내 담당 직원이 아니면 지시할 수 없어요",
  "명단에서 찾지 못한 이름이 있어요",
  "받는 사람이 20명을 넘어요. 사업장이나 직책 범위를 좁혀 주세요",
];
// {자리}가 서버 문장에서 어떤 모양인지(없으면 아무 글자나)
const WARN_SLOT = { week: "(이번|다음|다다음)", dow: "([월화수목금토일])", dow2: "([월화수목금토일])", dws: "([월화수목금토일])", date: "(\\d{4}-\\d{2}-\\d{2})", first: "(\\d{4}-\\d{2}-\\d{2})", due: "(\\d{4}-\\d{2}-\\d{2})", w: "(오늘|내일|모레)", n: "(\\d+)", d: "(\\d+)" };
// 찾아낸 값을 화면 언어로(날짜·이름·사용자가 쓴 말은 그대로)
const WARN_CONV = {
  week: (v) => tx("주", v),
  dow: (v) => tx("요일", v + "요일"),
  dow2: (v) => tx("요일", v + "요일"),
  dws: (v) => dowNames()["일월화수목금토".indexOf(v)] ?? v,
  w: (v) => t(v).toLowerCase(),
  label: (v) => (v === "묶음 지시" ? t("묶음 지시") : v),
};
let warnRes = null;
const warnPatterns = () => {
  if (!warnRes) {
    warnRes = WARN_KEYS.filter((k) => k.includes("{")).map((key) => {
      const names = [];
      const src = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{(\w+)\\\}/g, (_, nm) => { names.push(nm); return WARN_SLOT[nm] ?? "([\\s\\S]+?)"; });
      return { key, names, re: new RegExp("^" + src + "$") };
    });
  }
  return warnRes;
};
function warnText(w) {
  if (lang() === "ko" || typeof w !== "string") return w;
  const direct = t(w);
  if (direct !== w) return direct;
  for (const { key, names, re } of warnPatterns()) {
    const m = re.exec(w);
    if (!m) continue;
    const params = {};
    names.forEach((nm, i) => { if (!(nm in params)) params[nm] = WARN_CONV[nm] ? WARN_CONV[nm](m[i + 1]) : m[i + 1]; });
    return t(key, params);
  }
  return w;
}
// 서버·api 가 준 한국어 문구를 화면 언어로. 사전에 없어 한국어가 그대로 남으면 null(한국어 화면에서는 그대로 돌려준다)
const serverText = (m) => { const s = t(m); return lang() !== "ko" && /[가-힣]/.test(s) ? null : s; };

const own = (map, k) => (typeof k === "string" && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined);
const str = (v) => (typeof v === "string" ? v : "");
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const normTitle = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
// 서버 호출이 멈춰도 화면이 영원히 기다리지 않게 한다. 시간이 지나면 network 오류로 끝낸다
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "network" })), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const personLine = (p) => [p.display_name, p.job_title, p.store_name].filter(Boolean).join(" · ");
// 업무 저장 오류는 tasks 함수가 준 한국어 문구를 우선 보여 준다
const saveErrText = (e) => {
  const m = str(e?.message);
  if (e?.code === "network") return t("서버 응답이 끊겼어요. 다시 보내기 전에 이미 만들어졌는지 먼저 확인해요");
  if (/[가-힣]/.test(m)) { const s = serverText(m); if (s !== null) return s; }
  return own(errKo(), e?.code) ?? t("저장하지 못했어요");
};
// 목록 읽기·지시 취소처럼 '다시 보내기'와 상관없는 곳의 오류 문구
const plainErrText = (e) => (e?.code === "network" ? errKo().network : saveErrText(e));
const chosenOf = (r) => r.cands.find((x) => x.user_id === r.chosen) ?? null;
const rowLabel = (r) => { const p = chosenOf(r); return p ? personLine(p) : `‘${r.mention}’`; };

function relDay(d, today) {
  const n = Math.round((parseDate(d) - parseDate(today)) / 86400e3);
  const rel = n === 0 ? t("오늘") : n === 1 ? t("내일") : n === 2 ? t("모레") : n > 0 ? t("{n}일 뒤", { n }) : n === -1 ? t("1일 지남") : t("{n}일 지남", { n: -n });
  return d.slice(0, 4) !== today.slice(0, 4) ? t("{y}년 · {rel}", { y: d.slice(0, 4), rel }) : rel;
}

// tasks 행의 담당자가 이 사람인지 (id 우선, 없으면 이름)
const sameAssignee = (x, target) => (x.assignee_id ? x.assignee_id === target.user_id : x.assignee_name === target.display_name);

// 서버 답을 화면이 쓰는 모양으로 정리. 모양이 이상하면 bad_output
function fromResponse(res) {
  const bad = () => Object.assign(new Error("bad_output"), { code: "bad_output" });
  if (!res || res.ok !== true) throw bad();
  const warnings = (Array.isArray(res.warnings) ? res.warnings : []).map(str).filter(Boolean).slice(0, 8).map((w) => clip(w, 200));
  const base = { today: isDate(res.today) ? res.today : todayKST(), understood: clip(str(res.understood), 200), warnings };
  if (res.too_many === true) return { ...base, tooMany: true, card: null, rows: [] };
  if (!res.card || typeof res.card !== "object" || !Array.isArray(res.people)) throw bad();
  if (res.people.length > MAX_ROWS) return { ...base, tooMany: true, card: null, rows: [] };
  const c = res.card;
  const card = {
    title: str(c.title).slice(0, 60),
    memo: str(c.memo).slice(0, 200),
    due_date: isDate(c.due_date) ? c.due_date : null,
    repeat: REPEAT_VALUES.includes(c.repeat) ? c.repeat : "none",
    safety: false, // '안전 관련(자동 번역 안 함)': AI 가 정하지 않는다. 카드에서 사람이 켠다
  };
  const rows = [];
  let skipped = 0;
  for (const p of res.people) {
    const via = p?.via === "group" ? "group" : "name";
    const cands = (Array.isArray(p?.candidates) ? p.candidates : []).slice(0, 30)
      .map((x) => ({ user_id: str(x?.user_id), display_name: str(x?.display_name), job_title: str(x?.job_title), store_name: str(x?.store_name) }))
      .filter((x) => x.user_id);
    let uid = str(p?.user_id);
    const mention = str(p?.mention).slice(0, 40) || (via === "group" ? t("묶음 지시") : t("담당자"));
    let status = p?.status === "ok" || p?.status === "pick" || p?.status === "none" ? p.status : "none";
    if (via === "group") {
      // 묶음 지시의 받는 사람은 서버가 명단에서 계산한 한 명 한 명이다. 확정이 안 된 줄은 받는 사람으로 쓰지 않는다
      // 한 줄에 여러 명이 후보로 담겨 와도(user_id 없음) 한 명씩 풀어서 읽는다
      if (!uid && cands.length > 1) {
        for (const x of cands) rows.push({ via, mention, status: "ok", cands: [x], chosen: x.user_id, include: true });
        continue;
      }
      if (!uid && cands.length === 1) uid = cands[0].user_id;
      // 후보에 없는 user_id 는 명단으로 확인되지 않은 사람이라 쓰지 않는다 (후보를 지어내지 않는다)
      if (!uid || !cands.some((x) => x.user_id === uid)) { skipped++; continue; }
      status = "ok";
    } else {
      if (status === "ok" && !cands.some((x) => x.user_id === uid)) status = cands.length ? "pick" : "none";
      if (status === "pick" && !cands.length) status = "none";
    }
    rows.push({ via, mention, status, cands, chosen: status === "ok" ? uid : "", include: true });
  }
  if (rows.length > MAX_ROWS) return { ...base, tooMany: true, card: null, rows: [] };
  if (skipped) warnings.push(t("묶음 지시의 일부 이름을 처리하지 못했어요. 받는 사람을 꼭 확인해 주세요."));
  return { ...base, tooMany: false, card, rows };
}

function needApi(name) {
  if (isDemo) throw Object.assign(new Error("demo"), { code: "demo" });
  if (typeof api[name] !== "function") throw Object.assign(new Error("missing"), { code: "server" });
}

export async function renderAiTask(root, opts = {}) {
  const st = {
    phase: "boot", // boot | deny | input | loading | card | saving | result
    me: null, isTop: false, denyMsg: "", denyRetry: false,
    text: "", busy: false, pinging: false,
    err: null, ping: null,
    res: null, today: "", card: null, rows: [], groupOk: false,
    open: [], openToday: "", showMine: false, mineLoading: false, mineErr: "", cancelling: new Set(),
    payload: null, results: [], preIds: null, batchStart: 0,
    timer: 0, t0: 0, elapsedEl: null, repaint: null,
    sent: [], paintSent: null,
  };
  let shown = null; // 마지막으로 그린 화면
  let dead = false; // 사용자가 이 화면을 떠났다 (탭 이동·뒤로 등). 더는 그리지 않는다
  let seen = false; // root 가 화면에 붙은 적이 있는지 (호스트가 render 가 끝난 뒤에 붙이는 경우를 구분)

  const errText = (e) => {
    // 서버가 상황에 맞게 쓴 한국어 문구(담당 직원 없음·업무 아님·한도 종류 등)는 화면 언어로 바꿔 보여 준다(사전에 없으면 아래 일반 문구)
    if ((e?.code === "bad_input" || e?.code === "limit") && /[가-힣]/.test(str(e?.message))) { const s = serverText(str(e.message)); if (s !== null) return s; }
    const code = own(errKo(), e?.code) ? e.code : "server";
    const fix = own(st.isTop ? fixTop() : fixLead(), code);
    return fix ? `${errKo()[code]} ${fix}` : errKo()[code];
  };
  const hintManual = () => (st.isTop ? t("급하면 AI 없이 [직접 업무지시]로 바로 지시할 수 있어요.") : t("급하면 대표에게 업무를 요청해 주세요."));

  const stopTick = () => { if (st.timer) { clearInterval(st.timer); st.timer = 0; } };
  const startTick = () => {
    stopTick();
    st.t0 = Date.now();
    st.timer = setInterval(() => { if (st.elapsedEl) st.elapsedEl.textContent = t("{n}초", { n: Math.floor((Date.now() - st.t0) / 1000) }); }, 1000);
  };
  // 화면을 떠났는지: 다른 내용이 root 를 차지했거나, 붙어 있던 root 가 화면에서 떨어졌다(탭 전환은 컨테이너째 바뀐다)
  function gone() {
    if (dead) return true;
    let g = false;
    if (shown) {
      if (root.firstChild !== shown) g = true;
      else {
        if (root.isConnected) seen = true;
        g = seen && !root.isConnected;
      }
    }
    if (g) { dead = true; stopTick(); }
    return g;
  }
  const leave = () => { dead = true; stopTick(); opts.onBack?.(); };
  // 일반 업무지시 화면으로: 대표·부대표는 기본 화면(onBack)으로도 갈 수 있고, 매니저·중간관리자는 onManual 이 있을 때만
  const hasManual = () => (st.isTop ? !!(opts.onManual ?? opts.onBack) : !!opts.onManual);
  const manual = () => { const f = opts.onManual ?? opts.onBack; if (f) { dead = true; stopTick(); f(); } };
  const manualBtn = (cls, label = t("직접 업무지시")) => (hasManual() ? h("button", { type: "button", class: cls, onclick: manual }, label) : null);
  const back = () => opts.onBack && h("button", { type: "button", class: "linkbtn back", onclick: leave }, t("← 뒤로"));

  function draw(top = false) {
    if (gone()) return;
    const y = scrollY;
    st.repaint = null;
    let v;
    try { v = view(); } catch (e) {
      console.error(e);
      v = h("div", { class: "page" }, back(), h("p", { class: "err" }, t("화면을 그리지 못했어요. 앱을 다시 열어 주세요.")));
    }
    root.replaceChildren(v);
    shown = v;
    if (root.isConnected) scrollTo(0, top ? 0 : y);
  }

  function view() {
    if (st.phase === "boot") return h("div", { class: "page" }, back(), h("p", { class: "muted" }, t("불러오는 중…")));
    if (st.phase === "deny") return denyView();
    if (st.phase === "loading") return loadingView();
    if (st.phase === "card") return st.res.tooMany ? tooManyView() : cardView();
    if (st.phase === "saving" || st.phase === "result") return resultView();
    return inputView();
  }

  function denyView() {
    return h("div", { class: "page" },
      back(),
      h("h1", null, t("🎙️ 말로 업무지시")),
      h("p", { class: st.denyRetry ? "err" : "muted" }, st.denyMsg),
      st.denyRetry && h("button", { type: "button", class: "btn primary", onclick: start }, t("다시 시도")));
  }

  /* ---------- 화면 이동 ---------- */
  const reedit = () => { if (st.busy) return; st.phase = "input"; st.err = null; draw(true); };
  function again() {
    if (st.busy) return;
    Object.assign(st, { phase: "input", text: "", err: null, ping: null, res: null, card: null, rows: [], groupOk: false, payload: null, results: [] });
    draw(true);
  }

  /* ---------- 1) 문장 쓰기 ---------- */
  function inputView() {
    const example = st.isTop
      ? t("예) 홍길동 매니저한테 거미줄 다시 치우라고 해줘")
      : t("예) 홍길동 주임에게 내일까지 매장 마감 점검해 달라고 해줘");
    const ta = h("textarea", { class: "inp", rows: "3", maxlength: String(MAX_TEXT), placeholder: example, "aria-label": t("업무지시 문장") });
    ta.value = st.text;
    ta.addEventListener("input", (ev) => {
      st.text = ta.value;
      if (ta.value.length >= MAX_TEXT && /paste|drop/i.test(String(ev.inputType))) toast(t("{n}자까지만 들어가요", { n: MAX_TEXT }));
    });
    ta.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); parse(); } });
    const sentBox = h("div", { class: "stack" });
    st.paintSent = () => sentBox.replaceChildren(...sentRows());
    st.paintSent();
    return h("div", { class: "page" },
      back(),
      h("h1", null, t("🎙️ 말로 업무지시")),
      st.err && errBox(),
      ta,
      h("button", { type: "button", class: "btn primary", disabled: st.busy, onclick: parse }, t("지시하기")),
      sentBox,
      h("p", { class: "hint" }, st.isTop ? t("전 직원에게 지시할 수 있어요. 받는 사람이 분명하면 바로 지시돼요.") : t("내 담당 직원에게만 지시할 수 있어요. 받는 사람이 분명하면 바로 지시돼요.")),
      h("p", { class: "hint" }, t("AI 회사(Anthropic)로 가는 정보: 쓴 문장과 직원 이름·직책·사업장 이름뿐이에요.")),
      // 연결 확인은 횟수 제한이 없는 호출이라 서버가 대표·부대표에게만 연다
      st.isTop && h("button", { type: "button", class: "btn ghost slim", disabled: st.busy, onclick: runPing }, st.pinging ? t("확인 중…") : t("연결 확인")),
      st.isTop && st.ping && pingBox(),
      manualBtn("linkbtn", t("AI 없이 직접 업무지시 하기")),
      mineSection());
  }

  /* ---------- 방금 지시한 것 (이 화면을 여는 동안 최근 5건) + 바로 취소 ---------- */
  function sentRows() {
    const out = [];
    for (const e of st.sent) {
      const meta = `${e.due_date ? t("마감 {d}", { d: labelMD(e.due_date) }) : ""}${e.repeat !== "none" ? (e.due_date ? " · " : "") + repLine(e.repeat) : ""}`;
      for (const p of e.people) {
        out.push(h("div", { class: "item col static", style: p.canceled ? "background:var(--soft)" : "" },
          h("b", { style: p.canceled ? "text-decoration:line-through" : "" }, `${p.canceled ? "↩" : "✅"} ${p.t.display_name} · ${e.safety ? "⚠ " : ""}${e.title}`),
          meta && h("span", { class: "muted" }, meta),
          !p.canceled && p.id && h("button", { type: "button", class: "btn ghost slim danger", disabled: !!p.busy, onclick: () => undoOne(p) }, p.busy ? t("취소하는 중…") : t("지시 취소"))));
      }
    }
    return out;
  }

  async function undoOne(p) {
    if (!p?.id || p.busy || p.canceled) return;
    p.busy = true; st.paintSent?.();
    try {
      needApi("tkCancel");
      await withTimeout(api.tkCancel(p.id, st.isTop), 30000);
      p.canceled = true;
      st.open = st.open.filter((x) => x.id !== p.id);
      toast(t("지시를 취소했어요"), 2000);
    } catch (e) {
      toast(plainErrText(e), 4000);
    } finally {
      p.busy = false;
    }
    st.paintSent?.();
  }

  // 보낸 업무의 id 를 열린 업무에서 찾아 [지시 취소]를 켠다 (못 찾으면 버튼만 없다)
  async function attachIds(entry) {
    try { await withTimeout(fetchOpen(), 8000); } catch { return; }
    const uid = st.me?.user_id;
    const used = new Set(st.sent.flatMap((e) => e.people.map((p) => p.id)).filter(Boolean));
    for (const p of entry.people) {
      const m = st.open
        .filter((x) => sameAssignee(x, p.t) && normTitle(x.title) === normTitle(entry.title) && (!uid || x.created_by === uid) && !used.has(x.id))
        .sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)))[0];
      if (m) { p.id = m.id; used.add(m.id); }
    }
    if (!gone()) st.paintSent?.();
  }

  function errBox() {
    return h("div", { class: "banner alert", role: "alert", style: "flex-direction:column;align-items:stretch;gap:6px" },
      h("b", { class: "err" }, t("해석하지 못했어요")),
      h("span", null, st.err.text),
      h("span", { class: "muted" }, hintManual()),
      h("div", { class: "acc-btns" },
        h("button", { type: "button", class: "btn ghost slim", disabled: st.busy, onclick: parse }, t("다시 시도")),
        manualBtn("btn ghost slim")));
  }

  function pingBox() {
    const p = st.ping;
    const steps = pingSteps();
    const allOk = steps.every(([k]) => p.checks[k] === true);
    return h("div", { class: "entry", style: "margin:8px 0" },
      h("b", null, t("연결 확인 결과")),
      steps.map(([k, label]) => h("div", { style: "display:flex;gap:8px;align-items:center" },
        h("span", null, p.checks[k] === true ? "✅" : p.checks[k] === false ? "❌" : "➖"),
        h("span", { class: p.checks[k] === false ? "err" : "" }, label))),
      allOk && h("span", { class: "ok-text" }, t("모두 정상이에요. 바로 쓸 수 있어요.")),
      p.error && h("span", { class: "err" }, p.error),
      p.error && h("span", { class: "muted" }, hintManual()),
      p.model && h("span", { class: "muted" }, t("모델 {m}", { m: p.model })));
  }

  async function runPing() {
    if (st.busy) return;
    st.busy = true; st.pinging = true; st.ping = null; draw();
    try {
      needApi("aiPing");
      const r = await api.aiPing();
      const ck = r && typeof r.checks === "object" && r.checks ? r.checks : {};
      const ok = r?.ok === true;
      const checks = {};
      for (const [k] of pingSteps()) checks[k] = ok ? ck[k] !== false : null;
      st.ping = { checks, error: ok ? "" : errText({ code: "server" }), model: ok ? clip(str(r.model), 60) : "" };
    } catch (e) {
      const step = own(FAIL_STEP, e?.code);
      const checks = {};
      let hit = false;
      for (const [k] of pingSteps()) {
        if (!step) checks[k] = null;
        else if (hit) checks[k] = null;
        else if (k === step) { checks[k] = false; hit = true; } else checks[k] = true;
      }
      st.ping = { checks, error: errText(e), model: "" };
    } finally {
      st.busy = false; st.pinging = false;
    }
    draw();
  }

  /* ---------- 2) 해석 ---------- */
  async function parse() {
    if (st.busy) return;
    const text = st.text.trim();
    if (!text) { toast(t("지시할 내용을 먼저 써 주세요")); return; }
    if (text.length > MAX_TEXT) { toast(t("{n}자까지 쓸 수 있어요", { n: MAX_TEXT })); return; }
    st.busy = true; st.err = null; st.ping = null; st.phase = "loading";
    startTick(); draw(true);
    let ok = false;
    let plan = null;
    try {
      needApi("aiTaskParse");
      const res = fromResponse(await api.aiTaskParse(text));
      Object.assign(st, { res, today: res.today, card: res.card, rows: res.rows, groupOk: false });
      // 받는 사람·업무·날짜가 모두 분명하면 확인 카드 없이 바로 지시한다. 조금이라도 애매하면 카드로 확인받는다
      plan = quickPlan(res, text);
      if (plan) {
        try { await withTimeout(fetchOpen(), 5000); plan.fresh = true; } catch { /* 같은 업무 확인은 못 해도 진행 */ }
        if (plan.targets.some((t) => findDup(t, plan.payload.title))) plan = null; // 같은 업무가 이미 있으면 카드로
      }
      st.phase = "card";
      ok = true;
    } catch (e) {
      st.err = { code: str(e?.code), text: errText(e) };
      st.phase = "input";
    } finally {
      stopTick(); st.busy = false;
    }
    if (plan) { await quickSend(plan); return; }
    draw(true);
    if (ok && !st.res.tooMany) loadOpen();
  }

  // 확인 카드 없이 바로 보내도 되는 경우만 계획을 돌려준다
  function quickPlan(res, text) {
    if (res.tooMany || !res.card || res.warnings.length) return null;
    if (text.length > 150) return null; // 길게 붙여 넣은 글은 항상 카드로 확인
    const c = res.card, today = res.today;
    const title = c.title.trim().slice(0, 60);
    if (!title) return null;
    if (c.repeat !== "none" && !isDate(c.due_date)) return null;
    if (isDate(c.due_date) && (c.due_date < today || c.due_date > addDays(today, 400))) return null;
    if (c.repeat === "monthly" && isDate(c.due_date) && Number(c.due_date.slice(8, 10)) >= 29) return null;
    const rows = res.rows;
    if (!rows.length || rows.length > 5 || rows.some((r) => r.via !== "name" || r.status !== "ok" || !r.chosen)) return null;
    const seen = new Set(), targets = [];
    for (const r of rows) {
      const p = r.cands.find((x) => x.user_id === r.chosen);
      if (!p || seen.has(p.user_id)) return null;
      seen.add(p.user_id);
      targets.push({ user_id: p.user_id, display_name: p.display_name || r.mention, job_title: p.job_title, store_name: p.store_name });
    }
    return { targets, fresh: false, payload: { title, memo: c.memo.trim().slice(0, 200), due_date: isDate(c.due_date) ? c.due_date : null, repeat: c.repeat, safety: false } };
  }

  async function quickSend(plan) {
    if (gone()) { toast(t("화면을 떠나서 지시하지 않았어요"), 3500); return; }
    const { targets, payload } = plan;
    st.busy = true;
    st.payload = payload;
    st.preIds = plan.fresh ? new Set(st.open.filter((x) => normTitle(x.title) === normTitle(payload.title)).map((x) => x.id)) : null;
    st.batchStart = Date.now();
    st.results = targets.map((t) => ({ t, state: "wait", note: "", tried: false }));
    st.phase = "saving";
    draw(true);
    let out = "ok";
    try { out = await runSend(st.results); } finally { st.busy = false; }
    // 안전 관련 되묻기에서 '돌아가기': 아무것도 저장되지 않았다. 확인 카드로 가서 사람이 고르게 한다
    if (out === "cancel") { Object.assign(st, { phase: "card", results: [], payload: null, preIds: null }); draw(true); loadOpen(); return; }
    if (st.results.some((r) => r.state === "fail")) { st.phase = "result"; draw(true); finishNote(); refreshQuiet(); return; }
    // 모두 보냈으면 입력 화면으로 돌아가 한 줄 기록만 남긴다
    const entry = { title: payload.title, due_date: payload.due_date, repeat: payload.repeat, safety: st.payload?.safety === true, people: st.results.map((r) => ({ t: r.t, id: null, canceled: false, busy: false })) };
    st.sent.unshift(entry);
    st.sent.length = Math.min(st.sent.length, 5);
    Object.assign(st, { phase: "input", text: "", err: null, res: null, card: null, rows: [], groupOk: false, payload: null, results: [] });
    draw(true);
    finishNote();
    attachIds(entry);
  }

  // 열린 업무 목록(내가 볼 수 있는 범위). 같은 업무 경고와 '내가 지시한 업무'에 쓴다
  async function fetchOpen() {
    needApi("tkAll");
    const d = await api.tkAll(st.isTop);
    st.open = Array.isArray(d?.open) ? d.open : [];
    st.openToday = isDate(d?.today) ? d.today : todayKST();
  }

  async function loadOpen() {
    if (gone()) return;
    const token = st.res;
    try {
      await fetchOpen();
      if (st.res !== token || gone()) return;
      if (st.phase === "card") st.repaint?.();
    } catch { /* 경고용이라 실패해도 괜찮아요 */ }
  }

  const findDup = (target, title) => {
    const t = normTitle(title);
    return t ? st.open.find((x) => sameAssignee(x, target) && normTitle(x.title) === t) ?? null : null;
  };

  function loadingView() {
    const el = h("span", null, t("{n}초", { n: 0 }));
    st.elapsedEl = el;
    return h("div", { class: "page" },
      back(),
      h("h1", null, t("해석하는 중…")),
      h("div", { class: "card" },
        h("div", { style: "white-space:pre-wrap;word-break:break-word" }, clip(st.text.trim(), 200)),
        h("p", { class: "muted", style: "margin:0" }, t("AI가 문장을 읽고 있어요. 보통 5~20초 걸리고, 최대 40초까지 기다려요.") + " ", el)));
  }

  function tooManyView() {
    const res = st.res;
    return h("div", { class: "page" },
      h("button", { type: "button", class: "linkbtn back", onclick: reedit }, t("← 문장 고치기")),
      h("h1", null, t("받는 사람이 너무 많아요")),
      h("div", { class: "card" },
        h("p", { class: "err", style: "margin:0;font-weight:700" }, t("한 번에 지시할 수 있는 사람은 20명까지예요. 사업장이나 직책으로 범위를 좁혀서 다시 써 주세요.")),
        res.warnings.map((w) => h("span", { class: "err" }, "⚠ " + warnText(w)))),
      h("button", { type: "button", class: "btn primary", onclick: reedit }, t("문장 고쳐 쓰기")),
      manualBtn("linkbtn", t("AI 없이 직접 업무지시 하기")));
  }

  /* ---------- 3) 확인 카드 ---------- */
  const targetList = () => {
    const seen = new Set(), out = [];
    for (const r of st.rows) {
      if (!r.include || !r.chosen || seen.has(r.chosen)) continue;
      const p = chosenOf(r);
      if (!p) continue;
      seen.add(r.chosen);
      out.push({ user_id: p.user_id, display_name: p.display_name || r.mention, job_title: p.job_title, store_name: p.store_name });
    }
    return out;
  };

  // [지시하기]를 열어도 되는지와, 안 되면 이유
  function gate() {
    const c = st.card;
    const live = st.rows.filter((r) => r.include);
    const nNone = live.filter((r) => r.status === "none").length;
    const nPick = live.filter((r) => r.status === "pick" && !r.chosen).length;
    const hasGroup = live.some((r) => r.via === "group"); // 서버의 needs_group_confirm 과 상관없이 묶음이면 항상 확인을 받는다
    const targets = targetList();
    let reason = "";
    if (!c.title.trim()) reason = t("업무 내용을 입력해 주세요");
    else if (c.repeat !== "none" && !isDate(c.due_date)) reason = t("반복 업무는 마감일(첫 마감일)이 필요해요");
    else if (nNone > 0) reason = st.isTop ? t("찾지 못한 담당자 {n}곳을 빼거나, 문장을 고쳐 주세요", { n: nNone }) : t("내 담당이 아닌 담당자 {n}곳을 빼거나, 문장을 고쳐 주세요", { n: nNone });
    else if (nPick > 0) reason = t("담당자를 골라 주세요 ({n}곳)", { n: nPick });
    else if (hasGroup && !st.groupOk) reason = t("받는 사람 이름을 확인하고 체크해 주세요");
    else if (!targets.length) reason = t("담당자를 한 명 이상 남겨 주세요");
    return { ok: !reason, reason, n: targets.length };
  }

  function cardView() {
    const c = st.card, res = st.res, today = st.today;
    const curDue = () => (isDate(c.due_date) ? c.due_date : "");

    const title = h("input", { type: "text", class: "inp", maxlength: "60", placeholder: t("업무 내용"), "aria-label": t("업무 내용") });
    title.value = c.title;
    const memo = h("textarea", { class: "inp", rows: "2", maxlength: "200", placeholder: t("자세한 설명 (선택)"), "aria-label": t("메모") });
    memo.value = c.memo;
    const due = h("input", { type: "date", class: "inp", "aria-label": t("마감일") });
    due.value = curDue();

    const dateBig = h("div", { style: "font-size:2.1rem;font-weight:800;line-height:1.15" });
    const dateSub = h("div", { class: "muted" });
    const dueWarn = h("div", { class: "stack", style: "gap:4px" });
    const repBox = h("div");
    // 안전 관련(자동 번역 안 함): 켜면 번역 없이 한국어 원문만 간다. 끄고 보내도 서버가 안전 관련 말을 찾으면 저장 전에 한 번 되묻는다
    const safeBox = h("div", { class: "stack" });
    const paintSafe = () => safeBox.replaceChildren(
      bigToggle(t("안전 관련 (자동 번역 안 함)"), !!c.safety, (v) => { c.safety = v; paintSafe(); }),
      h("p", { class: "hint", style: "margin:0" }, t("락스 희석 비율·보관 온도처럼 틀리면 위험한 내용이면 켜 주세요. 번역하지 않고 한국어로만 보내요.")));
    const whoTitle = h("h2", { style: "margin:0" }, t("담당자"));
    const whoBox = h("div", { class: "stack" });
    const why = h("p", { class: "hint", style: "margin:0 0 4px" });
    const submitBtn = h("button", { type: "button", class: "btn primary", onclick: submit }, t("지시하기"));

    const dueWarnings = () => {
      const d = curDue(), w = [];
      if (c.repeat !== "none" && !d) w.push({ bad: true, text: t("반복 업무는 첫 마감일이 필요해요. 마감일을 골라 주세요.") });
      if (d && d < today) w.push({ bad: true, text: t("지난 날짜예요. 날짜를 확인해 주세요.") });
      if (d && d > addDays(today, 400)) w.push({ bad: true, text: t("1년이 넘게 먼 날짜예요. 날짜를 확인해 주세요.") });
      if (d && c.repeat === "monthly" && Number(d.slice(8, 10)) >= 29) w.push({ bad: false, text: t("매달 29~31일 반복은 다음 달부터 30일, 2월 이후엔 28일로 굳어져요. 월말 업무는 28일 이하로 정하거나 매달 직접 지시해 주세요.") });
      return w;
    };

    const paintDate = () => {
      const d = curDue();
      dateBig.textContent = d ? labelMD(d) : t("마감일 없음");
      dateBig.style.color = d ? "" : "var(--muted)";
      dateSub.textContent = d ? t("{rel} · 오늘은 {d}", { rel: relDay(d, today), d: labelMD(today) }) : "";
      dueWarn.replaceChildren(...dueWarnings().map((w) => h("div", { style: `color:var(--${w.bad ? "bad" : "warn"});font-size:.85rem;font-weight:600` }, "⚠ " + w.text)));
    };
    const paintRep = () => repBox.replaceChildren(seg(repeatOpts(), c.repeat, (v) => { c.repeat = v; paintRep(); paintDate(); paintSubmit(); }));
    const paintSubmit = () => {
      const g = gate();
      submitBtn.disabled = !g.ok || st.busy;
      submitBtn.textContent = st.busy ? t("처리 중…") : g.n > 0 ? t("지시하기 ({n}명)", { n: g.n }) : t("지시하기");
      why.textContent = g.ok ? (c.repeat !== "none" || g.n >= 4 ? t("누르면 한 번 더 확인 창이 떠요.") : "") : g.reason;
      why.style.color = g.ok ? "" : "var(--bad)";
    };

    // 묶음 지시의 받는 사람이 바뀌면 '모두 확인했어요' 체크는 다시 받는다
    const setInc = (r, on) => { r.include = on; if (r.via === "group") st.groupOk = false; paintWho(); };
    const removedRow = (r) => h("div", { class: "entry", style: "background:var(--soft);flex-direction:row;align-items:center;justify-content:space-between" },
      h("span", { class: "muted" }, t("{who} — 뺐어요", { who: rowLabel(r) })),
      h("button", { type: "button", class: "linkbtn", style: lang() === "ko" ? null : "white-space:nowrap;flex:none", onclick: () => setInc(r, true) }, t("다시 넣기")));
    const dropBtn = (r) => h("button", { type: "button", class: "linkbtn", style: "white-space:nowrap", onclick: () => setInc(r, false) }, t("빼기"));
    const dupNote = (p) => (p && findDup(p, c.title) ? h("div", { style: "color:var(--warn);font-size:.85rem;font-weight:600;margin-top:2px" }, t("⚠ 이미 같은 업무가 진행 중이에요 (그래도 지시할 수 있어요)")) : null);

    const nameRow = (r) => {
      if (!r.include) return removedRow(r);
      if (r.status === "ok") {
        const p = chosenOf(r);
        if (!p) return removedRow(r);
        return h("div", null,
          bigToggle(personLine(p), true, () => setInc(r, false)),
          r.mention && r.mention !== p.display_name && h("div", { class: "hint", style: "margin-top:2px" }, t("문장에 쓴 말: ‘{m}’", { m: r.mention })),
          dupNote(p));
      }
      if (r.status === "pick") {
        const sel = h("select", { class: "inp", "aria-label": t("‘{m}’ 담당자 고르기", { m: r.mention }) },
          h("option", { value: "", selected: !r.chosen }, t("누구인지 골라 주세요")),
          r.cands.map((x) => h("option", { value: x.user_id, selected: r.chosen === x.user_id }, personLine(x))));
        sel.addEventListener("change", () => { r.chosen = sel.value; paintWho(); });
        return h("div", { class: "entry", style: `border-color:${r.chosen ? "var(--ok)" : "var(--warn)"}` },
          h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px" },
            h("b", null, t("‘{m}’ 은(는) 누구인가요?", { m: r.mention })), dropBtn(r)),
          sel,
          r.chosen ? dupNote(chosenOf(r)) : h("span", { class: "hint" }, t("이름이 비슷한 사람이 여럿이라 직접 골라야 해요.")));
      }
      return h("div", { class: "entry", style: "border-color:var(--bad);background:var(--bad-bg)" },
        h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px" },
          h("b", { class: "err" }, st.isTop ? t("‘{m}’ — 찾지 못했어요", { m: r.mention }) : t("‘{m}’ — 내 담당 직원이 아니에요", { m: r.mention })), dropBtn(r)),
        h("span", { class: "hint" }, st.isTop
          ? t("이름이 틀렸거나, 직원·매니저·중간관리자 명단에 없는 사람이에요. 이 사람을 빼거나 문장을 고쳐서 다시 해석해 주세요.")
          : t("내 담당 직원에게만 지시할 수 있어요. 이름이 틀렸거나 담당이 아닌 사람이에요. 빼거나 문장을 고쳐서 다시 해석해 주세요. 다른 직원에게 시킬 일은 대표에게 요청해 주세요.")));
    };

    const groupBlocks = (groups) => {
      const labels = [...new Set(groups.map((r) => r.mention))];
      const out = labels.map((lab) => {
        const mem = groups.filter((r) => r.mention === lab);
        return h("div", { class: "entry" },
          h("b", null, t("‘{m}’ → {n}명", { m: lab, n: mem.filter((r) => r.include).length })),
          mem.map((r) => (r.include
            ? h("div", null, bigToggle(rowLabel(r), true, () => setInc(r, false)), dupNote(chosenOf(r)))
            : removedRow(r))));
      });
      const live = groups.filter((r) => r.include);
      if (live.length) out.push(bigToggle(t("위 {n}명이 맞아요 (받는 사람을 모두 확인했어요)", { n: live.length }), st.groupOk, (v) => { st.groupOk = v; paintWho(); }));
      return out;
    };

    const paintWho = () => {
      whoTitle.textContent = t("담당자 {n}명", { n: targetList().length });
      const out = [];
      if (!st.rows.length) out.push(h("p", { class: "err", style: "margin:0" }, t("문장에서 지시할 사람을 찾지 못했어요. [문장 고쳐 쓰기]로 이름을 적어 주세요.")));
      for (const r of st.rows) if (r.via === "name") out.push(nameRow(r));
      const groups = st.rows.filter((r) => r.via === "group");
      if (groups.length) out.push(...groupBlocks(groups));
      whoBox.replaceChildren(...out);
      paintSubmit();
    };

    title.addEventListener("input", () => { c.title = title.value; paintSubmit(); });
    title.addEventListener("change", () => paintWho()); // 같은 업무 경고 갱신
    memo.addEventListener("input", () => { c.memo = memo.value; });
    const onDue = () => { c.due_date = due.value || null; paintDate(); paintSubmit(); };
    due.addEventListener("input", onDue);
    due.addEventListener("change", onDue);

    // 저장: 확인 → 사람마다 순서대로 기존 업무지시 호출
    async function submit() {
      if (st.busy) return;
      const g = gate();
      if (!g.ok) { toast(g.reason); return; }
      // 카드에 보이는 그대로를 담아 둔다. 확인하는 사이 카드가 바뀌면 보내지 않는다
      const snap = () => {
        const targets = targetList();
        const payload = { title: c.title.trim().slice(0, 60), memo: c.memo.trim().slice(0, 200), due_date: curDue() || null, repeat: c.repeat, safety: !!c.safety };
        return { targets, payload, sig: JSON.stringify([payload, targets.map((t) => t.user_id)]) };
      };
      const first = snap();
      st.busy = true; paintSubmit();
      let started = false, cancelled = false;
      try {
        // 최신 열린 업무로 같은 업무 경고를 다시 계산. 6초 안에 못 읽으면 지난 목록으로 계속한다
        let fresh = false;
        try { await withTimeout(fetchOpen(), 6000); fresh = true; } catch { /* 경고용이라 실패해도 괜찮아요 */ }
        if (gone()) { toast(t("화면을 떠나서 지시하지 않았어요"), 3500); return; }
        const now = snap();
        if (now.sig !== first.sig || !gate().ok) { toast(t("내용이 바뀌어서 지시하지 않았어요. 다시 확인해 주세요"), 4000); return; }
        const { targets, payload } = now;
        const dups = targets.filter((t) => findDup(t, payload.title));
        if (targets.length >= 4 || payload.repeat !== "none" || dups.length > 0) {
          const items = [
            t("업무: {title}", { title: payload.title }),
            t("마감: {d}", { d: payload.due_date ? labelMD(payload.due_date) : tx("마감", "없음") }) + (payload.repeat !== "none" ? ` · ${repLine(payload.repeat)}` : ""),
            t("담당 {n}명: {names}", { n: targets.length, names: targets.map((t) => t.display_name).join(", ") }),
          ];
          if (payload.repeat !== "none") items.push(t("반복 업무는 완료할 때마다 다음 차례가 자동으로 생겨요."));
          if (payload.repeat === "monthly" && payload.due_date && Number(payload.due_date.slice(8, 10)) >= 29) items.push(t("매달 29~31일 반복은 짧은 달을 지나면 날짜가 28~30일로 굳어져요."));
          if (dups.length) items.push(t("이미 같은 업무가 진행 중: {names}", { names: dups.map((t) => t.display_name).join(", ") }));
          if (payload.safety) items.push(t("안전 관련: 번역하지 않고 한국어로만 보내요"));
          if (!(await confirmDialog(t("이대로 지시할까요?"), items, t("돌아가기"), t("지시하기")))) return;
        }
        started = true;
        st.payload = payload;
        // 다시 보낼 때 '이번 지시에서 만들어진 업무'만 가려내려고, 보내기 전에 이미 있던 같은 제목 업무의 id 를 적어 둔다
        st.preIds = fresh ? new Set(st.open.filter((x) => normTitle(x.title) === normTitle(payload.title)).map((x) => x.id)) : null;
        st.batchStart = Date.now();
        st.results = targets.map((t) => ({ t, state: "wait", note: "", tried: false }));
        st.phase = "saving";
        draw(true);
        cancelled = (await runSend(st.results)) === "cancel"; // 안전 관련 되묻기에서 '돌아가기'면 아무것도 저장되지 않았다
      } catch (e) {
        console.error(e);
        if (!started) toast(t("지시를 준비하다 문제가 생겼어요. 다시 눌러 주세요"), 4000);
      } finally {
        st.busy = false;
        if (cancelled) { Object.assign(st, { phase: "card", results: [], payload: null, preIds: null }); draw(true); } // 카드 그대로 돌아가 사람이 고르게 한다
        else if (started) { st.phase = "result"; draw(true); finishNote(); refreshQuiet(); } else if (!gone()) st.repaint?.(); // 새로 읽은 목록으로 경고를 다시 그리고 버튼을 푼다
      }
    }

    st.repaint = paintWho;
    paintDate();
    paintRep();
    paintSafe();
    paintWho();

    return h("div", { class: "page" },
      h("button", { type: "button", class: "linkbtn back", onclick: reedit }, t("← 문장 고치기")),
      h("h1", null, t("확인 카드")),
      h("section", { class: "card sub" },
        h("h3", null, t("AI가 이렇게 이해했어요")),
        h("p", { style: "margin:0;font-weight:600" }, res.understood || t("(설명이 없어요)")),
        h("p", { class: "hint", style: "white-space:pre-wrap;word-break:break-word" }, t("내가 쓴 말: {text}", { text: clip(st.text.trim(), 200) })),
        h("p", { class: "hint" }, t("AI는 틀릴 수 있어요. 담당자·날짜·반복을 눈으로 확인하고 [지시하기]를 눌러야 저장돼요."))),
      res.warnings.length > 0 && h("div", { class: "banner alert", role: "alert", style: "flex-direction:column;align-items:stretch;gap:4px" },
        h("b", { class: "err" }, t("해석할 때 알려 준 점")),
        res.warnings.map((w) => h("span", { class: "err" }, "⚠ " + warnText(w)))),
      h("section", { class: "card" },
        h("label", { class: "lbl" }, tx("AI지시", "업무")), title,
        h("label", { class: "lbl" }, t("메모 (선택)")), memo,
        h("label", { class: "lbl" }, t("마감일")),
        h("div", { style: "display:flex;align-items:baseline;gap:10px;flex-wrap:wrap" }, dateBig, dateSub),
        h("div", { class: "row2" }, due,
          h("button", { type: "button", class: "linkbtn", style: "white-space:nowrap;flex:none", onclick: () => { due.value = ""; onDue(); } }, tx("마감일", "지우기"))),
        dueWarn,
        h("label", { class: "lbl" }, t("반복")), repBox, safeBox),
      h("section", { class: "card" },
        whoTitle,
        !st.isTop && h("p", { class: "hint", style: "margin:0" }, t("내 담당 직원 중에서만 찾았어요.")),
        whoBox),
      h("button", { type: "button", class: "btn ghost slim", onclick: reedit }, t("문장 고쳐 쓰기")),
      h("button", { type: "button", class: "btn ghost slim", onclick: again }, t("지시하지 않고 처음으로")),
      h("div", { class: "actions" }, why, submitBtn));
  }

  /* ---------- 4) 저장과 결과 ---------- */
  // 앞서 보낸 요청이 끊겼을 수 있어서, 같은 담당자 + 같은 제목으로 '이번 지시 중에' 내가 만든 열린 업무가 이미 있는지 본다
  // 이번 지시 전에 있던 같은 업무(preIds)는 세지 않는다. 목록을 못 읽어 preIds 가 없으면 보낸 시각(2분 여유)으로 가른다
  async function createdToday(target, title) {
    needApi("tkAll");
    const d = await withTimeout(api.tkAll(st.isTop), 10000);
    const today = isDate(d?.today) ? d.today : todayKST();
    const uid = st.me?.user_id;
    const list = Array.isArray(d?.open) ? d.open : [];
    return list.some((x) => sameAssignee(x, target) && normTitle(x.title) === normTitle(title)
      && (!uid || x.created_by === uid) && typeof x.created_at === "string" && dateOf(x.created_at) === today
      && (st.preIds ? !st.preIds.has(x.id) : Date.parse(x.created_at) >= st.batchStart - 120000));
  }

  async function sendOne(r) {
    const p = st.payload;
    if (r.tried) {
      try {
        if (await createdToday(r.t, p.title)) { r.state = "ok"; r.note = t("이미 만들어져 있어서 다시 보내지 않았어요"); return; }
      } catch {
        r.state = "fail"; r.note = t("이미 만들어졌는지 확인하지 못했어요. 아래 [내가 지시한 업무]를 본 뒤 다시 보내 주세요"); return;
      }
    }
    r.tried = true;
    try {
      needApi("tkCreate");
      // 30초 안에 답이 없으면 실패로 둔다. 이미 만들어졌을 수 있어서 다시 보낼 때는 먼저 만들어졌는지 확인한다
      // (서버는 번역을 14초 안에 끝내고, 같은 글을 여러 명에게 보낼 때는 첫 사람 뒤로 번역을 다시 하지 않아 — 실패한 글도 3분 동안은 다시 부르지 않는다 — 30초면 충분하다)
      // 안전 관련(p.safety)이면 서버가 번역하지 않는다. 사람이 '아니요, 번역해서 보내기'를 골랐으면(p.ack) 감지어가 있어도 그대로 저장한다
      const res = await withTimeout(api.tkCreate({ title: p.title, memo: p.memo, assignee_id: r.t.user_id, due_date: p.due_date, repeat: p.repeat, ...(p.safety ? { safety: true } : {}), ...(p.ack ? { safety_ack: true } : {}) }, st.isTop), 30000);
      if (isSafetyAsk(res)) { r.state = "ask"; r.words = res.words; r.tried = false; return; } // 서버가 안전 관련 말을 찾았다: 아무것도 저장되지 않았다
      r.state = "ok"; r.note = "";
    } catch (e) {
      r.state = "fail"; r.note = saveErrText(e);
    }
  }

  // 한 사람씩 차례로 보낸다. 안전 관련 말이 있으면 서버가 저장 전에 되묻는다 → 거기서 반복을 멈추고 사람에게 한 번만 묻는다.
  // '안전 관련으로 보내기'·'아니요, 번역해서 보내기'를 고르면 같은 플래그로 그 사람부터 전원에게 보낸다. '돌아가기'면 아무것도 보내지 않고 "cancel"
  async function runSend(list) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      r.state = "doing"; draw();
      await sendOne(r);
      if (r.state === "ask") {
        const pick = await askSafety(r.words);
        if (!pick) {
          for (const x of list.slice(i)) { x.state = "fail"; x.note = t("안전 관련인지 확인하지 않아 보내지 않았어요"); }
          draw();
          return "cancel";
        }
        st.payload = { ...st.payload, ...(pick === "safe" ? { safety: true } : { ack: true }) };
        r.state = "doing"; draw();
        await sendOne(r);
        if (r.state === "ask") { r.state = "fail"; r.note = t("저장하지 못했어요"); } // 플래그를 붙였는데도 되묻는 일은 없다(방어)
      }
      draw();
    }
    return "ok";
  }

  async function retry(list) {
    if (st.busy || !list.length) return;
    const y = scrollY; // 보내는 동안 화면이 잠깐 짧아져 위치가 눌리므로, 끝나면 누른 자리로 되돌린다
    st.busy = true;
    st.phase = "saving";
    for (const r of list) { r.state = "wait"; r.note = ""; }
    draw();
    try { await runSend(list); } finally { st.busy = false; st.phase = "result"; draw(); if (!gone() && root.isConnected) scrollTo(0, y); finishNote(); refreshQuiet(); }
  }

  // 보내는 도중 사용자가 다른 화면으로 가 버렸다면 결과를 짧게 알려 준다
  function finishNote() {
    if (!gone()) return;
    const okN = st.results.filter((r) => r.state === "ok").length;
    const failN = st.results.filter((r) => r.state === "fail").length;
    toast(failN ? t("업무지시: {ok}명 완료, {fail}명 실패했어요. 업무지시 화면에서 확인해 주세요", { ok: okN, fail: failN }) : t("업무지시: {n}명에게 보냈어요", { n: okN }), 5000);
  }

  function resultView() {
    const saving = st.phase === "saving";
    const list = st.results, p = st.payload;
    const okN = list.filter((r) => r.state === "ok").length;
    const failed = list.filter((r) => r.state === "fail");
    const mark = { ok: "✅", fail: "❌", doing: "⏳", wait: "⏸", ask: "⏸" };
    return h("div", { class: "page" },
      !saving && back(),
      h("h1", null, saving ? t("지시하는 중…") : failed.length ? t("일부만 지시됐어요") : t("지시했어요 ✅")),
      h("p", { class: !saving && failed.length ? "err" : "muted" },
        saving ? t("한 사람씩 차례로 보내고 있어요. 이 화면을 닫지 말아 주세요.")
          : failed.length ? t("{ok}명은 완료, {fail}명은 실패했어요. 실패한 사람만 다시 보낼 수 있어요.", { ok: okN, fail: failed.length })
            : t("{n}명에게 지시했어요. 담당자 폰에 알림이 가요.", { n: okN })),
      h("section", { class: "card sub" },
        h("h3", null, p.title),
        h("span", { class: "muted" }, `${p.due_date ? t("마감 {d}", { d: labelMD(p.due_date) }) : t("마감 없음")}${p.repeat !== "none" ? " · " + repLine(p.repeat) : ""}`),
        p.safety && h("span", { class: "muted" }, "⚠ " + t("안전 관련으로 보냈어요 (번역 없이 한국어로만 가요)"))),
      h("div", { class: "list" }, list.map((r) => h("div", { class: "item col static", style: r.state === "fail" ? "border-color:var(--bad)" : "" },
        h("b", null, `${mark[r.state] ?? ""} ${personLine(r.t)}`),
        r.note && h("span", { class: r.state === "fail" ? "err" : "ok-text" }, r.note),
        !saving && r.state === "fail" && h("button", { type: "button", class: "btn ghost slim", disabled: st.busy, onclick: () => retry([r]) }, t("이 사람만 다시 보내기"))))),
      !saving && failed.length > 1 && h("button", { type: "button", class: "btn primary", disabled: st.busy, onclick: () => retry(failed) }, t("실패한 {n}명 모두 다시 보내기", { n: failed.length })),
      !saving && failed.length > 0 && h("p", { class: "muted" }, hintManual()),
      !saving && h("button", { type: "button", class: "btn ghost", onclick: again }, t("새 업무 지시하기")),
      !saving && failed.length > 0 && manualBtn("linkbtn", t("직접 업무지시 화면으로")),
      !saving && mineSection());
  }

  /* ---------- 내가 지시한 업무 (열린 업무 + 지시 취소) ---------- */
  // 대표·부대표는 전체 열린 업무가 오므로 내가 만든 것만 추린다. 매니저·중간관리자는 서버가 이미 내가 만든 것만 준다
  const myOpen = () => {
    const uid = st.me?.user_id;
    const list = uid ? st.open.filter((x) => x.created_by === uid) : st.open;
    return [...list].sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)));
  };

  async function loadMine() {
    st.mineLoading = true; st.mineErr = ""; draw();
    try { await withTimeout(fetchOpen(), 15000); } catch (e) { st.mineErr = plainErrText(e); }
    st.mineLoading = false;
    draw();
  }

  function toggleMine() {
    if (st.mineLoading) return;
    st.showMine = !st.showMine;
    if (st.showMine) loadMine(); else draw();
  }

  // 지시를 보낸 뒤나 취소한 뒤 목록을 조용히 다시 읽는다
  async function refreshQuiet() {
    if (gone()) return;
    try { await fetchOpen(); } catch { /* 목록 갱신 실패는 넘어가요 */ }
    if (st.phase === "result" || (st.phase === "input" && st.showMine)) draw();
  }

  async function cancelTask(tk) {
    const id = tk?.id;
    if (!id || st.cancelling.has(id)) return;
    st.cancelling.add(id);
    try {
      const yes = await confirmDialog(t("이 지시를 취소할까요?"), [t("업무: {title}", { title: tk.title }), t("담당: {name}", { name: tk.assignee_name || t("(삭제된 계정)") }), t("이미 간 알림은 거둘 수 없어요.")], t("돌아가기"), t("지시 취소"));
      if (!yes) return;
      draw();
      needApi("tkCancel");
      await withTimeout(api.tkCancel(id, st.isTop), 30000);
      st.open = st.open.filter((x) => x.id !== id);
      toast(t("지시를 취소했어요"), 2000);
    } catch (e) {
      toast(plainErrText(e), 4000);
    } finally {
      st.cancelling.delete(id);
    }
    draw();
    refreshQuiet();
  }

  function mineRow(tk) {
    const today = st.openToday || todayKST();
    const late = isDate(tk.due_date) && tk.due_date < today;
    const rep = tk.repeat && tk.repeat !== "none" ? (own(repeatLabels(), tk.repeat) ?? "") : "";
    const doing = st.cancelling.has(tk.id);
    return h("div", { class: "item col static" },
      h("b", null, tk.title, late && h("span", { class: "badge bad", style: "margin-left:6px" }, t("밀림")), isSafety(tk) && h("span", { class: "badge bad", style: "margin-left:6px" }, t("⚠ 안전 업무"))),
      h("span", { class: "muted" }, `${t("담당 {name}", { name: tk.assignee_name || t("(삭제된 계정)") })} · ${isDate(tk.due_date) ? t("마감 {d}", { d: labelMD(tk.due_date) }) : t("마감 없음")}${rep ? " · " + t("{rep} 반복", { rep }) : ""}`),
      h("button", { type: "button", class: "btn ghost slim danger", disabled: doing || st.busy, onclick: () => cancelTask(tk) }, doing ? t("취소하는 중…") : t("지시 취소")));
  }

  function mineSection() {
    const list = myOpen();
    let body = null;
    if (st.showMine) {
      if (st.mineLoading) body = h("p", { class: "muted", style: "margin:0" }, t("불러오는 중…"));
      else if (st.mineErr) body = h("p", { class: "err", style: "margin:0" }, t("불러오지 못했어요: {e}", { e: st.mineErr }));
      else if (!list.length) body = h("p", { class: "muted", style: "margin:0" }, t("진행 중인 업무가 없어요"));
      else body = h("div", { class: "list" },
        list.slice(0, MAX_MINE).map(mineRow),
        list.length > MAX_MINE && h("p", { class: "muted", style: "margin:0" }, t("최근 {n}건만 보여요 (전체 {total}건)", { n: MAX_MINE, total: list.length })));
    }
    return h("section", { class: "card" },
      h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px" },
        h("h2", { style: "margin:0;font-size:1.05rem" }, t("내가 지시한 업무"), st.showMine && !st.mineLoading && !st.mineErr ? ` (${list.length})` : ""),
        h("button", { type: "button", class: "btn ghost slim", style: "width:auto;margin:0;padding:0 16px", disabled: st.mineLoading, onclick: toggleMine }, st.showMine ? tx("내가 지시한 업무", "접기") : t("보기"))),
      body);
  }

  /* ---------- 시작: 쓸 수 있는 역할만 ---------- */
  async function start() {
    st.phase = "boot"; st.denyMsg = ""; st.denyRetry = false;
    draw();
    let prof = opts.profile ?? null;
    if (!prof?.role || (!prof.user_id && !isDemo)) {
      try { prof = (await api.getProfile()) ?? prof; } catch { /* 아래에서 처리 */ }
    }
    if (!prof?.role) {
      Object.assign(st, { phase: "deny", denyMsg: t("계정 정보를 불러오지 못했어요. 인터넷 상태를 확인하고 다시 시도해 주세요."), denyRetry: true });
      draw();
      return;
    }
    st.me = prof;
    st.isTop = TOP_ROLES.includes(prof.role);
    const allowed = st.isTop || LEAD_ROLES.includes(prof.role);
    if (allowed) st.phase = "input";
    else Object.assign(st, { phase: "deny", denyMsg: t("이 기능은 대표·부대표·매니저·중간관리자만 쓸 수 있어요."), denyRetry: false });
    draw();
  }

  await start();
}
