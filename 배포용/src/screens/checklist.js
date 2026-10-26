// CK 점검 화면(작업자): 오늘 점검 항목을 체크하고 보관온도 같은 숫자를 기록한다. 이상은 바로 보고한다.
import { api } from "../lib/api.js";
import { h, toast, modal } from "../lib/ui.js";
import { labelMD, fmtHM } from "../lib/kst.js";

export const rangeText = (it) => {
  if (it.min_val === null && it.max_val === null) return "기준 미설정";
  const f = (v) => (v === null ? "" : String(Number(v)));
  return `기준 ${f(it.min_val)}~${f(it.max_val)}${it.unit}`;
};

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
    try { const r = await fn(); if (okMsg) toast(r?.out_of_range ? "기준을 벗어났어요. 관리자에게 알렸어요" : okMsg, r?.out_of_range ? 5000 : 2000); } catch (e) { toast(e.message, 4000); }
    busy = null;
    await load();
  }

  async function report() {
    const note = h("textarea", { class: "inp", rows: "4", maxlength: "300", placeholder: "예: 꽃게 상태가 이상해요 / 이물이 보여요 / 몸이 아파요" });
    for (;;) {
      if (!(await modal("이상 보고", h("div", { class: "stack" }, h("p", { class: "muted" }, "CK 부장과 대표님께 바로 알림이 가요"), note), "보고하기", "취소"))) return;
      if (!note.value.trim()) { toast("어떤 이상인지 적어 주세요"); continue; }
      try { await api.chkReport(note.value); toast("보고했어요", 2500); return; } catch (e) { toast(e.message, 4000); }
    }
  }

  function item(it) {
    if (it.kind === "check") {
      return h("div", { class: "rt " + (it.done ? "done" : "") },
        h("div", { class: "rt-main" }, h("div", { class: "rt-title" }, it.title), it.title_vi && h("div", { class: "rt-sub" }, it.title_vi)),
        it.done
          ? h("button", { class: "linkbtn", onclick: () => run(it, () => api.chkSubmit({ item_id: it.id, done: false })) }, "✓ 완료 (취소)")
          : h("button", { class: "done-btn", disabled: busy === it.id, onclick: () => run(it, () => api.chkSubmit({ item_id: it.id, done: true })) }, busy === it.id ? "…" : "완료"));
    }
    let inp = inputs.get(it.id);
    if (!inp) { inp = h("input", { type: "number", inputmode: "decimal", step: "0.1", class: "inp", style: "width:90px", placeholder: it.unit || "값" }); inputs.set(it.id, inp); }
    return h("div", { class: "rt " + (it.out_of_range ? "overdue" : it.done ? "done" : "") },
      h("div", { class: "rt-main" },
        h("div", { class: "rt-title" }, it.title),
        it.title_vi && h("div", { class: "rt-sub" }, it.title_vi),
        h("div", { class: "rt-sub" }, rangeText(it) + (it.done ? ` · 마지막 ${it.last_value}${it.unit} (${fmtHM(it.last_at)})${it.out_of_range ? " ⚠ 기준 벗어남" : ""}` : ""))),
      h("div", { style: "display:flex;gap:6px;align-items:center" }, inp,
        h("button", { class: "done-btn", disabled: busy === it.id, onclick: () => run(it, async () => { const r = await api.chkSubmit({ item_id: it.id, value: inp.value }); inp.value = ""; return r; }, "기록했어요") }, busy === it.id ? "…" : "기록")));
  }

  function view() {
    if (err) return h("div", { class: "page" }, h("p", { class: "err" }, "불러오기 실패: " + err), h("button", { class: "btn ghost", onclick: load }, "다시 시도"));
    if (!data) return h("div", { class: "page" }, h("p", { class: "muted" }, "불러오는 중…"));
    const checks = data.items.filter((i) => i.kind === "check" && i.freq === "daily"); // 오늘 진행률은 매일 항목만
    const doneN = checks.filter((i) => i.done).length;
    const sections = [];
    for (const i of data.items) if (!sections.includes(i.section)) sections.push(i.section);
    return h("div", { class: "page" },
      h("div", { class: "datebar" }, h("b", null, labelMD(data.date)), h("span", null, `${doneN} / ${checks.length} 완료`)),
      h("div", { class: "progress" }, h("i", { style: `width:${checks.length ? Math.round((doneN / checks.length) * 100) : 0}%` })),
      h("button", { class: "btn ghost", style: "border-color:var(--bad);color:var(--bad)", onclick: report }, "🚨 이상 보고 (재료 이상·이물·몸이 아파요)"),
      !data.items.length && h("p", { class: "muted" }, "점검 항목이 아직 없어요. 대표님이 항목을 설정하면 여기에 나와요."),
      sections.map((s) => h("div", null, h("div", { class: "cat-title" }, s + ({ weekly: " (이번 주 1회)", monthly: " (이번 달 1회)" }[data.items.find((i) => i.section === s)?.freq] ?? "")), h("div", { class: "list" }, data.items.filter((i) => i.section === s).map(item)))));
  }

  draw();
  await load();
}
