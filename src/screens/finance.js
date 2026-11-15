// 재무 탭(정산 자료 올리기 권한 직원: 전무·경리): 사업장(게장·F&B)을 골라 매출·지출 보고와 통장·수금을 본다.
import { api } from "../lib/api.js";
import { h } from "../lib/ui.js";
import { t } from "../lib/i18n.js";
import { renderSales } from "./sales.js";
import { renderSettle } from "./settle.js";

export async function renderFinance(root) {
  let stores = [];
  try { stores = (await api.listStores()).filter((s) => ["gejang", "fnb"].includes(s.app_key)); }
  catch (e) { return root.replaceChildren(h("p", { class: "err", style: "padding:16px" }, t("사업장을 불러오지 못했어요: {msg}", { msg: t(String(e.message)) }))); }
  if (!stores.length) return root.replaceChildren(h("p", { class: "muted", style: "padding:16px" }, t("볼 수 있는 사업장이 없어요. 대표에게 권한을 확인해 달라고 해 주세요 (settle-all.sql)")));

  let cur = stores.find((s) => s.app_key === "fnb") ?? stores[0], mode = "sales";
  const bar = h("div", { class: "page", style: "padding-bottom:0" }), body = h("div");
  const show = () => {
    api.setStore(cur); // 아래 화면의 모든 조회·업로드가 이 사업장 기준
    const seg = (items, on, pick) => h("div", { class: "subtabs" }, items.map(([k, l]) => h("button", { class: "tab" + (on === k ? " on" : ""), onclick: () => pick(k) }, l)));
    bar.replaceChildren(
      seg(stores.map((s) => [s.id, s.display_name ?? s.name]), cur.id, (id) => { cur = stores.find((s) => s.id === id); show(); }),
      seg([["sales", "📊 " + t("매출·지출")], ["settle", "💰 " + t("통장·수금")]], mode, (k) => { mode = k; show(); }));
    const pane = h("div"); body.replaceChildren(pane);
    if (mode === "sales") renderSales(pane, null, { onOpenSettle: () => { mode = "settle"; show(); scrollTo(0, 0); } }); // 아래쪽 버튼으로 와도 새 화면은 맨 위부터(이전 화면의 스크롤 위치가 따라오지 않게)
    else renderSettle(pane, null);
  };
  root.append(bar, body);
  show();
}
