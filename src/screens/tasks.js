// 업무 화면(담당자): 지시받은 업무를 보고 완료를 보고한다
import { api } from "../lib/api.js";
import { h, toast, modal } from "../lib/ui.js";
import { dateOf, dow } from "../lib/kst.js";
import { t, dowNames } from "../lib/i18n.js";

export const REPEAT_KO = { none: "", daily: "매일", weekly: "매주", monthly: "매달" };

// 날짜 표시 "11/13(금)". 요일 글자만 화면 언어에 맞춘다(한국어에서는 kst.js 의 labelMD 와 똑같다)
const md = (s) => { const [, m, d] = s.split("-").map(Number); return `${m}/${d}(${dowNames()[dow(s)]})`; };

export async function renderTasks(root) {
  let data = null;
  let err = "";
  let busy = null;

  async function load() {
    try { data = await api.tkMine(); err = ""; } catch (e) { err = e.message; }
    draw();
  }
  const draw = () => { const y = scrollY; root.replaceChildren(view()); scrollTo(0, y); };

  async function complete(tk) {
    if (busy) return;
    const note = h("textarea", { class: "inp", rows: "3", maxlength: "200", placeholder: t("한 줄 메모 (선택) 예: 송장 32건 발행 완료") });
    if (!(await modal(t("완료 보고"), h("div", { class: "stack" }, h("p", { class: "muted" }, tk.title), note), t("완료했어요"), t("취소")))) return;
    busy = tk.id; draw();
    try { await api.tkComplete(tk.id, note.value); toast(t("완료로 보고했어요"), 2000); } catch (e) { toast(t(e.message), 4000); }
    busy = null;
    await load();
  }

  const dueLabel = (tk) => {
    if (!tk.due_date) return t("마감 없음");
    const d = tk.due_date;
    if (d < data.today) return t("⚠ 밀림 · {d}", { d: md(d) });
    if (d === data.today) return t("오늘 마감");
    return t("마감 {d}", { d: md(d) });
  };

  function card(tk) {
    const late = tk.due_date && tk.due_date < data.today;
    const sub = tk.repeat !== "none"
      ? t("{due} · {repeat} 반복 · 지시 {name}", { due: dueLabel(tk), repeat: t(REPEAT_KO[tk.repeat]), name: tk.created_by_name })
      : t("{due} · 지시 {name}", { due: dueLabel(tk), name: tk.created_by_name });
    return h("div", { class: "rt " + (late ? "overdue" : "") },
      h("div", { class: "rt-main" },
        h("div", { class: "rt-title" }, tk.title),
        tk.memo && h("div", { class: "rt-sub" }, tk.memo),
        h("div", { class: "rt-sub" }, sub)),
      h("button", { class: "done-btn", disabled: busy === tk.id, onclick: () => complete(tk) }, busy === tk.id ? "…" : t("완료")));
  }

  function view() {
    if (err) return h("div", { class: "page" }, h("p", { class: "err" }, t("불러오기 실패: {e}", { e: t(err) })), h("button", { class: "btn ghost", onclick: load }, t("다시 시도")));
    if (!data) return h("div", { class: "page" }, h("p", { class: "muted" }, t("불러오는 중…")));
    const late = data.open.filter((tk) => tk.due_date && tk.due_date < data.today);
    const todayList = data.open.filter((tk) => tk.due_date === data.today);
    const rest = data.open.filter((tk) => !late.includes(tk) && !todayList.includes(tk));
    const sec = (title, list) => list.length > 0 && h("div", null, h("div", { class: "cat-title" }, title), h("div", { class: "rowlist" }, list.map(card)));
    return h("div", { class: "page" },
      h("div", { class: "datebar" }, h("b", null, md(data.today)), h("span", null, t("남은 업무 {n}건", { n: data.open.length }))),
      !data.open.length && h("p", { class: "muted" }, t("지시받은 업무가 없어요 👍")),
      sec(t("밀린 업무"), late), sec(t("오늘 마감"), todayList), sec(t("예정"), rest),
      data.done.length > 0 && h("div", null, h("h2", { class: "sec-title" }, t("최근 완료 (7일)")),
        h("div", { class: "rowlist" }, data.done.map((tk) => h("div", { class: "rt done" },
          h("div", { class: "rt-main" }, h("div", { class: "rt-title" }, tk.title), tk.done_note && h("div", { class: "rt-sub" }, tk.done_note)),
          h("div", { class: "rt-state" }, "✓ " + md(dateOf(tk.done_at))))))));
  }

  draw();
  await load();
}
