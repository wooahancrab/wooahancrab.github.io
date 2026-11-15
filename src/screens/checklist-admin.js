// CK 점검 관리: 오늘 현황·이상 보고(관리자) + 항목·기준값 설정(대표)
import { api } from "../lib/api.js";
import { h, toast, modal, seg } from "../lib/ui.js";
import { labelMD, fmtHM, dateOf } from "../lib/kst.js";
import { t, tx, lang } from "../lib/i18n.js";

const ROLE_KO = { staff: "직원", supervisor: "중간관리자", manager: "매니저" };

// 기준값 표시. 한국어는 예전 표기(rangeText) 그대로, 베트남어·영어는 한쪽만 있을 때 '이하/이상'으로 분명히(checklist.js 의 작업자 화면과 같은 방식)
const rangeLabel = (it) => {
  if (it.min_val === null && it.max_val === null) return t("기준 미설정");
  const f = (v) => (v === null ? "" : String(Number(v)));
  if (lang() !== "ko") {
    if (it.min_val === null) return t("기준 {v} 이하", { v: f(it.max_val) + (it.unit ?? "") });
    if (it.max_val === null) return t("기준 {v} 이상", { v: f(it.min_val) + (it.unit ?? "") });
  }
  return t("기준 {range}", { range: `${f(it.min_val)}~${f(it.max_val)}${it.unit}` });
};

