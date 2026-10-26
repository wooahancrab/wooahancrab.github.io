// 송장 처리 화면(경미 주임·전무·대표): 채널 발주서 → 로젠 파일 → 송장번호 받아서 채널용 송장 파일.
// 주문자 이름·연락처·주소가 들어 있는 파일이라 서버에 저장하지 않고, 이 화면을 닫으면 사라진다(브라우저 메모리에서만 처리).
import { h, toast } from "../lib/ui.js";
import { CHANNELS, parseOrders, logenRows, parseLogenReturn, matchTracking, fillTracking, summarize } from "../lib/ship.js";
import { todayKST } from "../lib/kst.js";

const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
let xlsxP;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return (xlsxP ??= new Promise((ok, no) => {
    const s = h("script", { src: XLSX_URL });
    s.onload = () => ok(window.XLSX); s.onerror = () => { xlsxP = null; no(new Error("엑셀 도구를 불러오지 못했어요. 인터넷을 확인해 주세요")); };
    document.head.append(s);
  }));
}
async function readBook(file) {
  const X = await loadXlsx();
  const wb = X.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  return wb.SheetNames.map((n) => X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }));
}
async function saveXlsx(rows, sheetName, fileName) {
  const X = await loadXlsx();
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), sheetName);
  X.writeFile(wb, fileName);
}

export async function renderShip(root) {
  const stamp = todayKST().slice(5).replace("-", "");
  let ch = "smart", parsed = null, matched = null, busy = false, msg = "";

  function pick(accept, handler) {
    const inp = h("input", { type: "file", accept, style: "display:none" });
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      busy = true; msg = ""; draw();
      try { await handler(await readBook(f), f); } catch (e) { toast(e.message, 7000); msg = e.message; }
      busy = false; draw();
    };
    document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
  }

  const step1 = () => pick(".xlsx,.xls", async (sheets) => { parsed = parseOrders(ch, sheets); matched = null; });
  const step2 = () => pick(".xlsx,.xls", async (sheets) => {
    if (!parsed) throw new Error("먼저 1단계에서 발주서를 올려 주세요");
    matched = matchTracking(parsed.orders, parseLogenReturn(sheets));
    toast(`송장번호 ${matched.done.length}건 맞췄어요` + (matched.missing.length ? ` · 못 맞춘 ${matched.missing.length}건` : ""), 5000);
  });

  function draw() {
    const c = CHANNELS[ch];
    const sum = parsed ? summarize(parsed.orders) : [];
    root.replaceChildren(h("div", { class: "page" },
      h("h1", null, "📦 송장 처리"),
      h("p", { class: "muted", style: "font-size:12px" }, "주문자 정보가 든 파일은 서버에 저장하지 않아요. 이 화면을 닫으면 사라져요."),
      h("div", { class: "tabs" }, Object.entries(CHANNELS).map(([k, v]) => h("button", { class: "tab" + (ch === k ? " on" : ""), onclick: () => { ch = k; parsed = null; matched = null; msg = ""; draw(); } }, v.label))),

      h("section", { class: "card" }, h("h2", null, "① 발주서 → 로젠 파일"),
        h("p", { class: "muted", style: "font-size:13px" }, `${c.label}에서 받은 발주서(주문) 엑셀을 올리면, 로젠에 가져올 파일을 만들어 드려요.`),
        h("button", { class: "btn primary", disabled: busy, onclick: step1 }, parsed ? "다른 발주서 올리기" : "📂 발주서 올리기"),
        busy && h("p", { class: "muted" }, "읽는 중…"),
        msg && h("p", { class: "err" }, msg),
        parsed && [
          h("p", null, h("b", null, `주문 ${parsed.orders.length}건`), `  (상품 ${sum.reduce((s, x) => s + x.qty, 0)}개)`),
          h("details", null, h("summary", null, "상품별 수량 보기"), sum.map((x) => h("div", { class: "srow" }, h("span", { class: "muted" }, x.name), h("b", null, x.qty)))),
          h("button", { class: "btn ghost", onclick: () => saveXlsx(logenRows(parsed.orders), "Sheet1", `로젠_${c.label}_${stamp}.xlsx`) }, "⬇ 로젠 파일 받기"),
        ]),

      parsed && h("section", { class: "card" }, h("h2", null, "② 로젠 송장번호 → 채널 파일"),
        h("p", { class: "muted", style: "font-size:13px" }, "로젠에서 송장을 출력한 뒤, 송장번호(H열)가 채워진 엑셀을 올려 주세요."),
        h("button", { class: "btn primary", disabled: busy, onclick: step2 }, matched ? "다시 올리기" : "📂 로젠 출력본 올리기"),
        matched && [
          h("p", null, h("b", { class: "ok-text" }, `송장번호 ${matched.done.length}건 맞춤`),
            matched.missing.length > 0 && h("span", { class: "err" }, `  · 못 맞춘 ${matched.missing.length}건`)),
          matched.missing.length > 0 && h("details", { open: true }, h("summary", { class: "err" }, "송장번호를 못 찾은 주문"),
            matched.missing.slice(0, 30).map((o) => h("div", { class: "srow" }, h("span", null, o.name), h("span", { class: "muted" }, o.phone)))),
          matched.extra.length > 0 && h("p", { class: "muted", style: "font-size:12px" }, `발주서에 없는 송장 ${matched.extra.length}건은 무시했어요`),
          h("button", { class: "btn ghost", disabled: !matched.done.length, onclick: () => { const f = fillTracking(ch, parsed, matched.done); saveXlsx(f.rows, f.name, `송장_${c.label}_${stamp}.xlsx`); } }, `⬇ ${c.label} 송장 파일 받기`),
          h("p", { class: "muted", style: "font-size:12px" }, c.tip),
        ])));
  }
  draw();
}
