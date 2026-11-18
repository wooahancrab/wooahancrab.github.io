// 직원 인사 현황(4단계, 대표·회장·부대표): 직원별 출근율·보건증·4대보험·급여·근로계약서를 한 화면에서 보고 고친다. 설계: 기획/4단계_인사현황_설계.md 7절
// 서버·데모 모두 api.hr() 한 개를 통해서만 부른다(lib/hr-api.js · lib/hr-demo.js). 진짜 방어는 서버(RLS)이고 이 화면의 역할 확인은 편의일 뿐이다.
// 개인정보 약속(설계 9절): 급여 금액은 "보기"를 눌렀을 때만 그 사람 것을 받아 화면·메모리에 두고, 숨기기·30초 뒤·화면이 가려질 때·화면을 떠날 때 지운다.
//   브라우저 저장 공간·주소(URL)·콘솔·토스트·aria 문구에 급여·보험 값을 쓰지 않는다. 합계·내보내기·복사·공유·인쇄는 없다. 사용자가 쓴 글(이름·직책·파일 이름)은 글자(textContent)로만 넣는다.
// 화면 위치 유지: 기간을 바꾸거나 저장한 뒤 목록을 다시 그려도 보던 자리를 그대로 둔다(CLAUDE.md).
// 사용: renderHr(자리 요소, { profile, onBack }) → { ready(첫 불러오기), reload(), dispose() }. 자리 요소가 화면에서 사라지면(로그아웃·다른 화면으로 이동) 스스로 정리한다.
import { api, isDemo } from "../lib/api.js";
import { h, toast } from "../lib/ui.js";
import { t, tx } from "../lib/i18n.js";
import { todayKST, dateOf, fmtHM } from "../lib/kst.js";
import { titleRole } from "./owner.js";
import {
  canManageHr, HR_PERIODS, HR_FILTERS, HR_FILE_LIMIT, HR_FILE_EXT, HR_DATE_MIN, HR_DATE_MAX, hrTune,
  healthBadge, badgeText, contractBadge, rateBadge, matchFilter, countFilters, groupByStore,
  fmtWon, parseWon, payProblem, payTooSmall, hrErrText, hrLog, checkHrFile, fmtSize, isDateStr, dateInRange,
} from "../lib/hr.js";

const KIND_ICON = { restaurant: "🦀", ck: "🏭", hq: "🏢" };
const PERIOD_LABEL = { this_month: "이번 달", last_month: "지난 달", last_3_months: "최근 3개월" };
const FILTER_LABEL = { soon: "보건증 30일 이내 {n}명", expired: "보건증 만료 {n}명", no_contract: "계약서 없음·미확인 {n}명", ins_unknown: "4대보험 미확인 {n}명", unset: "보건증 미등록 {n}명" };
const INS_LIST = [["pension", "국민연금"], ["health", "건강보험"], ["employment", "고용보험"], ["accident", "산재보험"]];
const INS_CLS = { enrolled: "ok", not_enrolled: "warn", unknown: "" };
const moneyType = (ty) => ty === "monthly" || ty === "hourly";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 서버 시각(ISO) → 한국시간 "YYYY-MM-DD HH:mm" / "YYYY-MM-DD". 이상한 값이면 빈 글자(예외를 던지지 않는다)
const kstStamp = (iso) => (Number.isFinite(Date.parse(iso)) ? `${dateOf(iso)} ${fmtHM(iso)}` : "");
const kstDate = (iso) => (Number.isFinite(Date.parse(iso)) ? dateOf(iso) : "");
const insWord = (v) => tx("인사", v === "enrolled" ? "가입" : v === "not_enrolled" ? "미가입" : "미확인");
const amountText = (type, n) => (n == null ? "—" : t(type === "monthly" ? "월 {amount}원" : "시급 {amount}원", { amount: fmtWon(n) }));

// 금액 입력칸: 숫자만 받고 천 단위 콤마를 자동으로 넣는다(커서는 앞쪽 숫자 개수를 따라간다)
function formatMoneyInput(el) {
  const raw = el.value, pos = el.selectionStart == null ? raw.length : el.selectionStart;
  const before = raw.slice(0, pos).replace(/\D/g, "").length;
  const digits = raw.replace(/\D/g, "").slice(0, 12);
  const out = digits ? fmtWon(Number(digits)) : "";
  el.value = out;
  let n = 0, p = 0;
  while (p < out.length && n < before) { if (/\d/.test(out[p])) n++; p++; }
  try { el.setSelectionRange(p, p); } catch { /* 일부 브라우저는 커서를 옮길 수 없다 */ }
}

