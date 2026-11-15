// 업무지시 관리(대표·부대표): 업무를 지시하고, 담당자별 진행·밀림을 본다
import { api } from "../lib/api.js";
import { h, toast, modal, seg } from "../lib/ui.js";
import { labelMD, dateOf, fmtHM, todayKST } from "../lib/kst.js";
import { t, tx } from "../lib/i18n.js";
import { REPEAT_KO } from "./tasks.js";

const SHORT = { gejang: "게장", ck: "CK", fnb: "F&B" };

// opts.all: 대표·부대표가 사업장 구분 없이 전 직원에게 지시(담당자 목록이 사업장별로 묶여 나옴)
export async function renderTasksAdmin(root, onBack, opts = {}) {
  const ALL = !!opts.all;
  let data = null, people = [], err = "";
  let tab = "open";
  let stores = [];
  const shortName = (storeId) => t(SHORT[stores.find((s) => s.id === storeId)?.app_key] ?? ""); // 사업장 약칭(전 직원 모드에서만 쓴다)

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
    if (!people.length) { toast(t("이 사업장에 담당자로 지정할 직원 계정이 아직 없어요")); return; }
    const title = h("input", { type: "text", class: "inp", placeholder: t("업무 내용 (예: 이번 주 송장 발행)"), maxlength: "60" });
    const memo = h("textarea", { class: "inp", rows: "2", maxlength: "200", placeholder: t("자세한 설명 (선택)") });
    const opt = (p) => h("option", { value: p.user_id }, `${p.display_name}${p.job_title ? " (" + p.job_title + ")" : ""}`);
    // 전 직원 모드: 사업장별로 묶어서 보여준다
    const groups = ALL ? [...new Set(people.map((p) => p.store_id))] : [];
    // 전 직원 모드: 사업장별로 묶인 체크 목록 — 여러 명을 고르면 한 명씩 따로(개별로) 지시된다
    const boxes = [];
    const who = ALL
      ? h("div", { class: "stack", style: "max-height:240px;overflow:auto;border:1px solid var(--line-ctl);border-radius:var(--r-md);padding:var(--s2)" }, ...groups.map((sid) => {
        const s = people.find((p) => p.store_id === sid)?.stores, mine = people.filter((p) => p.store_id === sid);
        const bs = mine.map((p) => { const b = h("input", { type: "checkbox", value: p.user_id }); boxes.push(b); return h("label", { style: "display:flex;gap:10px;align-items:center;min-height:44px" }, b,`${p.display_name}${p.job_title ? " (" + p.job_title + ")" : ""}`); });
        const all = h("input", { type: "checkbox" }); all.onchange = () => mine.forEach((_, i) => { bs[i].firstChild.checked = all.checked; });
        return h("div", null, h("label", { style: "display:flex;gap:10px;align-items:center;min-height:44px;font-weight:700" }, all,s?.display_name ?? s?.name ?? t("사업장")), ...bs);
      }))
      : h("select", { class: "inp" }, ...people.map(opt));
    const picked = () => (ALL ? boxes.filter((b) => b.checked).map((b) => b.value) : [who.value]);
    const due = h("input", { type: "date", class: "inp", value: todayKST() });
    let repeat = "none";
    const repBox = h("div", { class: "stack" });
    const drawRep = () => repBox.replaceChildren(h("label", { class: "lbl" }, t("반복")), seg([["none", t("한 번")], ["daily", t("매일")], ["weekly", t("매주")], ["monthly", t("매달")]], repeat, (v) => { repeat = v; drawRep(); }));
    drawRep();
    const content = h("div", { class: "stack" }, title, memo, h("label", { class: "lbl" }, t("담당자")), who, h("label", { class: "lbl" }, t("마감일 (반복이면 첫 마감일)")), due, repBox);
    for (;;) {
      if (!(await modal(t("업무 지시"), content, t("지시하기"), t("취소")))) return;
      if (!title.value.trim()) { toast(t("업무 내용을 입력해 주세요")); continue; }
      const ids = picked();
      if (!ids.length) { toast(t("담당자를 한 명 이상 골라 주세요")); continue; }
      if (await act(async () => { for (const id of ids) await api.tkCreate({ title: title.value, memo: memo.value, assignee_id: id, due_date: due.value, repeat }, ALL); }, ids.length > 1 ? t("{n}명에게 각각 지시했어요. 알림이 가요", { n: ids.length }) : t("지시했어요. 담당자에게 알림이 가요"))) return;
    }
  }

  function row(tk) {
    const late = tk.due_date && tk.due_date < data.today;
    return h("div", { class: "item col" },
      h("b", null, tk.title, late ? h("span", { class: "badge bad", style: "margin-left:6px" }, t("밀림")) : null),
      h("span", { class: "muted" }, `${ALL ? shortName(tk.store_id) + " · " : ""}${t("담당 {name}", { name: tk.assignee_name || t("(삭제된 계정)") })} · ${tk.due_date ? t("마감 {d}", { d: labelMD(tk.due_date) }) : t("마감 없음")}${tk.repeat !== "none" ? " · " + t("{repeat} 반복", { repeat: t(REPEAT_KO[tk.repeat]) }) : ""}`),
      tk.memo && h("span", null, tk.memo),
      tk.status === "done" && h("span", { class: "ok-text" }, `✓ ${tk.done_by_name} ${labelMD(dateOf(tk.done_at))} ${fmtHM(tk.done_at)}${tk.done_note ? " — " + tk.done_note : ""}`),
      h("div", { class: "acc-btns" },
        tk.status === "open" && h("button", { class: "btn ghost slim danger", onclick: () => act(() => api.tkCancel(tk.id, ALL), t("취소했어요")) }, t("지시 취소")),
        tk.status === "done" && h("button", { class: "btn ghost slim", onclick: () => act(() => api.tkReopen(tk.id, ALL), t("다시 열었어요")) }, t("다시 열기"))));
  }

  function view() {
    const list = data ? (tab === "open" ? data.open : data.done) : [];
    // 담당자별 열린 업무·밀림 요약
    const sum = new Map();
    for (const tk of data?.open ?? []) {
      const k = (ALL ? shortName(tk.store_id) + " " : "") + (tk.assignee_name || t("(삭제된 계정)"));
      const s = sum.get(k) ?? { open: 0, late: 0 };
      s.open++; if (tk.due_date && tk.due_date < data.today) s.late++;
      sum.set(k, s);
    }
    return h("div", { class: "page" },
      onBack && h("button", { class: "linkbtn back", onclick: onBack }, t("← 목록")),
      h("h1", null, ALL ? t("업무지시 (전 직원)") : t("업무지시")),
      h("button", { class: "btn primary", onclick: create }, t("+ 업무 지시")),
      err && h("p", { class: "err" }, t("불러오기 실패: {msg}", { msg: t(err) })),
      sum.size > 0 && h("section", { class: "card" }, h("h2", null, t("담당자별")),
        [...sum].map(([k, s]) => h("div", { class: "lrow" }, h("span", null, k), h("b", null, tx("업무", "{n}건", { n: s.open }), s.late ? h("span", { class: "badge bad", style: "margin-left:6px" }, t("밀림 {n}", { n: s.late })) : null)))),
      h("div", { class: "tabs" }, [["open", tx("업무", "진행 중")], ["done", t("최근 완료")]].map(([k, l]) => h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; draw(); } }, l))),
      !data ? h("p", { class: "muted" }, t("불러오는 중…")) : !list.length ? h("p", { class: "muted" }, tab === "open" ? t("진행 중인 업무가 없어요") : t("최근 완료한 업무가 없어요")) : h("div", { class: "list" }, list.map(row)));
  }

  draw();
  await load();
}
