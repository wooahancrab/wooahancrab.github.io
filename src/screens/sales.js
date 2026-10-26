// 매출 보고 화면(대표·부대표): 월 입금 누계, 입금 구분(카드·온라인정산·기타), 지출 분석, 앞으로 정산 예정, 거래처별 받을 돈
import { api } from "../lib/api.js";
import { h } from "../lib/ui.js";
import { todayKST, addDays } from "../lib/kst.js";
import { won } from "../lib/settle.js";
import { salesReport } from "../lib/sales.js";
import { depositBreakdown, spendReport } from "../lib/bank.js";

const man = (n) => Math.round(n / 10000).toLocaleString("ko-KR") + "만";

export async function renderSales(root, onBack, opts = {}) {
  const today = todayKST();
  const thisMonth = today.slice(0, 7);
  const prevMonth = addDays(thisMonth + "-01", -1).slice(0, 7);
  let recv = [], deps = [], wds = [], err = "", loading = true, view = thisMonth;

  async function load() {
    try {
      [recv, deps] = await Promise.all([api.stRecv(), api.stDeps()]);
      wds = await api.stWds().catch(() => []); // bank.sql 실행 전에는 출금 내역 없이 보여준다
      err = "";
    } catch (e) { err = e.message; }
    loading = false; draw();
  }

  const stat = (t, v, sub, cls = "") => h("div", { style: "flex:1;min-width:130px;padding:10px;border:1px solid #ddd;border-radius:12px" },
    h("div", { class: "muted", style: "font-size:12px" }, t), h("b", { class: cls, style: "font-size:17px" }, v), sub && h("div", { class: "muted", style: "font-size:12px" }, sub));

  function draw() {
    if (loading) return root.replaceChildren(h("div", { class: "page" }, h("p", { class: "muted" }, "불러오는 중…")));
    // 지난달을 보면 그 달의 마지막 날을 기준일로 해서 "월말 환산" 없이 확정 숫자를 보여준다
    const asOf = view === thisMonth ? today : addDays(thisMonth + "-01", -1);
    const r = salesReport(deps, recv, asOf);
    const inB = depositBreakdown(deps, view);
    const sp = spendReport(wds, view);
    const cardTotal = inB.find((g) => g.group === "카드")?.total ?? 0;
    const tabs = h("div", { class: "tabs" }, [[thisMonth, `${Number(thisMonth.slice(5))}월 (이번 달)`], [prevMonth, `${Number(prevMonth.slice(5))}월 (지난달)`]].map(([k, l]) =>
      h("button", { class: "tab" + (view === k ? " on" : ""), onclick: () => { view = k; draw(); } }, l)));

    root.replaceChildren(h("div", { class: "page" },
      h("button", { class: "linkbtn back", onclick: onBack }, "← 목록"),
      h("h1", null, "📊 매출·지출 보고"),
      err && h("p", { class: "err" }, "불러오기 실패: " + err + " (settle.sql·sales.sql·bank.sql 실행 여부 확인)"),
      tabs,
      view === thisMonth && r.stale && h("div", { class: "banner" }, r.lastDep ? `통장 내역이 ${r.lastDep}까지예요. 오늘 내역을 올리면 더 정확해요` : "통장 거래내역 엑셀을 먼저 올려 주세요",
        opts.onOpenSettle && h("button", { class: "linkbtn", onclick: opts.onOpenSettle }, "수금 대조에서 올리기")),

      h("section", { class: "card" },
        h("h2", null, `${Number(view.slice(5))}월 입금 현황`),
        h("p", null, h("b", { style: "font-size:20px" }, won(r.received)), view === thisMonth ? `  (${r.elapsed}일 / ${r.dim}일)` : "  (한 달 전체)"),
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
          stat("카드 입금", won(cardTotal), "카드 매출의 입금분"),
          view === thisMonth && stat("월말 환산", man(r.projected) + "원", "지금 속도 그대로라면"),
          stat("지출 (출금)", won(sp.total), `${sp.cats.length}개 항목`),
          view === thisMonth && stat("앞으로 14일 정산 예정", man(r.upcomingTotal) + "원", `${r.upcoming.length}건`))),

      h("section", { class: "card" }, h("h2", null, "입금 구분"),
        inB.length ? inB.map((g) => h("details", { style: "margin:6px 0" },
          h("summary", null, h("b", null, g.group), `  ${won(g.total)}  (${g.n}건)`),
          g.items.slice(0, 15).map((i) => h("div", { class: "srow" }, h("span", { class: "muted" }, i.name), h("span", null, won(i.total))))))
          : h("p", { class: "muted" }, "이 달 입금 내역이 없어요"),
        h("p", { class: "muted", style: "font-size:12px" }, "카드사 입금은 카드 매출, 대표·가족 이체는 매출이 아니에요. 입금은 매출과 며칠 차이가 날 수 있어요.")),

      h("section", { class: "card" }, h("h2", null, "지출 분석 (출금)"),
        sp.cats.length ? sp.cats.map((c) => h("details", { style: "margin:6px 0" },
          h("summary", null, h("b", null, c.name), `  ${won(c.total)}  (${c.n}건)`),
          c.items.slice(0, 15).map((i) => h("div", { class: "srow" }, h("span", { class: "muted" }, i.name), h("span", null, won(i.total))))))
          : h("p", { class: "muted" }, "출금 내역이 없어요. 통장 거래내역을 올리면 나와요."),
        sp.daily.length > 0 && h("details", null, h("summary", null, `일별 지출 (${sp.daily.length}일)`),
          h("table", { class: "stats" }, h("tbody", null, sp.daily.map((d) => h("tr", null, h("td", null, d.date.slice(5)), h("td", { style: "text-align:right" }, won(d.amount)))))))),

      view === thisMonth && h("section", { class: "card" }, h("h2", null, "앞으로 정산 예정 (14일)"),
        r.upcoming.length ? r.upcoming.map((u) => h("div", { class: "srow" },
          h("span", null, `${u.date.slice(5)} · ${u.who}${u.estimated ? " (추정)" : ""}`), h("b", null, won(u.amount))))
          : h("p", { class: "muted" }, "예정된 정산이 없어요. 네이버·톡딜 정산내역을 올리면 나와요.")),

      view === thisMonth && h("section", { class: "card" }, h("h2", null, "거래처별 받을 돈 (플랫폼·외주 포함)"),
        r.parties.length ? r.parties.map((p) => h("div", { class: "item col" },
          h("b", null, p.who, " ", h("span", { class: "muted" }, `${p.count}건 · 다음 ${p.next?.slice(5) ?? "-"}`)),
          h("span", null, `받을 돈 ${won(p.open)}`, p.overdue > 0 ? h("span", { class: "badge bad", style: "margin-left:6px" }, `미입금 ${won(p.overdue)}`) : null)))
          : h("p", { class: "muted" }, "받을 돈이 없어요. 돌쇠 같은 외주는 수금 대조의 '＋ 직접 추가'로 넣어요.")),

      opts.onOpenSettle && h("button", { class: "btn ghost", onclick: opts.onOpenSettle }, "💰 수금 대조 열기 (자료 올리기·독촉)")));
  }

  draw();
  await load();
}
