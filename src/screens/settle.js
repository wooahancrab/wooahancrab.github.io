// 수금 대조 화면(대표 전용): 받을 돈 vs 통장 입금을 매일 확인하고 빠진 곳을 독촉한다.
import { api } from "../lib/api.js";
import { h, toast, copyText, confirmDialog } from "../lib/ui.js";
import { t, tx } from "../lib/i18n.js";
import { todayKST, addDays } from "../lib/kst.js";
import { parseBankStatement } from "../lib/bank.js";
import { parseInvoices } from "../lib/invoice-match.js";
import { SOURCES, won, partyName, reconcile, summarize, parseBank, parseInvoice, parseSettle, parseDolsoe, parseGrip, dunText, toDate } from "../lib/settle.js";

const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
let xlsxP;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return (xlsxP ??= new Promise((ok, no) => {
    const s = h("script", { src: XLSX_URL });
    s.onload = () => ok(window.XLSX); s.onerror = () => { xlsxP = null; no(new Error(t("엑셀 읽기 도구를 불러오지 못했어요. 인터넷을 확인해 주세요"))); };
    document.head.append(s);
  }));
}
async function readBook(file) { // 모든 시트를 2차원 배열의 배열로
  const X = await loadXlsx();
  const wb = X.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  return wb.SheetNames.map((n) => X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }));
}
async function readSheet(file) { return (await readBook(file))[0]; } // 첫 시트

// 화면 언어에 따라 글자가 바뀌어서 함수로 둔다(모듈이 불러와질 때는 아직 화면 언어가 정해지기 전이다)
const statusOf = (s) => ({
  overdue: [t("미입금"), "err"], diff: [t("금액 다름"), "err"], waiting: [t("입금 대기"), "muted"],
  paid: [t("입금 확인"), "ok-text"], paid_late: [t("늦게 입금"), "ok-text"], closed: [tx("상태", "종결"), "muted"],
}[s]);
const tabList = () => [["overdue", "🚨 " + t("미입금")], ["diff", "⚠ " + t("금액 다름")], ["waiting", "⏳ " + t("대기")], ["done", "✅ " + t("완료")]];

