// 화면 언어 설정(한국어·베트남어·영어). 어떤 언어로 바뀌어 있어도 되돌릴 수 있게 문구는 세 언어를 함께 쓴다.
import { h, modal } from "../lib/ui.js";
import { LANGS, lang } from "../lib/i18n.js";

/** 고른 언어 코드를 돌려준다(취소하면 null) */
export async function openLangSettings() {
  let pick = lang();
  const box = h("div", { class: "seg" });
  const paint = () => box.replaceChildren(...LANGS.map(([k, label]) =>
    h("button", { type: "button", class: "segbtn" + (pick === k ? " on" : ""), "aria-pressed": pick === k ? "true" : "false", onclick: () => { pick = k; paint(); } }, label)));
  paint();
  const content = h("div", { class: "stack" }, h("p", { class: "hint" }, "화면 언어 · Ngôn ngữ hiển thị · Display language"), box);
  const ok = await modal("🌐 언어 · Ngôn ngữ · Language", content, "확인 · Xác nhận · OK", "취소 · Hủy · Cancel");
  return ok ? pick : null;
}