// 여러 칸 중 하나 고르기(.seg). set(v) 로 겉모양만 바꾼다. 색만으로 구분하지 않게 글자가 늘 있고 aria-pressed 도 단다
function mkSeg(label, options, value, onPick) {
  let cur = value;
  const wrap = h("div", { class: "seg hr-seg", role: "group", "aria-label": label });
  const btns = options.map(([v, text]) => h("button", { type: "button", class: "segbtn", "aria-pressed": "false" }, text));
  const sync = () => btns.forEach((b, i) => { const on = options[i][0] === cur; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
  btns.forEach((b, i) => b.addEventListener("click", () => { if (cur === options[i][0]) return; cur = options[i][0]; sync(); onPick(cur); }));
  wrap.append(...btns);
  sync();
  return Object.assign(wrap, { set(v) { cur = v; sync(); } });
}

// 확인창: ui.js 의 confirmDialog 를 쓰지 않는다 — 그 겉틀에는 .hr-overlay 를 달 수 없어 로그아웃·화면 가려짐 때 지워지지 않는다(금액이 든 항목을 보이므로 DOM 이 남으면 안 된다)
const confirms = new Set(); // 떠 있는 확인창의 "취소" 함수들(화면이 가려질 때 한꺼번에 닫는다)
function hrConfirm(title, items, backLabel, goLabel) {
  return new Promise((resolve) => {
    let ov = null;
    const cancel = () => { confirms.delete(cancel); ov.remove(); resolve(false); };
    const done = (v) => { confirms.delete(cancel); ov.remove(); resolve(v); };
    ov = h("div", { class: "overlay hr-overlay" },
      h("div", { class: "dialog hr-confirm", role: "dialog", "aria-modal": "true" },
        h("h2", null, title),
        items.length ? h("ul", null, items.map((i) => h("li", null, i))) : null,
        h("button", { type: "button", class: "btn primary", onclick: () => done(false) }, backLabel),
        h("button", { type: "button", class: "btn ghost", onclick: () => done(true) }, goLabel)));
    confirms.add(cancel);
    document.body.append(ov);
  });
}

export async function renderHr(root, opts = {}) {
  const { profile, onBack } = opts;
  const ctl = { ready: Promise.resolve(), reload: async () => {}, dispose() {} };
  const backBtn = onBack ? h("button", { type: "button", class: "linkbtn back", onclick: () => { ctl.dispose(); onBack(); } }, t("← 목록")) : null;
  // 관리자 3역할이 아니면 서버를 부르지 않는다(api.hr() 도 부르지 않는다). 직접 주소로 와도 열리지 않는다 — 진짜 방어는 서버 RLS
  if (!canManageHr(profile && profile.role)) {
    root.replaceChildren(h("div", { class: "page hr-root" }, backBtn, h("h2", { class: "sec-title" }, t("직원 인사 현황")),
      h("p", { class: "err", role: "alert" }, t("이 화면은 대표·회장·부대표만 볼 수 있어요"))));
    return ctl;
  }

  let hr = null, data = null, loadErr = null, loading = true, disposed = false, seq = 0;
  let payGen = 0; // 가림 세대. 금액을 기다리는 사이 가림이 일어나면 늦게 온 금액은 버린다
  let listDirty = false; // 수정 시트에서 계약서를 올리거나 지워 카드의 개수를 새로 맞춰야 한다
  let period = todayKST().slice(8) === "01" ? "last_month" : "this_month"; // 이 달 1일에는 집계할 날이 없어 지난 달부터 연다
  let filter = "";
  let sheet = null; // 열려 있는 수정 시트 { ov, close, onKey }
  let order = []; // 지금 화면에 보이는 순서의 user_id(저장하고 다음 직원)
  const rowBy = new Map(); // user_id → HrRow (금액은 들어 있지 않다)
  const reveal = new Map(); // user_id → 급여 금액. 가림을 풀어 둔 동안만 값이 있다
  const timers = new Map(); // user_id → 자동 가림 타이머
  const payWraps = new Map(); // 급여 줄 요소 → HrRow

  const sumHost = h("div", { class: "hr-sum" });
  const listHost = h("div", { class: "hr-list" });
  root.replaceChildren(h("div", { class: "page hr-root hr-page" }, backBtn,
    h("section", { class: "sec" }, h("h2", { class: "sec-title" }, t("직원 인사 현황")), h("p", { class: "hint" }, t("급여·4대보험·근로계약서는 대표·회장·부대표만 볼 수 있어요")),
      isDemo ? h("div", { class: "banner" }, t("데모 모드 — 가상 자료예요. 바꿔도 이 기기 안에서만 바뀌고 새로 고치면 처음으로 돌아가요")) : null, sumHost),
    h("section", { class: "sec" }, listHost),
    h("p", { class: "muted hr-foot" }, t("참고 지표이며 공식 근태 기록이 아니에요"))));

  /* ---------- 급여 가림 ---------- */
  function paintPay(wrap, r) {
    const uid = r.user_id, shown = reveal.has(uid);
    const kids = [h("span", { class: "hr-pay-k" }, t("급여"))];
    if (r.pay.has_amount) {
      kids.push(shown
        ? h("b", { class: "num hr-pay-v" }, amountText(r.pay.type, reveal.get(uid)))
        : h("span", { class: "hr-pay-v" }, tx("인사", r.pay.type === "monthly" ? "월급" : "시급"), " ", h("span", { class: "hr-mask", "aria-hidden": "true" }, "•••••••")));
      kids.push(h("button", { type: "button", class: "btn ghost slim hr-pay-btn", "aria-label": shown ? t("급여 가림") : t("급여 보기"), onclick: () => (reveal.has(uid) ? hideOne(uid) : showPay(r, wrap)) }, shown ? t("숨기기") : tx("인사", "보기")));
    } else kids.push(h("span", { class: "hr-pay-v" }, tx("인사", r.pay.type === "none" ? "해당 없음" : "미확인")));
    wrap.replaceChildren(...kids);
  }
  function hideOne(uid) {
    const id = timers.get(uid); if (id != null) clearTimeout(id);
    timers.delete(uid); reveal.delete(uid);
    for (const [wrap, r] of payWraps) if (r.user_id === uid) paintPay(wrap, r);
  }
  // 모든 금액을 화면(DOM)과 메모리에서 지운다
  function hideAll() {
    payGen++;
    for (const id of timers.values()) clearTimeout(id);
    timers.clear(); reveal.clear();
    for (const [wrap, r] of payWraps) paintPay(wrap, r);
  }
  async function showPay(r, wrap) {
    const b = wrap.querySelector(".hr-pay-btn");
    if (b) { b.disabled = true; b.textContent = t("불러오는 중…"); }
    const gen = payGen;
    try {
      const amount = await hr.payAmount(r.user_id);
      if (disposed || !wrap.isConnected || gen !== payGen) return; // 그 사이 화면을 떠났거나 목록이 다시 그려졌거나 가려졌으면 값을 받아 두지 않는다(가릴 때 이미 단추도 되돌렸다)
      reveal.set(r.user_id, amount);
      const old = timers.get(r.user_id); if (old != null) clearTimeout(old);
      timers.set(r.user_id, setTimeout(() => hideOne(r.user_id), hrTune.revealMs));
    } catch (e) { hrLog(e); if (!disposed) toast(hrErrText(e), 5000); }
    if (!disposed && wrap.isConnected && gen === payGen) paintPay(wrap, r);
  }

  /* ---------- 목록 그리기 ---------- */
  function card(r) {
    const { jt, rn } = titleRole(r.job_title, r.role);
    const a = r.att, rb = rateBadge(a), hb = healthBadge(r.health), cb = contractBadge(r.contract_state, r.contracts);
    const hasRate = typeof a.rate_pct === "number";
    const parts = [];
    if (hasRate) {
      parts.push(t("출근 {p}/{s}일", { p: a.present_days, s: a.sched_days }));
      if (a.late_count != null) parts.push(t("지각 {n}회", { n: a.late_count }));
      parts.push(t("퇴근 누락 {n}회", { n: a.missing_out }));
      if (data && a.counted_from && a.counted_from > data.from) parts.push(t("{date}부터 집계", { date: a.counted_from }));
    }
    const sub = hasRate ? parts.join(" · ")
      : a.reason === "no_records" ? t("출퇴근 기록이 없어요") : a.reason === "no_days" ? t("집계할 날이 아직 없어요") : "";
    const payWrap = h("div", { class: "hr-pay" });
    payWraps.set(payWrap, r);
    paintPay(payWrap, r);
    return h("div", { class: "empcard hr-card" },
      h("div", { class: "hr-top" },
        h("div", { class: "hr-who" }, h("b", { class: "hr-name" }, r.name || t("(이름 없음)")), h("span", { class: "muted" }, jt ? `${jt} · ${rn}` : rn)),
        h("button", { type: "button", class: "btn ghost slim hr-edit", "aria-label": t("{name} 님의 인사 정보", { name: r.name }), onclick: () => openSheet(r) }, tx("인사", "수정"))),
      h("div", { class: "hr-rate" },
        h("span", { class: "hr-rate-big" }, hasRate ? t("출근율 {pct}%", { pct: a.rate_pct }) : t("출근율 —")),
        rb ? h("span", { class: "badge " + rb.cls }, badgeText(rb)) : null),
      sub ? h("div", { class: "muted hr-att" }, sub) : null,
      h("div", { class: "hr-line" },
        h("span", { class: "hr-health" }, h("span", { "aria-hidden": "true" }, "🩺 "), r.health.need === "yes" && r.health.expires_on ? t("보건증 {date}", { date: r.health.expires_on }) : t("보건증")),
        h("span", { class: "badge " + hb.cls }, badgeText(hb))),
      h("div", { class: "hr-ins" }, INS_LIST.map(([k, name]) => h("span", { class: "badge " + (INS_CLS[r.ins[k]] ?? "") }, `${t(name)} ${insWord(r.ins[k])}`))),
      payWrap,
      h("div", { class: "hr-line" }, h("span", { class: "badge " + cb.cls }, badgeText(cb))));
  }

  function group(g) {
    const name = g.store ? `${KIND_ICON[g.store.kind] ?? ""} ${g.store.display_name || g.store.name || ""}`.trim() : t("소속 미지정");
    return h("div", { class: "hr-group" },
      h("div", { class: "sub-title" }, t("{name} · {n}명", { name, n: g.rows.length })),
      h("div", { class: "list" }, g.rows.map(card)));
  }

  function errorBox() {
    const forbidden = loadErr && loadErr.code === "forbidden";
    return h("div", null,
      h("p", { class: "alert", role: "alert" }, forbidden ? t("이 화면은 대표·회장·부대표만 볼 수 있어요") : hrErrText(loadErr)),
      forbidden ? null : h("button", { type: "button", class: "btn ghost", onclick: () => reload() }, t("다시 시도")));
  }

  function paintList() {
    payWraps.clear(); rowBy.clear(); order = [];
    if (!data) { listHost.replaceChildren(loadErr ? errorBox() : h("p", { class: "muted" }, t("불러오는 중…"))); return; }
    for (const r of data.rows) rowBy.set(r.user_id, r);
    if (!data.rows.length) { listHost.replaceChildren(h("p", { class: "muted hr-empty" }, t("인사 현황에 보여 줄 직원이 아직 없어요"))); return; }
    const shown = filter ? data.rows.filter((r) => matchFilter(r, filter)) : data.rows;
    if (!shown.length) {
      listHost.replaceChildren(h("div", { class: "hr-empty" }, h("p", { class: "muted" }, t("조건에 맞는 직원이 없어요")),
        h("button", { type: "button", class: "btn ghost slim hr-clear", onclick: () => setFilter("") }, t("전체 보기"))));
      return;
    }
    const groups = groupByStore(shown, data.stores);
    order = groups.flatMap((g) => g.rows.map((r) => r.user_id));
    listHost.replaceChildren(...groups.map(group));
  }

  function paintSummary() {
    const kids = [mkSeg(t("기간"), HR_PERIODS.map((p) => [p, t(PERIOD_LABEL[p])]), period, (p) => { period = p; hideAll(); reload(); })];
    if (data) kids.push(data.from && data.to && data.from <= data.to ? h("p", { class: "muted hr-range" }, t("{from} ~ {to} 기준", { from: data.from, to: data.to })) : h("p", { class: "muted hr-range" }, t("집계할 날이 아직 없어요")));
    if (data && data.rows.length) {
      const n = countFilters(data.rows);
      kids.push(h("div", { class: "chips hr-chips", role: "group" }, HR_FILTERS.filter((k) => k !== "unset" || n.unset > 0).map((k) =>
        h("button", { type: "button", class: "chip hr-chip" + (filter === k ? " on" : ""), "aria-pressed": filter === k ? "true" : "false", onclick: () => setFilter(filter === k ? "" : k) }, t(FILTER_LABEL[k], { n: n[k] })))));
      kids.push(h("details", { class: "hr-help" }, h("summary", null, t("ⓘ 계산 방법")),
        h("p", { class: "muted" }, t("출근율 = 출근 기록이 있는 날 ÷ 근무 예정일(사업장 휴무 요일 제외, 입사 이후, 어제까지). 참고 지표이며 공식 근태 기록이 아니에요."))));
    }
    sumHost.replaceChildren(...kids);
  }
  function setFilter(k) {
    const y = scrollY;
    filter = k; paintSummary(); paintList();
    scrollTo(0, y); // 거르기를 바꿔도 보던 자리를 그대로 둔다
  }

  // 서버 연결 객체를 얻는다. 처음 열 때 실패했어도 '다시 시도'에서 다시 얻을 수 있게 따로 둔다
  async function acquire() {
    if (hr) return true;
    try { hr = opts.hr || (await api.hr()); return true; }
    catch (e) { hrLog(e); loadErr = e; loading = false; if (!disposed) { paintSummary(); paintList(); } return false; }
  }

  async function reload() {
    if (disposed) return;
    if (!hr && !(await acquire())) return;
    if (disposed || !hr) return;
    hideAll(); // 새 목록에는 금액이 없으므로 가림 상태로 돌아간다
    const my = ++seq, y = scrollY;
    listHost.setAttribute("aria-busy", "true");
    try {
      const d = await hr.list(period);
      if (my !== seq || disposed) return;
      data = d; loadErr = null;
    } catch (e) {
      hrLog(e);
      if (my !== seq || disposed) return;
      if (data) { toast(hrErrText(e), 5000); period = data.period || period; } // 이미 보이는 목록이 있으면 그대로 두고 알리기만 한다
      else loadErr = e;
    }
    loading = false;
    listHost.removeAttribute("aria-busy");
    paintSummary(); paintList();
    scrollTo(0, y); // 화면 위치 유지
  }

  /* ---------- 수정 시트 ---------- */
  const nextOf = (uid) => { const i = order.indexOf(uid); return i >= 0 && i + 1 < order.length ? order[i + 1] : ""; };

  function removeOverlays() {
    for (const c of [...confirms]) c();
    for (const el of document.querySelectorAll(".hr-overlay")) el.remove();
    if (sheet) {
      document.removeEventListener("keydown", sheet.onKey); sheet = null;
      if (listDirty && !disposed) { listDirty = false; reload(); } // 시트가 close() 를 거치지 않고 사라져도(앱 전환·계약서 보기) 카드의 계약서 개수는 맞춘다
    }
  }

  async function openSheet(row) {
    if (sheet || disposed || !hr) return;
    const uid = row.user_id;
    const nextUid = nextOf(uid); // 저장하기 전에 지금 보이는 순서로 정해 둔다(저장 뒤 목록이 다시 와도 순서가 흔들리지 않게)
    hideAll();
    const ov = h("div", { class: "overlay hr-overlay" });
    const dlg = h("div", { class: "dialog hr-sheet", role: "dialog", "aria-modal": "true", "aria-label": t("{name} 님의 인사 정보", { name: row.name }) });
    ov.append(dlg);
    const me = { ov, close: null, onKey: null };
    sheet = me;
    let busy = false, dirty = () => false;
    const close = () => {
      document.removeEventListener("keydown", me.onKey);
      if (sheet === me) sheet = null;
      ov.remove();
      if (listDirty && !disposed) { listDirty = false; reload(); } // 파일을 올리거나 지웠으면 카드의 계약서 개수를 새로 맞춘다
    };
    const tryClose = async () => {
      if (busy) return;
      if (dirty() && !(await hrConfirm(t("저장하지 않고 닫을까요?"), [], t("돌아가기"), t("닫기")))) return;
      if (sheet === me) close();
    };
    me.close = close;
    me.onKey = (e) => { if (e.key === "Escape" && !confirms.size) tryClose(); };
    document.addEventListener("keydown", me.onKey);
    ov.addEventListener("click", (e) => { if (e.target === ov) tryClose(); });
    const title = h("h2", null, t("{name} 님의 인사 정보", { name: row.name }));
    dlg.append(title, h("p", { class: "muted" }, t("불러오는 중…")));
    document.body.append(ov);

    let d;
    try { d = await hr.detail(uid); } catch (e) {
      hrLog(e);
      if (sheet !== me) return;
      dlg.replaceChildren(title, h("p", { class: "alert", role: "alert" }, hrErrText(e)), h("button", { type: "button", class: "btn ghost", onclick: close }, t("닫기")));
      return;
    }
    if (sheet !== me) return; // 그 사이 닫혔다(화면이 가려짐 등)

    /* --- 폼 상태 --- */
    const sec = d.secret, hea = d.health;
    const form = {
      pay_type: sec.pay_type ?? null, amount: Number.isInteger(sec.pay_amount) ? fmtWon(sec.pay_amount) : "",
      ins: { pension: sec.ins_pension, health: sec.ins_health, employment: sec.ins_employment, accident: sec.ins_accident },
      hired_on: sec.hired_on || "", contract_state: sec.contract_state || "unknown",
      need: hea.need || "unknown", issued_on: hea.issued_on || "", expires_on: hea.expires_on || "",
    };
    let files = Array.isArray(d.files) ? d.files.slice() : [];
    const money = () => moneyType(form.pay_type);
    const snap = () => ({
      secret: { pay_type: form.pay_type, pay_amount: money() ? parseWon(form.amount) : null, ins_pension: form.ins.pension, ins_health: form.ins.health, ins_employment: form.ins.employment, ins_accident: form.ins.accident, hired_on: form.hired_on || null, contract_state: form.contract_state },
      health: { need: form.need, issued_on: form.need === "yes" ? form.issued_on || null : null, expires_on: form.need === "yes" ? form.expires_on || null : null },
    });
    let base = snap();
    dirty = () => !same(snap(), base);
    let tried = false; // 저장을 한 번 눌러 본 뒤부터는 고치는 즉시 다시 검사한다

    /* --- 칸 --- */
    const payErr = h("p", { class: "err hr-err", role: "alert", hidden: true });
    const expErr = h("p", { class: "err hr-err", role: "alert", hidden: true });
    const issErr = h("p", { class: "err hr-err", role: "alert", hidden: true });
    const hireErr = h("p", { class: "err hr-err", role: "alert", hidden: true });
    const saveMsg = h("p", { class: "alert hr-savemsg", role: "alert", hidden: true });
    const progress = h("p", { class: "muted hr-progress", role: "status", hidden: true });
    const amountIn = h("input", { type: "text", class: "inp hr-amount", id: "hr-f-amount", inputmode: "numeric", autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "done", maxlength: "16", "aria-label": t("급여 금액(원)") });
    amountIn.value = form.amount;
    amountIn.addEventListener("input", () => { formatMoneyInput(amountIn); form.amount = amountIn.value; if (tried) validate(); });
    const dateIn = (id, label, key) => {
      const el = h("input", { type: "date", class: "inp hr-date", id, min: HR_DATE_MIN, max: HR_DATE_MAX, "aria-label": label });
      el.value = form[key];
      const on = () => { form[key] = el.value; if (tried) validate(); };
      el.addEventListener("input", on); el.addEventListener("change", on);
      return el;
    };
    const expIn = dateIn("hr-f-exp", t("보건증 만료일"), "expires_on");
    const issIn = dateIn("hr-f-iss", t("보건증 발급일 (선택)"), "issued_on");
    const hireIn = dateIn("hr-f-hire", t("입사일 (선택)"), "hired_on");

    const amountWrap = h("div", { class: "hr-amountwrap" }, h("label", { class: "lbl", for: "hr-f-amount" }, t("급여 금액(원)")), amountIn, payErr);
    const datesWrap = h("div", { class: "hr-dates" },
      h("p", { class: "hint" }, t("만료일을 입력하면 30일·7일 전에 알려 드려요")),
      h("label", { class: "lbl", for: "hr-f-exp" }, t("보건증 만료일")), expIn, expErr,
      h("label", { class: "lbl", for: "hr-f-iss" }, t("보건증 발급일 (선택)")), issIn, issErr);
    const refresh = () => { amountWrap.hidden = !money(); datesWrap.hidden = form.need !== "yes"; fileNote.hidden = files.length === 0; };

    const payTypeSeg = mkSeg(t("급여 유형"), [["monthly", tx("인사", "월급")], ["hourly", tx("인사", "시급")], ["none", tx("인사", "해당 없음")], [null, tx("인사", "미확인")]], form.pay_type, (v) => { form.pay_type = v; refresh(); if (tried) validate(); });
    const insSegs = {};
    for (const [k, name] of INS_LIST) insSegs[k] = mkSeg(t(name), [["enrolled", tx("인사", "가입")], ["not_enrolled", tx("인사", "미가입")], ["unknown", tx("인사", "미확인")]], form.ins[k], (v) => { form.ins[k] = v; });
    const allBtn = h("button", { type: "button", class: "btn ghost slim hr-all", onclick: () => { for (const [k] of INS_LIST) { form.ins[k] = "enrolled"; insSegs[k].set("enrolled"); } } }, t("모두 가입"));
    const needSeg = mkSeg(t("보건증 필요 여부"), [["yes", tx("인사", "필요")], ["no", tx("인사", "해당 없음")], ["unknown", tx("인사", "미확인")]], form.need, (v) => { form.need = v; refresh(); if (tried) validate(); });
    const csSeg = mkSeg(t("근로계약서 있음 여부"), [["yes", tx("인사", "있음")], ["no", tx("인사", "없음")], ["unknown", tx("인사", "미확인")]], form.contract_state, (v) => { form.contract_state = v; });
    const fileNote = h("p", { class: "hint", hidden: true }, t("올린 파일이 있어서 목록에는 '있음'으로 보여요"));

    /* --- 계약서 파일 --- */
    const countEl = h("span", { class: "muted hr-fcount" });
    const filesHost = h("div", { class: "hr-files" });
    const fileIn = h("input", { type: "file", class: "hr-fileinput", accept: HR_FILE_EXT.map((x) => "." + x).join(","), multiple: true, hidden: true, tabindex: "-1", "aria-hidden": "true" });
    const uploadBtn = h("button", { type: "button", class: "btn ghost hr-upload", onclick: () => fileIn.click() }, t("파일 올리기"));
    const lockables = []; // 저장·올리기 중에 잠그는 단추들
    const paintFiles = () => {
      countEl.textContent = t("{n}/5개", { n: files.length });
      filesHost.replaceChildren(...files.map((f) => {
        const vb = h("button", { type: "button", class: "btn ghost slim", disabled: busy, onclick: () => viewFile(f) }, tx("계약서", "보기"));
        const db = h("button", { type: "button", class: "btn danger slim", disabled: busy, onclick: () => delFile(f) }, tx("인사", "지우기"));
        return h("div", { class: "hr-file" },
          h("div", { class: "hr-fmain" }, h("span", { class: "hr-fname" }, f.name), h("span", { class: "muted" }, [fmtSize(f.size), kstDate(f.uploaded_at)].filter(Boolean).join(" · "))),
          h("div", { class: "hr-facts" }, vb, db));
      }));
      uploadBtn.disabled = busy || files.length >= HR_FILE_LIMIT;
      refresh();
    };
    async function viewFile(f) {
      const w = window.open("", "_blank"); // 아이폰 사파리가 팝업으로 막지 않게 주소를 기다리기 전에 먼저 창을 연다
      try {
        const url = await hr.fileUrl(f); // 60초짜리 임시 주소: 누를 때마다 새로 받고 저장·표시하지 않는다
        if (w) w.location = url; else location.href = url;
      } catch (e) { hrLog(e); if (w) w.close(); toast(hrErrText(e), 5000); }
    }
    async function delFile(f) {
      if (busy) return;
      if (!(await hrConfirm(t("이 근로계약서를 지울까요? 파일도 함께 사라져요"), [f.name], t("돌아가기"), tx("인사", "지우기")))) return;
      if (sheet !== me) return;
      setBusy(true);
      try { await hr.fileDelete(f); files = files.filter((x) => x.id !== f.id); listDirty = true; toast(t("지웠어요"), 1800); } catch (e) { hrLog(e); toast(hrErrText(e), 5000); }
      setBusy(false);
    }
    fileIn.addEventListener("change", async () => {
      const picked = Array.from(fileIn.files || []);
      fileIn.value = "";
      if (!picked.length || busy) return;
      const ok = [];
      for (const f of picked) {
        const why = checkHrFile(f, files.length + ok.length); // 개수는 올리기 전에 5 − (지금 개수) 로 미리 자른다
        if (why) toast(why, 5000); else ok.push(f);
      }
      if (!ok.length) return;
      setBusy(true);
      for (let i = 0; i < ok.length; i++) {
        progress.hidden = false; progress.textContent = t("올리는 중 ({i}/{n})", { i: i + 1, n: ok.length });
        try { files.push(await hr.fileUpload(uid, ok[i])); listDirty = true; paintFiles(); } catch (e) { hrLog(e); toast(hrErrText(e), 5000); break; }
      }
      progress.hidden = true; progress.textContent = "";
      setBusy(false);
    });

    /* --- 검사 --- */
    function validate() {
      let first = null;
      const show = (el, key, target) => { el.textContent = key ? t(key) : ""; el.hidden = !key; if (key && !first) first = target; };
      show(payErr, money() ? payProblem(form.pay_type, parseWon(form.amount)) : null, amountIn);
      let em = "", im = "", hm = "";
      if (form.need === "yes") {
        if (form.expires_on && !isDateStr(form.expires_on)) em = "만료일을 날짜로 입력해 주세요";
        else if (form.expires_on && !dateInRange(form.expires_on)) em = "날짜 범위가 올바르지 않아요";
        if (form.issued_on && !dateInRange(form.issued_on)) im = "날짜 범위가 올바르지 않아요";
        else if (!em && form.issued_on && form.expires_on && form.issued_on > form.expires_on) im = "발급일이 만료일보다 늦을 수 없어요";
      }
      if (form.hired_on && !dateInRange(form.hired_on)) hm = "날짜 범위가 올바르지 않아요";
      show(expErr, em, expIn); show(issErr, im, issIn); show(hireErr, hm, hireIn);
      return { ok: !first, first };
    }

    /* --- 저장 --- */
    const payText = (s) => (moneyType(s.pay_type) ? amountText(s.pay_type, s.pay_amount) : tx("인사", s.pay_type === "none" ? "해당 없음" : "미확인"));
    const healthText = (hl) => (hl.need !== "yes" ? tx("인사", hl.need === "no" ? "해당 없음" : "미확인")
      : [tx("인사", "필요"), hl.expires_on ? t("만료일 {date}", { date: hl.expires_on }) : "", hl.issued_on ? t("발급일 {date}", { date: hl.issued_on }) : ""].filter(Boolean).join(", "));
    // 바뀐 것만 나열한다(금액의 0 하나 착오를 잡는 확인창에 쓴다)
    function changeItems(a, b) {
      const items = [];
      if (a.secret.pay_type !== b.secret.pay_type || a.secret.pay_amount !== b.secret.pay_amount) items.push(t("급여: {text}", { text: payText(a.secret) }));
      const ins = INS_LIST.filter(([k]) => a.secret["ins_" + k] !== b.secret["ins_" + k]).map(([k, name]) => `${t(name)} ${insWord(a.secret["ins_" + k])}`);
      if (ins.length) items.push(t("4대보험: {text}", { text: ins.join(", ") }));
      if (!same(a.health, b.health)) items.push(t("보건증: {text}", { text: healthText(a.health) }));
      if (a.secret.hired_on !== b.secret.hired_on) items.push(t("입사일: {date}", { date: a.secret.hired_on || "—" }));
      if (a.secret.contract_state !== b.secret.contract_state) items.push(t("근로계약서: {text}", { text: tx("인사", a.secret.contract_state === "yes" ? "있음" : a.secret.contract_state === "no" ? "없음" : "미확인") }));
      return items;
    }
    const saveBtn = h("button", { type: "button", class: "btn primary hr-save", onclick: () => doSave(false) }, t("저장"));
    const nextBtn = nextUid ? h("button", { type: "button", class: "btn ghost hr-save-next", onclick: () => doSave(true) }, t("저장하고 다음 직원")) : null;
    const cancelBtn = h("button", { type: "button", class: "btn weak hr-cancel", onclick: tryClose }, t("취소"));
    lockables.push(saveBtn, nextBtn, cancelBtn, allBtn);
    function setBusy(on, saving = false) {
      busy = on;
      for (const b of lockables) if (b) b.disabled = on;
      saveBtn.textContent = on && saving ? t("저장하는 중…") : t("저장");
      paintFiles();
    }
    async function doSave(goNext) {
      if (busy) return;
      tried = true; saveMsg.hidden = true;
      const v = validate();
      if (!v.ok) { try { v.first.focus(); } catch { /* 무시 */ } return; }
      const cur = snap();
      const secChanged = !same(cur.secret, base.secret), heaChanged = !same(cur.health, base.health);
      if (!secChanged && !heaChanged) {
        toast(t("바뀐 내용이 없어요"));
        if (goNext && nextUid) { const nr = rowBy.get(nextUid); close(); if (nr) openSheet(nr); }
        return;
      }
      // 급여가 바뀐 저장에만 확인창을 띄운다(보험·보건증·입사일·계약서 상태만 바뀐 저장은 바로 저장해서 여러 명을 이어서 입력할 수 있게)
      if (cur.secret.pay_type !== base.secret.pay_type || cur.secret.pay_amount !== base.secret.pay_amount) {
        const items = changeItems(cur, base);
        if (payTooSmall(cur.secret.pay_type, cur.secret.pay_amount)) items.push(t("금액이 너무 작아요. 원 단위가 맞는지 확인해 주세요"));
        if (!(await hrConfirm(t("저장할까요?"), items, t("돌아가기"), t("저장")))) return;
        if (sheet !== me) return;
      }
      setBusy(true, true);
      const patch = {};
      if (secChanged) patch.secret = cur.secret;
      if (heaChanged) patch.health = cur.health;
      try {
        await hr.save(uid, patch);
      } catch (e) {
        hrLog(e);
        setBusy(false);
        const done = Array.isArray(e && e.saved) ? e.saved : [];
        if (done.length) { // 일부만 저장됨: 시트를 닫지 않고 알린다. 저장된 부분은 기준값을 새 값으로 바꾼다
          if (done.includes("secret")) base = { ...base, secret: cur.secret };
          if (done.includes("health")) base = { ...base, health: cur.health };
          listDirty = true;
          const what = done.map((k) => t(k === "secret" ? "급여·4대보험·입사일·계약서 상태" : "보건증")).join(", ");
          saveMsg.textContent = `${t("일부만 저장했어요: {what}", { what })} — ${hrErrText(e)}`; saveMsg.hidden = false;
        } else toast(hrErrText(e), 5000);
        return;
      }
      const stay = sheet === me; // 저장하는 동안 화면이 가려져 시트가 닫혔다면 다음 직원 시트를 새로 열지 않는다
      toast(t("저장했어요"));
      listDirty = false; // 저장 뒤 목록을 어차피 다시 불러온다(시트를 닫을 때 한 번 더 부르지 않게)
      if (stay) close();
      await reload();
      if (goNext && stay && nextUid && !disposed) { const nr = rowBy.get(nextUid); if (nr) openSheet(nr); }
    }

    /* --- 조립 --- */
    const lm = [[sec.updated_at, sec.updated_by_name], [hea.updated_at, hea.updated_by_name]].filter(([a]) => kstStamp(a)).sort((x, y) => Date.parse(y[0]) - Date.parse(x[0]))[0];
    const rule = () => h("div", { class: "divider" });
    dlg.replaceChildren(title,
      h("div", { class: "hr-fsec" }, h("span", { class: "lbl" }, t("급여 유형")), payTypeSeg, amountWrap),
      rule(),
      h("div", { class: "hr-fsec" },
        h("div", { class: "hr-fhead" }, h("span", { class: "lbl" }, t("4대보험 가입 여부")), allBtn),
        INS_LIST.map(([k, name]) => h("div", { class: "hr-insrow" }, h("span", { class: "hr-insname" }, t(name)), insSegs[k]))),
      rule(),
      h("div", { class: "hr-fsec" }, h("span", { class: "lbl" }, t("보건증 필요 여부")), needSeg, datesWrap),
      rule(),
      h("div", { class: "hr-fsec" }, h("label", { class: "lbl", for: "hr-f-hire" }, t("입사일 (선택)")), hireIn, h("p", { class: "hint" }, t("출근율은 입사일과 계정을 만든 날 중 늦은 날부터 계산해요")), hireErr),
      rule(),
      h("div", { class: "hr-fsec" },
        h("span", { class: "lbl" }, t("근로계약서 있음 여부")), csSeg, fileNote,
        h("div", { class: "hr-fhead" }, h("span", { class: "lbl" }, t("근로계약서")), countEl),
        filesHost,
        h("p", { class: "hint" }, t("최대 5개, 파일 하나는 20MB까지 (pdf·사진·doc·docx·hwp)")),
        uploadBtn, fileIn, progress),
      rule(),
      lm ? h("p", { class: "muted hr-lastmod" }, t("마지막 수정: {when}(한국시간) {who}", { when: kstStamp(lm[0]), who: lm[1] || "" }).trim()) : null,
      saveMsg,
      saveBtn, nextBtn, cancelBtn);
    paintFiles();
  }

  /* ---------- 화면이 가려지거나 사라질 때 ---------- */
  const hideNow = () => { hideAll(); removeOverlays(); };
  const onVis = () => { if (document.visibilityState === "hidden") hideNow(); };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", hideNow);
  function dispose() {
    if (disposed) return;
    disposed = true; seq++;
    hideAll(); removeOverlays();
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pagehide", hideNow);
    mo.disconnect();
    data = null; rowBy.clear(); payWraps.clear();
  }
  // 로그아웃·다른 화면으로 이동으로 이 자리가 화면에서 사라지면 스스로 정리한다(금액·시트를 메모리·화면에 남기지 않는다)
  let wasConnected = root.isConnected;
  const mo = new MutationObserver(() => { if (root.isConnected) wasConnected = true; else if (wasConnected) dispose(); });
  mo.observe(document.body, { childList: true, subtree: true });

  Object.assign(ctl, { reload: () => reload(), dispose });
  paintSummary(); paintList();
  ctl.ready = (async () => {
    if (!(await acquire())) return;
    await reload();
  })();
  return ctl;
}
