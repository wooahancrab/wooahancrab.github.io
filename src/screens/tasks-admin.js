// 업무지시 관리(대표·부대표): 업무를 지시하고, 담당자별 진행·밀림을 본다
import { api } from "../lib/api.js";
import { h, toast, modal, seg } from "../lib/ui.js";
import { labelMD, dateOf, fmtHM, todayKST } from "../lib/kst.js";
import { REPEAT_KO } from "./tasks.js";

const SHORT = { gejang: "게장", ck: "CK", fnb: "F&B" };

// opts.all: 대표·부대표가 사업장 구분 없이 전 직원에게 지시(담당자 목록이 사업장별로 묶여 나옴)
export async function renderTasksAdmin(root, onBack, opts = {}) {
  const ALL = !!opts.all;
  let data = null, people = [], err = "";
  let tab = "open";
  let stores = [];

  async function load() {
    try {
      [data, people] = await Promise.all([api.tkAll(ALL), api.tkPeople(ALL).then((r) => r.people)]);
      if (ALL && !stores.length) stores = await api.listStores().catch(() => []);
      err = "";
    } catch (e) { err = e.message; }
    draw();
  }
  const draw = () => { const y = scrollY; root.replaceChildren(view()); scrollTo(0, y); };
  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg, 2000); await load(); return true; } catch (e) { toast(e.message, 4000); return false; } };

  async function create() {
    if (!people.length) { toast("이 사업장에 담당자로 지정할 직원 계정이 아직 없어요"); return; }
    const title = h("input", { type: "text", class: "inp", placeholder: "업무 내용 (예: 이번 주 송장 발행)", maxlength: "60" });
    const memo = h("textarea", { class: "inp", rows: "2", maxlength: "200", placeholder: "자세한 설명 (선택)" });
    const opt = (p) => h("option", { value: p.user_id }, `${p.display_name}${p.job_title ? " (" + p.job_title + ")" : ""}`);
    // 전 직원 모드: 사업장별로 묶어서 보여준다
    const groups = ALL ? [...new Set(people.map((p) => p.store_id))] : [];
    // 전 직원 모드: 사업장별로 묶인 체크 목록 — 여러 명을 고르면 한 명씩 따로(개별로) 지시된다
    const boxes = [];
    const who = ALL
      ? h("div", { class: "stack", style: "max-height:240px;overflow:auto;border:1px solid #ddd;border-radius:10px;padding:8px" }, ...groups.map((sid) => {
        const s = people.find((p) => p.store_id === sid)?.stores, mine = people.filter((p) => p.store_id === sid);
        const bs = mine.map((p) => { const b = h("input", { type: "checkbox", value: p.user_id }); boxes.push(b); return h("label", { style: "display:flex;gap:8px;align-items:center;margin:4px 0" }, b, `${p.display_name}${p.job_title ? " (" + p.job_title + ")" : ""}`); });
        const all = h("input", { type: "checkbox" }); all.onchange = () => mine.forEach((_, i) => { bs[i].firstChild.checked = all.checked; });
        return h("div", null, h("label", { style: "display:flex;gap:8px;align-items:center;font-weight:600" }, all, s?.display_name ?? s?.name ?? "사업장"), ...bs);
      }))
      : h("select", { class: "inp" }, ...people.map(opt));
    const picked = () => (ALL ? boxes.filter((b) => b.checked).map((b) => b.value) : [who.value]);
    const due = h("input", { type: "date", class: "inp", value: todayKST() });
    let repeat = "none";
    const repBox = h("div", { class: "stack" });
    const drawRep = () => repBox.replaceChildren(h("label", { class: "lbl" }, "반복"), seg([["none", "한 번"], ["daily", "매일"], ["weekly", "매주"], ["monthly", "매달"]], repeat, (v) => { repeat = v; drawRep(); }));
    drawRep();
    const content = h("div", { class: "stack" }, title, memo, h("label", { class: "lbl" }, "담당자"), who, h("label", { class: "lbl" }, "마감일 (반복이면 첫 마감일)"), due, repBox);
    for (;;) {
      if (!(await modal("업무 지시", content, "지시하기", "취소"))) return;
      if (!title.value.trim()) { toast("업무 내용을 입력해 주세요"); continue; }
      const ids = picked();
      if (!ids.length) { toast("담당자를 한 명 이상 골라 주세요"); continue; }
      if (await act(async () => { for (const id of ids) await api.tkCreate({ title: title.value, memo: memo.value, assignee_id: id, due_date: due.value, repeat }, ALL); }, ids.length > 1 ? `${ids.length}명에게 각각 지시했어요. 알림이 가요` : "지시했어요. 담당자에게 알림이 가요")) return;
    }
  }

  function row(t) {
    const late = t.due_date && t.due_date < data.today;
    return h("div", { class: "item col" },
      h("b", null, t.title, late ? h("span", { class: "badge bad", style: "margin-left:6px" }, "밀림") : null),
      h("span", { class: "muted" }, `${ALL ? (SHORT[stores.find((s) => s.id === t.store_id)?.app_key] ?? "") + " · " : ""}담당 ${t.assignee_name || "(삭제된 계정)"} · ${t.due_date ? "마감 " + labelMD(t.due_date) : "마감 없음"}${t.repeat !== "none" ? " · " + REPEAT_KO[t.repeat] + " 반복" : ""}`),
      t.memo && h("span", null, t.memo),
      t.status === "done" && h("span", { class: "ok-text" }, `✓ ${t.done_by_name} ${labelMD(dateOf(t.done_at))} ${fmtHM(t.done_at)}${t.done_note ? " — " + t.done_note : ""}`),
      h("div", { class: "acc-btns" },
        t.status === "open" && h("button", { class: "btn ghost slim danger", onclick: () => act(() => api.tkCancel(t.id, ALL), "취소했어요") }, "지시 취소"),
        t.status === "done" && h("button", { class: "btn ghost slim", onclick: () => act(() => api.tkReopen(t.id, ALL), "다시 열었어요") }, "다시 열기")));
  }

  function view() {
    const list = data ? (tab === "open" ? data.open : data.done) : [];
    // 담당자별 열린 업무·밀림 요약
    const sum = new Map();
    for (const t of data?.open ?? []) {
      const k = (ALL ? (SHORT[stores.find((s) => s.id === t.store_id)?.app_key] ?? "") + " " : "") + (t.assignee_name || "(삭제된 계정)");
      const s = sum.get(k) ?? { open: 0, late: 0 };
      s.open++; if (t.due_date && t.due_date < data.today) s.late++;
      sum.set(k, s);
    }
    return h("div", { class: "page" },
      onBack && h("button", { class: "linkbtn back", onclick: onBack }, "← 목록"),
      h("h1", null, ALL ? "업무지시 (전 직원)" : "업무지시"),
      h("button", { class: "btn primary", onclick: create }, "+ 업무 지시"),
      err && h("p", { class: "err" }, "불러오기 실패: " + err),
      sum.size > 0 && h("section", { class: "card" }, h("h2", null, "담당자별"),
        [...sum].map(([k, s]) => h("div", { class: "srow" }, h("span", null, k), h("b", null, `${s.open}건`, s.late ? h("span", { class: "badge bad", style: "margin-left:6px" }, `밀림 ${s.late}`) : null)))),
      h("div", { class: "tabs" }, [["open", "진행 중"], ["done", "최근 완료"]].map(([k, l]) => h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; draw(); } }, l))),
      !data ? h("p", { class: "muted" }, "불러오는 중…") : !list.length ? h("p", { class: "muted" }, tab === "open" ? "진행 중인 업무가 없어요" : "최근 완료한 업무가 없어요") : h("div", { class: "list" }, list.map(row)));
  }

  draw();
  await load();
}
