// CK 점검 화면(작업자): 오늘 점검 항목을 체크하고 보관온도 같은 숫자를 기록한다. 이상은 바로 보고한다.
import { api } from "../lib/api.js";
import { h, toast, modal } from "../lib/ui.js";
import { fmtHM, dow } from "../lib/kst.js";
import { t, tx, lang, dowNames } from "../lib/i18n.js";

// 관리자 화면(checklist-admin.js)이 그대로 쓰는 한국어 표시. 작업자 화면은 아래 rangeLabel 을 쓴다.
export const rangeText = (it) => {
  if (it.min_val === null && it.max_val === null) return "기준 미설정";
  const f = (v) => (v === null ? "" : String(Number(v)));
  return `기준 ${f(it.min_val)}~${f(it.max_val)}${it.unit}`;
};

const rangeLabel = (it) => {
  if (it.min_val === null && it.max_val === null) return t("기준 미설정");
  const f = (v) => String(Number(v));
  // 한쪽만 있으면 '~-18℃'처럼 쓰지 않고 이하/이상으로 분명히(베트남어·영어에서 '약 -18℃'로 오해하지 않게)
  if (it.min_val === null) return t("기준 {v} 이하", { v: f(it.max_val) + it.unit });
  if (it.max_val === null) return t("기준 {v} 이상", { v: f(it.min_val) + it.unit });
  return t("기준 {range}", { range: `${f(it.min_val)}~${f(it.max_val)}${it.unit}` });
};

// 날짜 머리글: 요일은 화면 언어로(한국어는 기존과 같은 "11/13(목)")
const dateLabel = (s) => {
  const [, m, d] = s.split("-").map(Number);
  return `${m}/${d}(${dowNames()[dow(s)]})`;
};

// 점검 항목 이름은 DB 데이터: 베트남어 화면은 베트남어(있으면)가 주·한국어가 보조, 그 밖에는 한국어가 주·베트남어가 보조
const itemNames = (it) => (lang() === "vi" && it.title_vi ? [it.title_vi, it.title] : [it.title, it.title_vi]);

export async function renderChecklist(root) {
  let data = null;
  let err = "";
  let busy = null;
  const inputs = new Map(); // 숫자 항목 입력칸(다시 그려도 입력 중인 값을 유지)

  async function load() {
    try { data = await api.chkToday(); err = ""; } catch (e) { err = e.message; }
    draw();
  }
  const draw = () => { const y = scrollY; root.replaceChildren(view()); scrollTo(0, y); };

  async function run(it, fn, okMsg) {
    if (busy) return;
    busy = it.id; draw();
    try { const r = await fn(); if (okMsg) toast(r?.out_of_range ? t("기준을 벗어났어요. 관리자에게 알렸어요") : okMsg, r?.out_of_range ? 5000 : 2000); } catch (e) { toast(t(e.message), 4000); }
    busy = null;
    await load();
  }

  async function report() {
    const note = h("textarea", { class: "inp", rows: "4", maxlength: "300", placeholder: t("예: 꽃게 상태가 이상해요 / 이물이 보여요 / 몸이 아파요") });
    for (;;) {
      if (!(await modal(t("이상 보고"), h("div", { class: "stack" }, h("p", { class: "muted" }, t("CK 부장과 대표님께 바로 알림이 가요")), note), t("보고하기"), t("취소")))) return;
      if (!note.value.trim()) { toast(t("어떤 이상인지 적어 주세요")); continue; }
      try { await api.chkReport(note.value); toast(t("보고했어요"), 2500); return; } catch (e) { toast(t(e.message), 4000); }
    }
  }

  function item(it) {
    const [main, sub] = itemNames(it);
    if (it.kind === "check") {
      return h("div", { class: "rt " + (it.done ? "done" : "") },
        h("div", { class: "rt-main" }, h("div", { class: "rt-title" }, main), sub && h("div", { class: "rt-sub" }, sub)),
        it.done
          ? h("button", { class: "linkbtn", onclick: () => run(it, () => api.chkSubmit({ item_id: it.id, done: false })) }, t("✓ 완료 (취소)"))
          : h("button", { class: "done-btn", disabled: busy === it.id, onclick: () => run(it, () => api.chkSubmit({ item_id: it.id, done: true })) }, busy === it.id ? "…" : t("완료")));
    }
    let inp = inputs.get(it.id);
    if (!inp) { inp = h("input", { type: "number", inputmode: "decimal", step: "0.1", class: "inp", style: "width:90px", placeholder: it.unit || t("값") }); inputs.set(it.id, inp); }
    const lastText = it.done
      ? " · " + (it.out_of_range
        ? t("마지막 {value}{unit} ({time}) ⚠ 기준 벗어남", { value: it.last_value, unit: it.unit, time: fmtHM(it.last_at) })
        : t("마지막 {value}{unit} ({time})", { value: it.last_value, unit: it.unit, time: fmtHM(it.last_at) }))
      : "";
    return h("div", { class: "rt " + (it.out_of_range ? "overdue" : it.done ? "done" : "") },
      h("div", { class: "rt-main" },
        h("div", { class: "rt-title" }, main),
        sub && h("div", { class: "rt-sub" }, sub),
        h("div", { class: "rt-sub" }, rangeLabel(it) + lastText)),
      h("div", { style: "display:flex;gap:6px;align-items:center" }, inp,
        h("button", { class: "done-btn", disabled: busy === it.id, onclick: () => run(it, async () => { const r = await api.chkSubmit({ item_id: it.id, value: inp.value }); inp.value = ""; return r; }, t("기록했어요")) }, busy === it.id ? "…" : tx("점검", "기록"))));
  }

  function view() {
    if (err) return h("div", { class: "page" }, h("p", { class: "err" }, t("불러오기 실패: {err}", { err: t(err) })), h("button", { class: "btn ghost", onclick: load }, t("다시 시도")));
    if (!data) return h("div", { class: "page" }, h("p", { class: "muted" }, t("불러오는 중…")));
    const checks = data.items.filter((i) => i.kind === "check" && i.freq === "daily"); // 오늘 진행률은 매일 항목만
    const doneN = checks.filter((i) => i.done).length;
    const sections = [];
    for (const i of data.items) if (!sections.includes(i.section)) sections.push(i.section);
    return h("div", { class: "page" },
      h("div", { class: "datebar" }, h("b", null, dateLabel(data.date)), h("span", null, t("{done} / {total} 완료", { done: doneN, total: checks.length }))),
      h("div", { class: "progress" }, h("i", { style: `width:${checks.length ? Math.round((doneN / checks.length) * 100) : 0}%` })),
      h("button", { class: "btn danger", onclick: report }, t("🚨 이상 보고 (재료 이상·이물·몸이 아파요)")),
      !data.items.length && h("p", { class: "muted" }, t("점검 항목이 아직 없어요. 대표님이 항목을 설정하면 여기에 나와요.")),
      sections.map((s) => {
        const note = { weekly: t("이번 주 1회"), monthly: t("이번 달 1회") }[data.items.find((i) => i.section === s)?.freq]; // 섹션 이름은 DB 데이터라 그대로
        return h("div", null, h("div", { class: "cat-title" }, s + (note ? ` (${note})` : "")), h("div", { class: "rowlist" }, data.items.filter((i) => i.section === s).map(item)));
      }));
  }

  draw();
  await load();
}
