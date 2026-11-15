// 송장 처리 화면(경미 주임·전무·대표): 채널 발주서 → 로젠 파일 → 송장번호 받아서 채널용 송장 파일.
// 주문자 이름·연락처·주소가 들어 있는 파일이라 서버에 저장하지 않고, 이 화면을 닫으면 사라진다(브라우저 메모리에서만 처리).
import { h, toast } from "../lib/ui.js";
import { t } from "../lib/i18n.js";
import { CHANNELS, parseOrders, logenRows, parseLogenReturn, matchTracking, fillTracking, summarize } from "../lib/ship.js";
import { todayKST } from "../lib/kst.js";

const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
let xlsxP;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return (xlsxP ??= new Promise((ok, no) => {
    const s = h("script", { src: XLSX_URL });
    s.onload = () => ok(window.XLSX); s.onerror = () => { xlsxP = null; no(new Error(t("엑셀 도구를 불러오지 못했어요. 인터넷을 확인해 주세요"))); };
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
  // 펼치거나 접어 둔 목록은 다시 그려도 그대로 둔다(새 파일을 읽으면 처음 상태로)
  let folds = {};
  const det = (key, open, ...kids) => {
    const d = h("details", { open: key in folds ? folds[key] : open }, ...kids);
    d.addEventListener("toggle", () => { folds[key] = d.open; });
    return d;
  };

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

  const step1 = () => pick(".xlsx,.xls", async (sheets) => { parsed = parseOrders(ch, sheets); matched = null; folds = {}; });
  const step2 = () => pick(".xlsx,.xls", async (sheets) => {
    if (!parsed) throw new Error(t("먼저 1단계에서 발주서를 올려 주세요"));
    matched = matchTracking(parsed.orders, parseLogenReturn(sheets)); delete folds.missing;
    toast(t("송장번호 {n}건 맞췄어요", { n: matched.done.length }) + (matched.missing.length ? " · " + t("못 맞춘 {n}건", { n: matched.missing.length }) : ""), 5000);
  });

  // 채널 이름(c.label)은 엑셀 파일 이름에도 쓰는 한국어 값이라 그대로 두고, 화면에 보일 때만 t(label)로 바꾼다
  function draw() {
    const c = CHANNELS[ch];
    const sum = parsed ? summarize(parsed.orders) : [];
    root.replaceChildren(h("div", { class: "page" },
      h("h1", null, "📦 " + t("송장 처리")),
      h("p", { class: "hint" }, t("주문자 정보가 든 파일은 서버에 저장하지 않아요. 이 화면을 닫으면 사라져요.")),
      h("div", { class: "tabs" }, Object.entries(CHANNELS).map(([k, v]) => h("button", { class: "tab" + (ch === k ? " on" : ""), onclick: () => { ch = k; parsed = null; matched = null; msg = ""; folds = {}; draw(); } }, t(v.label)))),

      h("section", { class: "sec stack" }, h("h2", { class: "sec-title" }, t("① 발주서 → 로젠 파일")),
        h("p", { class: "hint" }, t("{label}에서 받은 발주서(주문) 엑셀을 올리면, 로젠에 가져올 파일을 만들어 드려요.", { label: t(c.label) })),
        h("button", { class: "btn " + (parsed ? "ghost" : "primary"), disabled: busy, onclick: step1 }, parsed ? t("다른 발주서 올리기") : "📂 " + t("발주서 올리기")),
        busy && h("p", { class: "muted" }, t("읽는 중…")),
        msg && h("p", { class: "err" }, msg),
        parsed && [
          h("p", null, h("b", null, t("주문 {n}건", { n: parsed.orders.length })), "  (" + t("상품 {n}개", { n: sum.reduce((s, x) => s + x.qty, 0) }) + ")"),
          det("sum", false, h("summary", null, t("상품별 수량 보기")), sum.map((x) => h("div", { class: "lrow" }, h("span", { class: "muted" }, t(x.name)), h("b", null, x.qty)))),
          h("button", { class: "btn ghost", onclick: () => saveXlsx(logenRows(parsed.orders), "Sheet1", `로젠_${c.label}_${stamp}.xlsx`) }, "⬇ " + t("로젠 파일 받기")),
        ]),

      parsed && h("section", { class: "sec stack" }, h("h2", { class: "sec-title" }, t("② 로젠 송장번호 → 채널 파일")),
        h("p", { class: "hint" }, t("로젠에서 송장을 출력한 뒤, 송장번호(H열)가 채워진 엑셀을 올려 주세요.")),
        h("button", { class: "btn " + (matched ? "ghost" : "primary"), disabled: busy, onclick: step2 }, matched ? t("다시 올리기") : "📂 " + t("로젠 출력본 올리기")),
        matched && [
          h("p", null, h("b", { class: "ok-text" }, t("송장번호 {n}건 맞춤", { n: matched.done.length })),
            matched.missing.length > 0 && h("span", { class: "err" }, "  · " + t("못 맞춘 {n}건", { n: matched.missing.length }))),
          matched.missing.length > 0 && det("missing", true, h("summary", { class: "err" }, t("송장번호를 못 찾은 주문")),
            matched.missing.slice(0, 30).map((o) => h("div", { class: "lrow" }, h("span", null, o.name), h("span", { class: "muted" }, o.phone)))),
          matched.extra.length > 0 && h("p", { class: "hint" }, t("발주서에 없는 송장 {n}건은 무시했어요", { n: matched.extra.length })),
          h("button", { class: "btn ghost", disabled: !matched.done.length, onclick: () => { const f = fillTracking(ch, parsed, matched.done); saveXlsx(f.rows, f.name, `송장_${c.label}_${stamp}.xlsx`); } }, "⬇ " + t("{label} 송장 파일 받기", { label: t(c.label) })),
          h("p", { class: "hint" }, c.tip),
        ])));
  }
  draw();
}