export async function renderChecklistAdmin(root, onBack, opts = {}) {
  const master = !!opts.master;
  const canView = opts.itemsView !== false; // 항목 탭: 대표·부대표만
  let tab = "board";
  let board = null, items = null, err = "";

  async function load() {
    try {
      board = await api.chkBoard();
      if (canView) items = (await api.chkItems()).items;
      err = "";
    } catch (e) { err = e.message; }
    draw();
  }
  const draw = () => { const y = scrollY; root.replaceChildren(view()); scrollTo(0, y); };
  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg, 2000); await load(); return true; } catch (e) { toast(e.message, 4000); return false; } };

  async function editItem(it) {
    const s = { title: it?.title ?? "", kind: it?.kind ?? "check", unit: it?.unit ?? "", min: it?.min_val ?? "", max: it?.max_val ?? "", section: it?.section ?? "작업", active: it?.active ?? true, freq: it?.freq ?? "daily" }; // 구분 기본값 '작업'은 DB에 저장되는 값
    const vi = h("input", { type: "text", class: "inp", placeholder: t("베트남어 (선택)"), value: it?.title_vi ?? "", maxlength: "120" });
    const aud = h("input", { type: "text", class: "inp", placeholder: t("누구에게 보일까 (예: 부장 / 과장,차장 / !부장,!과장 / 비우면 전원)"), value: it?.audience ?? "", maxlength: "60" });
    const title = h("input", { type: "text", class: "inp", placeholder: t("항목 이름 (예: 냉장고 보관온도)"), value: s.title, maxlength: "40" });
    const section = h("input", { type: "text", class: "inp", placeholder: t("구분 (작업 전 / 작업 중 / 작업 후 / 온도 기록)"), value: s.section, maxlength: "12" });
    const unit = h("input", { type: "text", class: "inp", placeholder: t("단위 (예: ℃)"), value: s.unit, maxlength: "8" });
    const min = h("input", { type: "number", step: "0.1", class: "inp", placeholder: t("기준 최소"), value: String(s.min) });
    const max = h("input", { type: "number", step: "0.1", class: "inp", placeholder: t("기준 최대"), value: String(s.max) });
    const numBox = h("div", { class: "stack" });
    const kindBox = h("div", { class: "stack" });
    const freqBox = h("div", { class: "stack" });
    const actBox = h("div", { class: "stack" });
    const drawBoxes = () => {
      kindBox.replaceChildren(h("label", { class: "lbl" }, t("종류")), seg([["check", t("체크 (했음/안 했음)")], ["number", t("숫자 기록")]], s.kind, (v) => { s.kind = v; drawBoxes(); }));
      freqBox.replaceChildren(...(s.kind === "check" ? [h("label", { class: "lbl" }, t("주기")), seg([["daily", t("매일")], ["weekly", t("매주 1회")], ["monthly", t("매달 1회")]], s.freq, (v) => { s.freq = v; drawBoxes(); })] : []));
      numBox.replaceChildren(...(s.kind === "number" ? [h("label", { class: "lbl" }, t("단위와 기준값 (벗어나면 관리자에게 바로 알림 · 비우면 기준 없음)")), unit, min, max] : []));
      actBox.replaceChildren(seg([[true, tx("점검 항목", "사용")], [false, tx("점검 항목", "사용 안 함")]], s.active, (v) => { s.active = v; drawBoxes(); }));
    };
    drawBoxes();
    const content = h("div", { class: "stack" }, title, vi, section, aud, kindBox, freqBox, numBox, actBox);
    for (;;) {
      if (!(await modal(it ? t("항목 수정") : t("항목 추가"), content, t("저장"), t("취소")))) return;
      if (!title.value.trim()) { toast(t("항목 이름을 입력해 주세요")); continue; }
      const ok = await act(() => api.chkSave({ id: it?.id, title: title.value, kind: s.kind, unit: unit.value, min_val: min.value, max_val: max.value, section: section.value, active: s.active, title_vi: vi.value, audience: aud.value, freq: s.freq, sort: it?.sort ?? items.length }), t("저장했어요"));
      if (ok) return;
    }
  }

  function boardView() {
    if (!board) return h("p", { class: "muted" }, t("불러오는 중…"));
    return h("div", null,
      board.reports.length > 0 && h("section", { class: "sec stack" }, h("h2", { class: "sec-title" }, t("🚨 확인 안 한 이상 보고 {n}건", { n: board.reports.length })),
        board.reports.map((r) => h("div", { class: "entry" },
          h("div", { class: "entry-head" }, h("span", null, `${r.user_name} · ${labelMD(dateOf(r.at))} ${fmtHM(r.at)}`)),
          h("p", { class: "plain-pre" }, r.note),
          h("button", { class: "btn ghost slim", onclick: () => act(() => api.chkResolve(r.id), t("확인했어요")) }, t("확인 완료"))))),
      h("section", { class: "sec stack" }, h("h2", { class: "sec-title" }, t("오늘 점검 현황 ({date})", { date: labelMD(board.date) })),
        !board.people.length ? h("p", { class: "muted" }, t("담당 직원이 없어요")) :
          h("div", { class: "rowlist" }, board.people.map((p) => h("div", { class: "item col static" },
            h("b", null, `${p.name} `, h("span", { class: "muted" }, (p.job_title ? p.job_title + " · " : "") + t(ROLE_KO[p.role] ?? ""))),
            h("span", null, t("체크 {done} / {total}", { done: p.done, total: p.total }), p.bad > 0 ? h("span", { class: "badge bad", style: "margin-left:6px" }, t("기준 벗어남 {n}", { n: p.bad })) : null,
              p.last_at ? h("span", { class: "muted" }, "  · " + t("마지막 {time}", { time: fmtHM(p.last_at) })) : h("span", { class: "muted" }, "  · " + t("아직 기록 없음"))))))));
  }

  function itemsView() {
    if (!items) return h("p", { class: "muted" }, t("불러오는 중…"));
    return h("div", null,
      master && h("button", { class: "btn primary", onclick: () => editItem(null) }, t("+ 항목 추가")),
      master && !items.length && h("button", { class: "btn ghost", onclick: () => act(() => api.chkSeed(), t("매뉴얼 기본 항목을 불러왔어요")) }, t("매뉴얼 기본 항목 불러오기 (붙임1-3·서식01)")),
      master && items.length > 0 && h("button", { class: "linkbtn", onclick: async () => { if (confirm(t("기존 항목과 점검 기록을 모두 지우고 매뉴얼 기본 항목으로 다시 만들까요?"))) await act(() => api.chkSeed(true), t("다시 불러왔어요")); } }, t("매뉴얼 기준으로 다시 불러오기 (기존 항목·기록 삭제)")),
      !master && h("p", { class: "muted" }, t("항목과 기준값은 대표님만 바꿀 수 있어요")),
      h("div", { class: items.length ? "rowlist" : "list" }, items.map((it) => h("div", { class: "item col static", style: it.active ? "" : "background:var(--soft)" },
        h("b", null, it.title, " ", h("span", { class: "muted" }, `${it.section} · ${it.kind === "number" ? tx("점검 항목", "숫자") : tx("점검 항목", "체크")}${it.freq === "weekly" ? " · " + t("매주") : it.freq === "monthly" ? " · " + t("매달") : ""}${it.audience ? " · " + t("대상: {who}", { who: it.audience }) : ""}${it.active ? "" : " · " + tx("점검 항목", "사용 안 함")}`)),
        it.kind === "number" && h("span", { class: "muted" }, rangeLabel(it)),
        master && h("button", { class: "btn ghost slim", onclick: () => editItem(it) }, tx("관리", "수정"))))));
  }

  function view() {
    return h("div", { class: "page" },
      onBack && h("button", { class: "linkbtn back", onclick: onBack }, t("← 목록")),
      h("h1", null, t("CK 점검")),
      err && h("p", { class: "err" }, t("불러오기 실패: {msg}", { msg: t(err) })),
      canView && h("div", { class: "tabs" }, [["board", t("오늘 현황")], ["items", t("항목·기준값")]].map(([k, l]) =>
        h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; draw(); } }, l))),
      tab === "board" || !canView ? boardView() : itemsView());
  }

  draw();
  await load();
}