export async function renderSettle(root, onBack) {
  const today = todayKST();
  let recv = [], deps = [], tab = "overdue", termDays = 30, busy = false, loadErr = null;

  async function load() {
    try { [recv, deps] = await Promise.all([api.stRecv(), api.stDeps()]); loadErr = null; } catch (e) { loadErr = e.message; }
    draw();
  }

  function compute() {
    // 최근 400일치만 대조(오래된 입금이 새 건에 잘못 붙는 것 방지)
    return reconcile(recv, deps, { today });
  }

  async function pickFile(accept, handler, allSheets = false) {
    const inp = h("input", { type: "file", accept, style: "display:none" });
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      busy = true; draw();
      try { await handler(allSheets ? await readBook(f) : await readSheet(f)); } catch (e) { toast(e.message, 6000); }
      busy = false; await load();
    };
    document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
  }

  // 통장 거래내역: 입금은 수금 대조·매출에, 출금은 지출 분석에 쓴다. 시트가 여러 개거나 겹쳐도 중복 없이 한 번만 반영한다.
  const upBank = () => pickFile(".xlsx,.xls,.csv,.nxl", async (sheets) => {
    const r = parseBankStatement(sheets);
    const nIn = await api.stAddDeps(r.deposits.map((d) => ({ date: d.date, amount: d.amount, memo: d.memo, ref: d.ref })));
    const nOut = await api.stAddWds(r.withdrawals);
    toast(t("입금 {a}건 중 새로 {b}건, 출금 {c}건 중 새로 {d}건 반영했어요", { a: r.deposits.length, b: nIn, c: r.withdrawals.length, d: nOut }), 6000);
  }, true);
  // 홈택스 매입 (세금)계산서 — 계산서·세금계산서 파일을 한꺼번에 골라도 된다(승인번호로 중복 제거)
  const upInvs = () => {
    const inp = h("input", { type: "file", accept: ".xlsx,.xls,.csv", multiple: true, style: "display:none" });
    inp.onchange = async () => {
      const fs = [...inp.files]; if (!fs.length) return;
      busy = true; draw();
      try {
        const list = parseInvoices((await Promise.all(fs.map(readBook))).flat());
        const added = await api.stAddInvs(list);
        toast(t("매입 계산서 {n}건 중 새로 {m}건 반영했어요 (매출·지출 화면의 '계산서 대조'에서 확인)", { n: list.length, m: added }), 7000);
      } catch (e) { toast(e.message, 6000); }
      busy = false; await load();
    };
    document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
  };
  const upSettle = (source) => pickFile(".xlsx,.xls,.csv", async (rows) => {
    const list = parseSettle(rows, source);
    const added = await api.stAddRecv(list);
    toast(t("{src} 정산 {n}일치 중 새로 {m}건 반영했어요", { src: partyName(SOURCES[source].label), n: list.length, m: added }));
  });
  // 돌쇠네 정산서: 입금일 규칙이 파일에 없어 "정산기간 끝 + N일"로 둔다 (경미 주임께 확인 후 바꾸면 됨)
  let dolsoeDays = 5;
  const upDolsoe = () => pickFile(".xlsx,.xls", async (rows) => {
    const list = parseDolsoe(rows, dolsoeDays);
    const added = await api.stAddRecv(list);
    toast(t("돌쇠 정산 {amt} ({date} 입금 예정) — {n}건 반영했어요", { amt: won(list[0].amount), date: list[0].expected_date, n: added }), 6000);
  });
  const upGrip = () => pickFile(".xlsx,.xls", async (rows) => {
    const list = parseGrip(rows);
    const added = await api.stAddRecv(list);
    toast(t("착밀 정산 {n}일치 중 새로 {m}건 반영했어요 (추정 금액)", { n: list.length, m: added }), 6000);
  });
  const upInvoice = () => pickFile(".xlsx,.xls,.csv", async (rows) => {
    const list = parseInvoice(rows, termDays);
    const added = await api.stAddRecv(list);
    toast(t("세금계산서 {n}건 중 새로 {m}건 반영했어요", { n: list.length, m: added }));
  });

  async function addManual() {
    const cp = h("input", { class: "inp", placeholder: t("거래처 (예: 돌쇠)") });
    const dt = h("input", { class: "inp", type: "date", value: today });
    const am = h("input", { class: "inp", inputmode: "numeric", placeholder: t("받을 금액(원)") });
    const ov = h("div", { class: "overlay" }, h("div", { class: "dialog" }, h("h2", null, t("받을 돈 직접 추가")), cp, dt, am,
      h("button", { class: "btn primary", onclick: async () => {
        const amount = Number(am.value.replace(/[^\d]/g, "")); const d = toDate(dt.value);
        if (!cp.value.trim() || !d || !(amount > 0)) return toast(t("거래처·날짜·금액을 확인해 주세요"));
        ov.remove();
        try { await api.stAddRecv([{ source: "manual", counterparty: cp.value.trim(), expected_date: d, amount, ref: `manual:${Date.now()}`, estimated: false }]); toast(t("추가했어요")); } catch (e) { toast(e.message, 5000); }
        load();
      } }, t("추가")),
      h("button", { class: "btn ghost", onclick: () => ov.remove() }, t("취소"))));
    document.body.append(ov);
  }

  async function act(r, kind) {
    try {
      if (kind === "dun") { await copyText(dunText(r)); await api.stPatch(r.id, { dunned_at: new Date().toISOString() }); toast(t("독촉 문구를 복사했어요. 카톡·문자에 붙여넣으세요")); }
      else if (kind === "close") { if (!(await confirmDialog(t("입금 확인으로 종결할까요?"), [`${partyName(r.counterparty)} ${won(r.amount)}`, t("통장에 안 잡혀도 받았다면 종결")], t("취소"), t("종결")))) return; await api.stPatch(r.id, { closed: true }); }
      else if (kind === "reopen") await api.stPatch(r.id, { closed: false });
      else if (kind === "del") { if (!(await confirmDialog(t("이 건을 지울까요?"), [`${partyName(r.counterparty)} ${won(r.amount)}`], t("취소"), t("지우기")))) return; await api.stDelete(r.id); }
    } catch (e) { toast(e.message, 5000); }
    load();
  }

  function rowView(r) {
    const [label, cls] = statusOf(r.status);
    const sub = r.status === "overdue" ? t("예정일 {date} · {n}일 지남", { date: r.expected_date, n: r.overdueDays })
      : r.status === "diff" ? t("예정 {plan} → 입금 {paid} ({diff})", { plan: won(r.amount), paid: won(r.paid), diff: (r.diff > 0 ? "+" : "") + won(r.diff) })
      : r.status === "waiting" ? t("예정일 {date}", { date: r.expected_date }) + (r.estimated ? " " + t("(추정)") : "")
      : r.status === "paid_late" ? t("{n}일 늦게 입금", { n: r.lateDays }) : t("예정일 {date}", { date: r.expected_date });
    return h("div", { class: "card", style: "margin:8px 0;padding:12px" },
      h("div", { style: "display:flex;justify-content:space-between;gap:8px" },
        h("b", null, `${partyName(r.counterparty || SOURCES[r.source].label)}`), h("b", { class: "num" }, won(r.amount))),
      h("div", { class: cls, style: "font-size:.85rem;margin:2px 0" }, `${label} · ${sub}`),
      r.dunned_at && h("div", { class: "muted" }, t("마지막 독촉 {date}", { date: r.dunned_at.slice(0, 10) })),
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:6px" },
        (r.status === "overdue" || r.status === "diff") && h("button", { class: "btn ghost slim", onclick: () => act(r, "dun") }, "📋 " + t("독촉 문구 복사")),
        r.status !== "closed" && r.status !== "paid" && r.status !== "paid_late" && h("button", { class: "btn ghost slim", onclick: () => act(r, "close") }, t("받았음(종결)")),
        r.status === "closed" && h("button", { class: "btn ghost slim", onclick: () => act(r, "reopen") }, t("다시 열기")),
        h("button", { class: "linkbtn", onclick: () => act(r, "del") }, t("삭제"))));
  }

  function draw() {
    const { rows, unmatchedDeposits } = compute();
    const s = summarize(rows);
    const group = (k) => (k === "done" ? rows.filter((r) => ["paid", "paid_late", "closed"].includes(r.status)) : rows.filter((r) => r.status === k));
    const list = group(tab).sort((a, b) => (tab === "done" ? b.expected_date.localeCompare(a.expected_date) : a.expected_date.localeCompare(b.expected_date)));
    const lastDep = deps.map((d) => d.date).sort().at(-1);
    const stale = !lastDep || lastDep < addDays(today, -1);
    const card = (label, v, sub, cls) => h("div", { class: "acc", style: "flex:1;min-width:120px" },
      h("div", { class: "muted" }, label), h("b", { class: cls }, v), h("div", { class: "muted" }, sub));
    const term = h("input", { class: "inp", type: "number", min: "0", value: String(termDays), style: "width:70px;display:inline-block", onchange: (e) => { termDays = Number(e.target.value) || 0; } });
    const unitDay = tx("단위", "일"); // 일(日) 수를 세는 단위

    root.replaceChildren(h("div", { class: "page" },
      onBack && h("button", { class: "linkbtn back", onclick: onBack }, t("← 목록")),
      h("h1", null, "💰 " + t("통장·수금")),
      loadErr && h("p", { class: "err" }, t("불러오기 실패: {err} (settle.sql을 실행했는지 확인)", { err: t(loadErr) })),
      stale && h("div", { class: "banner" }, lastDep ? t("통장 내역이 {date}까지예요. 오늘 내역을 올려야 정확해요", { date: lastDep }) : t("통장 거래내역 엑셀을 먼저 올려 주세요")),
      // 받을 돈(네이버·톡딜·돌쇠·착밀·매출 계산서)이 하나도 없으면 미입금 현황은 빈 숫자라서 숨긴다
      recv.length > 0 && h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
        card(t("미입금"), t("{n}건", { n: s.overdue }), won(s.overdueAmt), s.overdue ? "err" : "ok-text"),
        card(t("금액 다름"), t("{n}건", { n: s.diff }), won(s.diffAmt), s.diff ? "err" : "ok-text"),
        card(t("입금 대기"), t("{n}건", { n: s.waiting }), won(s.waitingAmt), "muted")),
      h("h2", { class: "sec-title" }, t("자료 올리기")),
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" },
        h("button", { class: "btn primary slim", disabled: busy, onclick: upBank }, "🏦 " + t("통장 거래내역")),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: () => upSettle("naver") }, t("네이버 정산내역")),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: () => upSettle("talkdeal") }, t("톡딜 정산내역")),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: upDolsoe }, t("돌쇠네 정산서")),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: upGrip }, t("착밀(Grip) 정산")),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: upInvs }, "🧾 " + t("매입 계산서 (홈택스)")),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: upInvoice }, t("매출 세금계산서")),
        h("button", { class: "btn ghost slim", onclick: addManual }, t("＋ 직접 추가"))),
      h("p", { class: "muted" }, t("세금계산서 입금기한: 작성일 +") + " ", term, unitDay + " · " + t("돌쇠 입금: 정산기간 끝 +") + " ",
        h("input", { class: "inp", type: "number", min: "0", value: String(dolsoeDays), style: "width:60px;display:inline-block", onchange: (e) => { dolsoeDays = Number(e.target.value) || 0; } }), unitDay + "  " + t("(같은 파일을 다시 올려도 중복되지 않아요)")),
      h("p", { class: "muted" }, t("네이버·톡딜은 '일별 정산({a}·{b})' 파일이 정확해요. 건별 파일은 예정(추정)으로만 들어가고, 일별 파일을 올리면 확정 금액으로 바뀌어요.", { a: "정산확정금액", b: "대금지급현황" })),
      busy && h("p", { class: "muted" }, t("읽는 중…")),
      recv.length === 0
        ? h("p", { class: "muted", style: "margin-top:16px" }, t("받을 돈 자료(네이버·톡딜 정산, 돌쇠, 착밀, 매출 계산서)를 올리면 미입금·금액 차이를 여기서 찾아 드려요. 지금은 통장 내역과 매입 계산서만 올려도 매출·지출 보고에 쓰여요."))
        : [
          h("h2", { class: "sec-title" }, t("확인하기")),
          h("div", { class: "tabs" }, tabList().map(([k, l]) => h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; draw(); } }, `${l} ${group(k).length}`))),
          list.length ? list.map(rowView) : h("p", { class: "muted" }, tab === "overdue" ? t("미입금 건이 없어요 🎉") : t("해당 건이 없어요")),
          tab === "done" && unmatchedDeposits.length > 0 && h("details", { style: "margin-top:12px" },
            h("summary", null, t("어느 건에도 안 맞는 입금 {n}건 (참고)", { n: unmatchedDeposits.length })),
            unmatchedDeposits.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60).map((d) => h("div", { class: "muted" }, `${d.date}  ${won(d.amount)}  ${d.memo}`))),
        ]));
  }

  draw();
  await load();
}
