// 매출 보고 화면(대표·부대표): 이번 달 입금 누계, 일별 통장 입금, 앞으로 정산 예정, 거래처(플랫폼·외주)별 받을 돈
import { api } from "../lib/api.js";
import { h } from "../lib/ui.js";
import { todayKST } from "../lib/kst.js";
import { won } from "../lib/settle.js";
import { salesReport } from "../lib/sales.js";

const man = (n) => Math.round(n / 10000).toLocaleString("ko-KR") + "만";

export async function renderSales(root, onBack, opts = {}) {
  const today = todayKST();
  let recv = [], deps = [], err = "", loading = true;

  async function load() {
    try {
      [recv, deps] = await Promise.all([api.stRecv(), api.stDeps()]);
      err = "";
    } catch (e) { err = e.message; }
    loading = false; draw();
  }

  const stat = (t, v, sub, cls = "") => h("div", { style: "flex:1;min-width:130px;padding:10px;border:1px solid #ddd;border-radius:12px" },
    h("div", { class: "muted", style: "font-size:12px" }, t), h("b", { class: cls, style: "font-size:17px" }, v), sub && h("div", { class: "muted", style: "font-size:12px" }, sub));

  function draw() {
    if (loading) return root.replaceChildren(h("div", { class: "page" }, h("p", { class: "muted" }, "불러오는 중…")));
    const r = salesReport(deps, recv, today);
    root.replaceChildren(h("div", { class: "page" },
      h("button", { class: "linkbtn back", onclick: onBack }, "← 목록"),
      h("h1", null, "📊 매출 보고"),
      err && h("p", { class: "err" }, "불러오기 실패: " + err + " (settle.sql·sales.sql 실행 여부 확인)"),
      r.stale && h("div", { class: "banner" }, r.lastDep ? `통장 내역이 ${r.lastDep}까지예요. 오늘 내역을 올리면 더 정확해요` : "통장 거래내역 엑셀을 먼저 올려 주세요",
        opts.onOpenSettle && h("button", { class: "linkbtn", onclick: opts.onOpenSettle }, "수금 대조에서 올리기")),

      h("section", { class: "card" },
        h("h2", null, `${Number(r.month.slice(5))}월 입금 현황`),
        h("p", null, h("b", { style: "font-size:20px" }, won(r.received)), `  (${r.elapsed}일 / ${r.dim}일)`),
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
          stat("월말 환산", man(r.projected) + "원", "지금 속도 그대로라면"),
          stat("앞으로 14일 정산 예정", man(r.upcomingTotal) + "원", `${r.upcoming.length}건`))),

      h("section", { class: "card" }, h("h2", null, "입금 (통장 기준)"),
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
          stat("오늘", won(r.todayAmount)), stat("어제", won(r.yesterdayAmount)),
          stat("이번 달 일평균", man(r.received / Math.max(1, r.elapsed)) + "원")),
        h("p", { class: "muted", style: "font-size:12px" }, "입금은 매출과 며칠 차이가 날 수 있어요. 정산 예정을 같이 보세요."),
        r.daily.length > 0 && h("details", null, h("summary", null, `이번 달 일별 입금 (${r.daily.length}일)`),
          h("table", { class: "stats" }, h("tbody", null, r.daily.map((d) => h("tr", null, h("td", null, d.date.slice(5)), h("td", { style: "text-align:right" }, won(d.amount)))))))),

      h("section", { class: "card" }, h("h2", null, "앞으로 정산 예정 (14일)"),
        r.upcoming.length ? r.upcoming.map((u) => h("div", { class: "srow" },
          h("span", null, `${u.date.slice(5)} · ${u.who}${u.estimated ? " (추정)" : ""}`), h("b", null, won(u.amount))))
          : h("p", { class: "muted" }, "예정된 정산이 없어요. 네이버·톡딜 정산내역을 올리면 나와요.")),

      h("section", { class: "card" }, h("h2", null, "거래처별 받을 돈 (플랫폼·외주 포함)"),
        r.parties.length ? r.parties.map((p) => h("div", { class: "item col" },
          h("b", null, p.who, " ", h("span", { class: "muted" }, `${p.count}건 · 다음 ${p.next?.slice(5) ?? "-"}`)),
          h("span", null, `받을 돈 ${won(p.open)}`, p.overdue > 0 ? h("span", { class: "badge bad", style: "margin-left:6px" }, `미입금 ${won(p.overdue)}`) : null)))
          : h("p", { class: "muted" }, "받을 돈이 없어요. 돌쇠 같은 외주는 수금 대조의 '＋ 직접 추가'로 넣어요.")),

      opts.onOpenSettle && h("button", { class: "btn ghost", onclick: opts.onOpenSettle }, "💰 수금 대조 열기 (자료 올리기·독촉)")));
  }

  draw();
  await load();
}
