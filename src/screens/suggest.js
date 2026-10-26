// 건의함: 직원은 쓰기만 하고(보낸 뒤에는 다시 못 봄), 읽고 처리하는 건 대표만 한다.
import { api } from "../lib/api.js";
import { h, toast, confirmDialog } from "../lib/ui.js";
import { dateOf, labelMD } from "../lib/kst.js";

const CATS = ["업무 개선", "불편·고충", "칭찬·감사", "기타"];

/** 직원 화면: 건의 쓰기 */
export function renderSuggest(root) {
  let sent = false, busy = false;
  const draw = () => {
    if (sent) return root.replaceChildren(h("div", { class: "page" }, h("h1", null, "💌 건의함"),
      h("p", null, "건의가 전달됐어요. 고마워요 🙏"), h("p", { class: "muted" }, "대표만 읽을 수 있어요."),
      h("button", { class: "btn ghost", onclick: () => { sent = false; draw(); } }, "하나 더 쓰기")));
    const cat = h("select", { class: "inp" }, CATS.map((c) => h("option", { value: c }, c)));
    const body = h("textarea", { class: "inp", rows: "7", maxlength: "2000", placeholder: "회사에 하고 싶은 말을 편하게 적어 주세요. 불편한 점, 개선 아이디어, 고마웠던 일 모두 좋아요." });
    const anon = h("input", { type: "checkbox" });
    root.replaceChildren(h("div", { class: "page" }, h("h1", null, "💌 건의함"),
      h("p", { class: "muted", style: "font-size:13px" }, "쓴 내용은 대표만 읽을 수 있어요. 다른 직원이나 관리자는 볼 수 없어요."),
      cat, body,
      h("label", { style: "display:flex;gap:8px;align-items:center;margin:8px 0" }, anon, "이름을 숨기고 보내기"),
      h("p", { class: "muted", style: "font-size:12px" }, "이름 숨김을 고르면 대표 화면에 이름이 보이지 않아요. (시스템 기록에는 남아요)"),
      h("button", { class: "btn primary", disabled: busy, onclick: async () => {
        if (!body.value.trim()) return toast("내용을 적어 주세요");
        busy = true;
        try { await api.sgSend({ category: cat.value, body: body.value.trim(), anon: anon.checked }); sent = true; } catch (e) { toast(e.message, 5000); }
        busy = false; draw();
      } }, "보내기")));
  };
  draw();
}

/** 대표 화면: 받은 건의 읽기·처리 */
export async function renderSuggestAdmin(root, onBack) {
  let list = [], err = "", filter = "새글";
  async function load() { try { list = await api.sgList(); err = ""; } catch (e) { err = e.message; } draw(); }
  async function setStatus(r, status) { try { await api.sgSet(r.id, { status }); await load(); } catch (e) { toast(e.message, 4000); } }
  async function del(r) {
    if (!(await confirmDialog("이 건의를 지울까요?", [r.body.slice(0, 40)], "취소", "지우기"))) return;
    try { await api.sgDelete(r.id); await load(); } catch (e) { toast(e.message, 4000); }
  }
  function draw() {
    const y = scrollY;
    const shown = list.filter((r) => filter === "all" || r.status === filter);
    const count = (s) => list.filter((r) => r.status === s).length;
    root.replaceChildren(h("div", { class: "page" },
      onBack && h("button", { class: "linkbtn back", onclick: onBack }, "← 목록"),
      h("h1", null, "💌 건의함"),
      err && h("p", { class: "err" }, "불러오기 실패: " + err + " (suggestions.sql 실행 여부 확인)"),
      h("div", { class: "tabs" }, [["새글", `새 건의 ${count("새글")}`], ["확인", `확인 ${count("확인")}`], ["처리", `처리 ${count("처리")}`], ["all", "전체"]].map(([k, l]) =>
        h("button", { class: "tab" + (filter === k ? " on" : ""), onclick: () => { filter = k; draw(); } }, l))),
      !shown.length ? h("p", { class: "muted" }, "해당하는 건의가 없어요") : shown.map((r) => h("div", { class: "card", style: "margin:8px 0;padding:12px;border:1px solid #ddd;border-radius:12px" },
        h("div", { style: "display:flex;justify-content:space-between;gap:8px" },
          h("b", null, r.category), h("span", { class: "muted", style: "font-size:12px" }, labelMD(dateOf(r.created_at)))),
        h("div", { class: "muted", style: "font-size:12px" }, `${r.stores?.display_name ?? r.stores?.name ?? ""} · ${r.anon ? "이름 숨김" : r.author_name || "(이름 없음)"}`),
        h("div", { style: "white-space:pre-wrap;margin:8px 0" }, r.body),
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
          r.status !== "확인" && r.status !== "처리" && h("button", { class: "btn ghost slim", onclick: () => setStatus(r, "확인") }, "읽었어요"),
          r.status !== "처리" && h("button", { class: "btn ghost slim", onclick: () => setStatus(r, "처리") }, "처리 완료"),
          r.status !== "새글" && h("button", { class: "linkbtn", onclick: () => setStatus(r, "새글") }, "새글로"),
          h("button", { class: "linkbtn", onclick: () => del(r) }, "삭제"))))));
    scrollTo(0, y);
  }
  draw();
  await load();
}
