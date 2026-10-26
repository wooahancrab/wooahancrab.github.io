// 수금 대조 화면(대표 전용): 받을 돈 vs 통장 입금을 매일 확인하고 빠진 곳을 독촉한다.
import { api } from "../lib/api.js";
import { h, toast, copyText, confirmDialog } from "../lib/ui.js";
import { todayKST, addDays } from "../lib/kst.js";
import { parseBankStatement } from "../lib/bank.js";
import { SOURCES, won, reconcile, summarize, parseBank, parseInvoice, parseSettle, parseDolsoe, parseGrip, dunText, toDate } from "../lib/settle.js";

const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
let xlsxP;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return (xlsxP ??= new Promise((ok, no) => {
    const s = h("script", { src: XLSX_URL });
    s.onload = () => ok(window.XLSX); s.onerror = () => { xlsxP = null; no(new Error("엑셀 읽기 도구를 불러오지 못했어요. 인터넷을 확인해 주세요")); };
    document.head.append(s);
  }));
}
async function readBook(file) { // 모든 시트를 2차원 배열의 배열로
  const X = await loadXlsx();
  const wb = X.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  return wb.SheetNames.map((n) => X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }));
}
async function readSheet(file) { return (await readBook(file))[0]; } // 첫 시트

const STATUS = {
  overdue: ["미입금", "err"], diff: ["금액 다름", "err"], waiting: ["입금 대기", "muted"],
  paid: ["입금 확인", "ok-text"], paid_late: ["늦게 입금", "ok-text"], closed: ["종결", "muted"],
};
const TABS = [["overdue", "🚨 미입금"], ["diff", "⚠ 금액 다름"], ["waiting", "⏳ 대기"], ["done", "✅ 완료"]];

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
    toast(`입금 ${r.deposits.length}건 중 새로 ${nIn}건, 출금 ${r.withdrawals.length}건 중 새로 ${nOut}건 반영했어요`, 6000);
  }, true);
  const upSettle = (source) => pickFile(".xlsx,.xls,.csv", async (rows) => {
    const list = parseSettle(rows, source);
    toast(`${SOURCES[source].label} 정산 ${list.length}일치 중 새로 ${await api.stAddRecv(list)}건 반영했어요`);
  });
  // 돌쇠네 정산서: 입금일 규칙이 파일에 없어 "정산기간 끝 + N일"로 둔다 (경미 주임께 확인 후 바꾸면 됨)
  let dolsoeDays = 5;
  const upDolsoe = () => pickFile(".xlsx,.xls", async (rows) => {
    const list = parseDolsoe(rows, dolsoeDays);
    toast(`돌쇠 정산 ${won(list[0].amount)} (${list[0].expected_date} 입금 예정) — ${await api.stAddRecv(list)}건 반영했어요`, 6000);
  });
  const upGrip = () => pickFile(".xlsx,.xls", async (rows) => {
    const list = parseGrip(rows);
    toast(`착밀 정산 ${list.length}일치 중 새로 ${await api.stAddRecv(list)}건 반영했어요 (추정 금액)`, 6000);
  });
  const upInvoice = () => pickFile(".xlsx,.xls,.csv", async (rows) => {
    const list = parseInvoice(rows, termDays);
    toast(`세금계산서 ${list.length}건 중 새로 ${await api.stAddRecv(list)}건 반영했어요`);
  });

  async function addManual() {
    const cp = h("input", { class: "inp", placeholder: "거래처 (예: 돌쇠)" });
    const dt = h("input", { class: "inp", type: "date", value: today });
    const am = h("input", { class: "inp", inputmode: "numeric", placeholder: "받을 금액(원)" });
    const ov = h("div", { class: "overlay" }, h("div", { class: "dialog" }, h("h2", null, "받을 돈 직접 추가"), cp, dt, am,
      h("button", { class: "btn primary", onclick: async () => {
        const amount = Number(am.value.replace(/[^\d]/g, "")); const d = toDate(dt.value);
        if (!cp.value.trim() || !d || !(amount > 0)) return toast("거래처·날짜·금액을 확인해 주세요");
        ov.remove();
        try { await api.stAddRecv([{ source: "manual", counterparty: cp.value.trim(), expected_date: d, amount, ref: `manual:${Date.now()}`, estimated: false }]); toast("추가했어요"); } catch (e) { toast(e.message, 5000); }
        load();
      } }, "추가"),
      h("button", { class: "btn ghost", onclick: () => ov.remove() }, "취소")));
    document.body.append(ov);
  }

  async function act(r, kind) {
    try {
      if (kind === "dun") { await copyText(dunText(r)); await api.stPatch(r.id, { dunned_at: new Date().toISOString() }); toast("독촉 문구를 복사했어요. 카톡·문자에 붙여넣으세요"); }
      else if (kind === "close") { if (!(await confirmDialog("입금 확인으로 종결할까요?", [`${r.counterparty} ${won(r.amount)}`, "통장에 안 잡혀도 받았다면 종결"], "취소", "종결"))) return; await api.stPatch(r.id, { closed: true }); }
      else if (kind === "reopen") await api.stPatch(r.id, { closed: false });
      else if (kind === "del") { if (!(await confirmDialog("이 건을 지울까요?", [`${r.counterparty} ${won(r.amount)}`], "취소", "지우기"))) return; await api.stDelete(r.id); }
    } catch (e) { toast(e.message, 5000); }
    load();
  }

  function rowView(r) {
    const [label, cls] = STATUS[r.status];
    const sub = r.status === "overdue" ? `예정일 ${r.expected_date} · ${r.overdueDays}일 지남`
      : r.status === "diff" ? `예정 ${won(r.amount)} → 입금 ${won(r.paid)} (${r.diff > 0 ? "+" : ""}${won(r.diff)})`
      : r.status === "waiting" ? `예정일 ${r.expected_date}${r.estimated ? " (추정)" : ""}`
      : r.status === "paid_late" ? `${r.lateDays}일 늦게 입금` : `예정일 ${r.expected_date}`;
    return h("div", { class: "card", style: "margin:8px 0;padding:12px;border:1px solid #ddd;border-radius:12px" },
      h("div", { style: "display:flex;justify-content:space-between;gap:8px" },
        h("b", null, `${r.counterparty || SOURCES[r.source].label}`), h("b", null, won(r.amount))),
      h("div", { class: cls, style: "font-size:13px;margin:2px 0" }, `${label} · ${sub}`),
      r.dunned_at && h("div", { class: "muted", style: "font-size:12px" }, `마지막 독촉 ${r.dunned_at.slice(0, 10)}`),
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:6px" },
        (r.status === "overdue" || r.status === "diff") && h("button", { class: "btn ghost slim", onclick: () => act(r, "dun") }, "📋 독촉 문구 복사"),
        r.status !== "closed" && r.status !== "paid" && r.status !== "paid_late" && h("button", { class: "btn ghost slim", onclick: () => act(r, "close") }, "받았음(종결)"),
        r.status === "closed" && h("button", { class: "btn ghost slim", onclick: () => act(r, "reopen") }, "다시 열기"),
        h("button", { class: "linkbtn", onclick: () => act(r, "del") }, "삭제")));
  }

  function draw() {
    const { rows, unmatchedDeposits } = compute();
    const s = summarize(rows);
    const group = (k) => (k === "done" ? rows.filter((r) => ["paid", "paid_late", "closed"].includes(r.status)) : rows.filter((r) => r.status === k));
    const list = group(tab).sort((a, b) => (tab === "done" ? b.expected_date.localeCompare(a.expected_date) : a.expected_date.localeCompare(b.expected_date)));
    const lastDep = deps.map((d) => d.date).sort().at(-1);
    const stale = !lastDep || lastDep < addDays(today, -1);
    const card = (t, v, sub, cls) => h("div", { style: "flex:1;min-width:120px;padding:10px;border:1px solid #ddd;border-radius:12px" },
      h("div", { class: "muted", style: "font-size:12px" }, t), h("b", { class: cls }, v), h("div", { class: "muted", style: "font-size:12px" }, sub));
    const term = h("input", { class: "inp", type: "number", min: "0", value: String(termDays), style: "width:70px;display:inline-block", onchange: (e) => { termDays = Number(e.target.value) || 0; } });

    root.replaceChildren(h("div", { class: "page" },
      onBack && h("button", { class: "linkbtn back", onclick: onBack }, "← 목록"),
      h("h1", null, "💰 수금 대조"),
      loadErr && h("p", { class: "err" }, "불러오기 실패: " + loadErr + " (settle.sql을 실행했는지 확인)"),
      stale && h("div", { class: "banner" }, lastDep ? `통장 내역이 ${lastDep}까지예요. 오늘 내역을 올려야 정확해요` : "통장 거래내역 엑셀을 먼저 올려 주세요"),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
        card("미입금", `${s.overdue}건`, won(s.overdueAmt), s.overdue ? "err" : "ok-text"),
        card("금액 다름", `${s.diff}건`, won(s.diffAmt), s.diff ? "err" : "ok-text"),
        card("입금 대기", `${s.waiting}건`, won(s.waitingAmt), "muted")),
      h("h2", { style: "margin-top:16px" }, "① 자료 올리기"),
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" },
        h("button", { class: "btn primary slim", disabled: busy, onclick: upBank }, "🏦 통장 거래내역"),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: () => upSettle("naver") }, "네이버 정산내역"),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: () => upSettle("talkdeal") }, "톡딜 정산내역"),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: upDolsoe }, "돌쇠네 정산서"),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: upGrip }, "착밀(Grip) 정산"),
        h("button", { class: "btn ghost slim", disabled: busy, onclick: upInvoice }, "홈택스 세금계산서"),
        h("button", { class: "btn ghost slim", onclick: addManual }, "＋ 직접 추가")),
      h("p", { class: "muted", style: "font-size:12px" }, "세금계산서 입금기한: 작성일 + ", term, "일 · 돌쇠 입금: 정산기간 끝 + ",
        h("input", { class: "inp", type: "number", min: "0", value: String(dolsoeDays), style: "width:60px;display:inline-block", onchange: (e) => { dolsoeDays = Number(e.target.value) || 0; } }), "일  (같은 파일을 다시 올려도 중복되지 않아요)"),
      h("p", { class: "muted", style: "font-size:12px" }, "네이버·톡딜은 '일별 정산(정산확정금액·대금지급현황)' 파일이 정확해요. 건별 파일은 예정(추정)으로만 들어가고, 일별 파일을 올리면 확정 금액으로 바뀌어요."),
      busy && h("p", { class: "muted" }, "읽는 중…"),
      h("h2", { style: "margin-top:16px" }, "② 확인하기"),
      h("div", { class: "tabs" }, TABS.map(([k, l]) => h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; draw(); } }, `${l} ${group(k).length}`))),
      list.length ? list.map(rowView) : h("p", { class: "muted" }, tab === "overdue" ? "미입금 건이 없어요 🎉" : "해당 건이 없어요"),
      tab === "done" && unmatchedDeposits.length > 0 && h("details", { style: "margin-top:12px" },
        h("summary", null, `어느 건에도 안 맞는 입금 ${unmatchedDeposits.length}건 (참고)`),
        unmatchedDeposits.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60).map((d) => h("div", { class: "muted", style: "font-size:13px" }, `${d.date}  ${won(d.amount)}  ${d.memo}`)))));
  }

  draw();
  await load();
}
