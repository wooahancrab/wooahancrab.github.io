// 업무 화면(담당자): 지시받은 업무를 보고 완료를 보고한다
import { api } from "../lib/api.js";
import { h, toast, modal } from "../lib/ui.js";
import { labelMD, dateOf } from "../lib/kst.js";

export const REPEAT_KO = { none: "", daily: "매일", weekly: "매주", monthly: "매달" };

export async function renderTasks(root) {
  let data = null;
  let err = "";
  let busy = null;

  async function load() {
    try { data = await api.tkMine(); err = ""; } catch (e) { err = e.message; }
    draw();
  }
  const draw = () => { const y = scrollY; root.replaceChildren(view()); scrollTo(0, y); };

  async function complete(t) {
    if (busy) return;
    const note = h("textarea", { class: "inp", rows: "3", maxlength: "200", placeholder: "한 줄 메모 (선택) 예: 송장 32건 발행 완료" });
    if (!(await modal("완료 보고", h("div", { class: "stack" }, h("p", { class: "muted" }, t.title), note), "완료했어요", "취소"))) return;
    busy = t.id; draw();
    try { await api.tkComplete(t.id, note.value); toast("완료로 보고했어요", 2000); } catch (e) { toast(e.message, 4000); }
    busy = null;
    await load();
  }

  const dueLabel = (t) => {
    if (!t.due_date) return "마감 없음";
    const d = t.due_date;
    if (d < data.today) return `⚠ 밀림 · ${labelMD(d)}`;
    if (d === data.today) return "오늘 마감";
    return `마감 ${labelMD(d)}`;
  };

  function card(t) {
    const late = t.due_date && t.due_date < data.today;
    return h("div", { class: "rt " + (late ? "overdue" : "") },
      h("div", { class: "rt-main" },
        h("div", { class: "rt-title" }, t.title),
        t.memo && h("div", { class: "rt-sub" }, t.memo),
        h("div", { class: "rt-sub" }, `${dueLabel(t)}${t.repeat !== "none" ? " · " + REPEAT_KO[t.repeat] + " 반복" : ""} · 지시 ${t.created_by_name}`)),
      h("button", { class: "done-btn", disabled: busy === t.id, onclick: () => complete(t) }, busy === t.id ? "…" : "완료"));
  }

  function view() {
    if (err) return h("div", { class: "page" }, h("p", { class: "err" }, "불러오기 실패: " + err), h("button", { class: "btn ghost", onclick: load }, "다시 시도"));
    if (!data) return h("div", { class: "page" }, h("p", { class: "muted" }, "불러오는 중…"));
    const late = data.open.filter((t) => t.due_date && t.due_date < data.today);
    const todayList = data.open.filter((t) => t.due_date === data.today);
    const rest = data.open.filter((t) => !late.includes(t) && !todayList.includes(t));
    const sec = (title, list) => list.length > 0 && h("div", null, h("div", { class: "cat-title" }, title), h("div", { class: "list" }, list.map(card)));
    return h("div", { class: "page" },
      h("div", { class: "datebar" }, h("b", null, labelMD(data.today)), h("span", null, `남은 업무 ${data.open.length}건`)),
      !data.open.length && h("p", { class: "muted" }, "지시받은 업무가 없어요 👍"),
      sec("밀린 업무", late), sec("오늘 마감", todayList), sec("예정", rest),
      data.done.length > 0 && h("div", null, h("div", { class: "cat-title" }, "최근 완료 (7일)"),
        h("div", { class: "list" }, data.done.map((t) => h("div", { class: "rt done" },
          h("div", { class: "rt-main" }, h("div", { class: "rt-title" }, t.title), t.done_note && h("div", { class: "rt-sub" }, t.done_note)),
          h("div", { class: "rt-state" }, "✓ " + labelMD(dateOf(t.done_at))))))));
  }

  draw();
  await load();
}
