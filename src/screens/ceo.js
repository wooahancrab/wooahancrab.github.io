// 우아한F&B 본사(대표용) 총괄 앱: 3개 사업장의 오늘 현황을 한눈에 보고, 사업장을 눌러 관리·지시한다
import { api } from "../lib/api.js";
import { h, toast } from "../lib/ui.js";
import { fmtHM } from "../lib/kst.js";
import { renderOwner } from "./owner.js";

const SHORT = { gejang: "게장", ck: "CK", fnb: "F&B" };
const KIND_ICON = { restaurant: "🦀", ck: "🏭", hq: "🏢" };

export async function renderCeo(root, profile) {
  let stores = [];
  let ov = null;
  let err = "";
  let sel = "all";
  let accountsOpen = false; // 전체 계정 관리 화면
  try { sel = localStorage.getItem("woo_ceo_sel") || "all"; } catch { /* 저장소를 못 쓰는 환경 */ }

  const badge = (t, c) => h("span", { class: "badge " + c }, t);

  async function load() {
    try {
      [stores, ov] = await Promise.all([api.listStores(), api.overview()]);
      err = "";
      if (sel !== "all" && !stores.some((s) => s.id === sel)) sel = "all";
    } catch (e) { err = e.message; }
    draw();
  }

  function choose(id) {
    sel = id;
    try { localStorage.setItem("woo_ceo_sel", id); } catch { /* 무시 */ }
    draw();
  }

  function chips() {
    return h("div", { class: "chips-bar" }, [{ id: "all", label: "전체" }, ...stores.map((s) => ({ id: s.id, label: SHORT[s.app_key] ?? s.name }))].map((c) =>
      h("button", { class: "chip" + (sel === c.id ? " on" : ""), onclick: () => choose(c.id) }, c.label)));
  }

  function needs(st) {
    const a = st.attendance;
    const n = [];
    if (a.not_in) n.push(["미출근 " + a.not_in, "bad"]);
    if (a.missing_out) n.push(["퇴근 누락 " + a.missing_out, "bad"]);
    if (a.pending_approval) n.push(["승인 대기 " + a.pending_approval, "info"]);
    if (st.kind !== "restaurant") { /* CK·F&B는 클레임 없음 */ }
    else if (st.claims.severe) n.push(["중대 클레임 " + st.claims.severe, "bad"]);
    else if (st.claims.open) n.push(["클레임 처리 중 " + st.claims.open, "warn"]);
    if (st.report && !st.report.submitted && !st.closed) n.push(["일일보고 미제출", "warn"]);
    if (st.report?.has_claim) n.push(["클레임 있음", "warn"]);
    if (st.report?.has_request) n.push(["요청사항", "info"]);
    return n;
  }

  function card(st) {
    const a = st.attendance;
    const alerts = needs(st);
    return h("button", { class: "scard", onclick: () => choose(st.id) },
      h("div", { class: "top2" }, h("b", null, `${KIND_ICON[st.kind] ?? ""} ${st.display_name}`), st.closed ? badge("휴무", "warn2") : alerts.some(([, c]) => c === "bad") ? badge("확인 필요", "bad") : badge("정상", "ok")),
      h("div", { class: "srow" }, h("span", null, "👥 출근"), h("b", null, `${a.in_today} / ${st.people}명`), a.working > 0 && h("span", { class: "muted" }, `근무 중 ${a.working}`)),
      st.kind === "restaurant" && h("div", { class: "srow" }, h("span", null, "📣 클레임"), h("b", null, st.claims.open ? `${st.claims.open}건 진행 중` : "없음")),
      st.report && h("div", { class: "srow" }, h("span", null, "📝 일일보고"), h("b", null, st.report.submitted ? "제출 " + fmtHM(st.report.at) : st.closed ? "휴무" : "미제출")),
      alerts.length > 0 && h("div", { class: "badges", style: "justify-content:flex-start;margin-top:6px" }, alerts.map(([t, c]) => badge(t, c))));
  }

  function allView() {
    const totalBad = ov.stores.reduce((s, st) => s + needs(st).filter(([, c]) => c === "bad").length, 0);
    return h("div", null,
      h("section", { class: "card" }, h("h2", null, "오늘 한눈에"),
        totalBad > 0 ? h("p", { class: "err" }, `확인이 필요한 항목 ${totalBad}건`) : h("p", { class: "muted" }, "지금 밀린 항목이 없어요 👍")),
      h("div", { class: "list" }, ov.stores.map(card)),
      // 대표(마스터)만: 모든 사업장 계정을 한 곳에서 관리 (부대표는 전체 소속)
      profile.role === "owner" && h("button", { class: "btn ghost", style: "margin-top:12px", onclick: () => { accountsOpen = true; draw(); } }, "👤 전체 계정 관리 (사업장·부대표 포함)"));
  }

  function accountsView() {
    const holder = h("div", { id: "ceo-accounts" });
    api.setStore(null);
    renderOwner(holder, profile, { allAccounts: true, stores, onBack: () => { accountsOpen = false; draw(); } });
    return holder;
  }

  function storeView() {
    const st = stores.find((s) => s.id === sel);
    api.setStore(st);
    const holder = h("div", { id: "ceo-store" });
    renderOwner(holder, profile, { store: st, embedded: true });
    return holder;
  }

  function draw() {
    const y = scrollY;
    if (sel === "all") api.setStore(null);
    root.replaceChildren(h("div", { class: "page", style: "padding-bottom:0" }, chips()),
      err ? h("div", { class: "page" }, h("p", { class: "err" }, "불러오기 실패: " + err), h("button", { class: "btn ghost", onclick: load }, "다시 시도"))
        : !ov ? h("div", { class: "page" }, h("p", { class: "muted" }, "불러오는 중…"))
        : sel === "all" ? (accountsOpen ? accountsView() : h("div", { class: "page" }, allView())) : storeView());
    scrollTo(0, y);
  }

  draw();
  await load();
  void toast;
}
