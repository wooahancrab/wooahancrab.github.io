// 클레임 후속조치 화면: 등록(전 역할) · 진행 상태 · 메모 · 해결 처리(매니저/대표)
import { api } from "../lib/api.js";
import { h, toast, seg, modal } from "../lib/ui.js";
import { labelMD, fmtHM, dateOf } from "../lib/kst.js";

const STATUS = { open: ["접수", "bad"], working: ["처리 중", "warn"], done: ["해결", "ok"] };

export async function renderClaims(root) {
  let scope = "open";
  let data = null;
  let err = "";

  async function load() {
    try { data = await api.clList(scope); err = ""; } catch (e) { err = e.message; }
    draw();
  }
  const draw = () => { const y = scrollY; root.replaceChildren(view()); scrollTo(0, y); };
  const run = async (fn, okMsg) => {
    try { await fn(); if (okMsg) toast(okMsg, 2000); await load(); return true; } catch (e) { toast(e.message, 4000); return false; }
  };

  async function addClaim() {
    const content = h("textarea", { class: "inp", rows: "3", maxlength: "300", placeholder: "어떤 클레임인지 (예: 국이 식어서 나왔다는 말씀)" });
    let severity = "normal";
    const sevBox = h("div", { class: "stack" });
    const drawSev = () => sevBox.replaceChildren(
      seg([["normal", "일반"], ["severe", "중대"]], severity, (v) => { severity = v; drawSev(); }),
      h("p", { class: "hint" }, severity === "severe" ? "중대: 대표·매니저에게 바로 알림이 가요 (위생·이물질·안전·큰 항의)" : "일반: 목록에 기록되고, 하루 넘게 안 풀리면 대표에게 알려요"));
    drawSev();
    for (;;) {
      if (!(await modal("클레임 등록", h("div", { class: "stack" }, content, sevBox), "등록", "취소"))) return;
      if (!content.value.trim()) { toast("내용을 입력해 주세요"); continue; }
      if (await run(() => api.clCreate({ content: content.value, severity }), "등록했어요")) return;
    }
  }

  async function addNote(c) {
    const note = h("textarea", { class: "inp", rows: "3", maxlength: "300", placeholder: "진행 상황 (예: 손님께 전화드림)" });
    for (;;) {
      if (!(await modal("경과 메모", note, "저장", "취소"))) return;
      if (await run(() => api.clNote(c.id, note.value), "저장했어요")) return;
    }
  }

  async function setStatus(c, status) {
    let note = "";
    if (status === "done") {
      const inp = h("textarea", { class: "inp", rows: "3", maxlength: "300", placeholder: "어떻게 해결했는지 한 줄 (예: 사과 후 음식값 환불)" });
      if (!(await modal("해결 처리", inp, "해결 완료", "취소"))) return;
      note = inp.value;
    }
    await run(() => api.clStatus(c.id, status, note), "바꿨어요");
  }

  function card(c) {
    const [label, cls] = STATUS[c.status];
    return h("section", { class: "card" + (c.severity === "severe" && c.status !== "done" ? " claim-severe" : "") },
      h("div", { class: "badges" },
        c.severity === "severe" && h("span", { class: "badge bad" }, "🚨 중대"),
        h("span", { class: "badge " + cls }, label),
        h("span", { class: "muted" }, `${labelMD(c.claim_date)} · ${c.reported_name}`)),
      h("p", { class: "plain-pre", style: "margin:8px 0" }, c.content),
      h("ul", { class: "plain" }, (c.events ?? []).filter((e) => e.kind !== "created").map((e) =>
        h("li", null, h("span", { class: "muted" }, `${labelMD(dateOf(e.at))} ${fmtHM(e.at)} ${e.by_name}: `), e.note))),
      c.status === "done"
        ? h("p", { class: "muted" }, `${c.resolved_by_name} 해결 · ${labelMD(dateOf(c.resolved_at))} ${fmtHM(c.resolved_at)}`)
        : h("div", { class: "acc-btns" },
            h("button", { class: "btn ghost slim", onclick: () => addNote(c) }, "경과 메모"),
            data.can_manage && c.status === "open" && h("button", { class: "btn ghost slim", onclick: () => setStatus(c, "working") }, "처리 시작"),
            data.can_manage && h("button", { class: "btn primary slim", onclick: () => setStatus(c, "done") }, "해결 완료")));
  }

  function view() {
    if (err) return h("div", { class: "page" }, h("p", { class: "err" }, "불러오기 실패: " + err), h("button", { class: "btn ghost", onclick: load }, "다시 시도"));
    return h("div", { class: "page" },
      h("button", { class: "btn primary", onclick: addClaim }, "＋ 클레임 등록"),
      seg([["open", "진행 중"], ["done", "해결됨"]], scope, (v) => { scope = v; data = null; load(); }),
      !data ? h("p", { class: "muted" }, "불러오는 중…")
        : !data.claims.length ? h("p", { class: "muted" }, scope === "open" ? "처리할 클레임이 없어요 👍" : "해결된 클레임이 아직 없어요")
        : h("div", { class: "list" }, data.claims.map(card)));
  }

  draw();
  await load();
}
