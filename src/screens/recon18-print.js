// 매출-입금 대조 '대조 내역서' A4 인쇄 미리보기 (대표·부대표·회장 전용).
// 사용: openPrintSheet({ res, settings, isDemo, user: { name, role }, now: new Date(), notes, linked, pre })
//   화면 위에 인쇄 미리보기 레이어(.rc-sheet-wrap)를 연다. [인쇄 / PDF로 저장] = window.print(), [닫기] = 레이어 제거(주입한 <style>도 함께 제거).
//   권한 없는 역할(canViewFinance 가 아닌)은 Error 를 던진다 — 화면의 버튼 숨김에만 기대지 않는다.
//   linked = 사람이 눌러 연결한 입금 [{ date, payer, net, fee, gross, saleDate, method, statusText, memo }] — 있으면 '직접 연결한 입금' 표를 넣는다(없으면 그 구역을 그리지 않음).
//   pre    = 분석 시작 전 자료 건수 { sales, deposits } — 넘기면 '미수금 계산에만 썼어요' 안내 한 줄을 넣는다(모르면 생략).
// 계산은 lib/recon18.js(analyze, buildDetail, fmtMan …)가 하고, 이 파일은 그 결과를 종이 모양으로 그리기만 한다. 금액은 만원 단위(fmtMan).
import { h, toast } from "../lib/ui.js";
import { labelMD, addDays } from "../lib/kst.js";
import { METHOD_LABEL, DEFAULT_TOL, STATUS_KEYS, canViewFinance, buildDetail, statusLabel, fmtMan, fmtPct, nextMonth } from "../lib/recon18.js";

const ROLE_KO = { owner: "대표", deputy: "부대표", chairman: "회장" };
const STATE_KO = { missing: "누락 의심", over: "초과 입금" };
const SHEET_TITLE = "매출-입금 대조 내역서";

/* ---------------- 스타일 (열 때마다 주입하고, 닫을 때 제거) ---------------- */
// 화면: 폰 폭에서도 가로 스크롤 없이(표는 좁은 화면에서 줄마다 칸으로 쌓음). 인쇄: A4, 이 레이어만 출력. 글씨는 화면 .8rem 이상, 인쇄 9pt 이상.
// 규칙은 전부 .rc-sheet-wrap(미리보기 레이어) 아래로만 걸어서 메인 화면의 같은 이름 클래스(.rc-stat·.rc-sec 등)를 건드리지 않는다.
// 인쇄에서 레이어 밖을 숨기는 규칙만 html.rc-sheet-open(레이어가 열린 동안만 붙는 클래스) 아래에 둔다.
// 색은 앱 토큰(var(--ink) 등)만 쓴다. 변수를 받지 못하는 곳이 생기면 그 줄에 사유를 적는다(아래 @page 바닥글).
const W = ".rc-sheet-wrap", P = ".rc-sheet-wrap .rc-paper";
function makeCss(isDemo) {
  // 쪽 번호 바닥글. 가상(예시) 데이터면 쪽마다 '가상 데이터(실제 아님)'가 들어간다
  const footer = isDemo ? `${SHEET_TITLE} · 가상 데이터(실제 아님) · ` : `${SHEET_TITLE} · `;
  return `
${W}{--rc-fs:.9rem;--rc-fs-t:.85rem;--rc-fs-sm:.8rem;--rc-fs-h1:1.4rem;--rc-fs-h2:1.15rem;--rc-fs-h3:1rem;--rc-fs-big:1.2rem;--rc-fs-val:1.25rem;
position:fixed;inset:0;z-index:25;overflow:auto;overscroll-behavior:contain;background:var(--tint);color:var(--ink);
font-family:-apple-system,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;font-size:var(--rc-fs);line-height:1.45;letter-spacing:-.01em;word-break:keep-all;overflow-wrap:anywhere;
-webkit-print-color-adjust:exact;print-color-adjust:exact}
${W},${W} *{box-sizing:border-box}
${W}:focus{outline:none}
${W} .rc-sheet-bar{position:sticky;top:0;z-index:2;display:flex;gap:8px;padding:calc(8px + env(safe-area-inset-top,0px)) 12px 8px;background:var(--card);border-bottom:2px solid var(--line-strong)}
${W} .rc-sheet-bar button{flex:1;min-height:44px;padding:8px 14px;border:1px solid var(--ink);border-radius:var(--r-md);background:var(--card);color:var(--ink);font:inherit;font-size:var(--rc-fs);font-weight:700;line-height:1.3;white-space:nowrap;cursor:pointer}
${W} .rc-sheet-bar .rc-b-main{flex:2.2;background:var(--red);border-color:var(--red);color:var(--white)}
${W} .rc-sheet-bar button:focus-visible{outline:3px solid var(--red);outline-offset:2px}
${W} .rc-sheet-note{max-width:210mm;margin:8px auto 0;padding:0 12px;font-size:var(--rc-fs-sm);color:var(--muted)}
${P}{max-width:210mm;margin:8px auto 32px;padding:20px 16px;background:var(--white);border:1px solid var(--line);border-radius:var(--r-sm)}
@media (min-width:700px){${P}{margin-top:12px;padding:12mm}}
${P} p{margin:0}
${P} h1{margin:0 0 8px;font-size:var(--rc-fs-h1);line-height:1.3;letter-spacing:-.015em}
${P} h2{margin:0 0 8px;font-size:var(--rc-fs-h2);line-height:1.4;letter-spacing:-.015em}
${P} h3,${P} h4{margin:0;font-size:var(--rc-fs-h3);line-height:1.4}
${P} b{font-weight:700}
${P} .rc-hint{font-size:var(--rc-fs-sm);color:var(--muted);line-height:1.4}
${P} .rc-demo{margin:0 0 12px;padding:8px 12px;border:3px solid var(--bad);border-radius:var(--r-sm);background:var(--bad-bg);text-align:center;font-size:var(--rc-fs-big);font-weight:700;line-height:1.3}
${P} .rc-demo small{display:block;margin-top:2px;font-size:var(--rc-fs-sm);font-weight:400}
${P} .rc-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px;margin:0 0 12px}
${P} .rc-meta>div{min-width:0}
${P} .rc-meta .rc-w{grid-column:1/-1}
${P} .rc-meta dt{font-size:var(--rc-fs-sm);color:var(--muted)}
${P} .rc-meta dd{margin:0;font-weight:700}
${P} .rc-meta dd small{display:block;font-weight:400;font-size:var(--rc-fs-sm);color:var(--muted)}
${P} .rc-meta .rc-nb{display:inline-block;margin-right:18px;white-space:nowrap}
${P} .rc-sec{margin:14px 0 0;padding-top:8px;border-top:2px solid var(--line-strong)}
${P} .rc-sec>h2{break-after:avoid;page-break-after:avoid}
${P} .rc-cat{margin:18px 0 8px;padding-bottom:3px;border-bottom:1px solid var(--line);font-size:var(--rc-fs);font-weight:700;break-after:avoid;page-break-after:avoid}
${P} .rc-keep{break-inside:avoid;page-break-inside:avoid}
${P} .rc-sum{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0 0 8px}
${P} .rc-stat{display:flex;flex-direction:column;gap:2px;min-width:0;padding:8px 10px;background:var(--white);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:none}
${P} .rc-stat .k,${P} .rc-stat .s{font-size:var(--rc-fs-sm);color:var(--muted);line-height:1.35}
${P} .rc-stat .v{font-size:var(--rc-fs-val);font-weight:700;line-height:1.3;font-variant-numeric:tabular-nums;white-space:nowrap}
${P} .rc-stat.warn{border-color:var(--bad);border-left-width:4px}
${P} .rc-stat.warn .v{color:var(--bad)}
${P} .rc-stat .rc-late{display:block;color:var(--ink)}
${P} .rc-note{margin:6px 0 0;padding:6px 10px;border:1px solid var(--line);border-left:4px solid var(--line-ctl);border-radius:var(--r-sm);background:var(--soft);font-size:var(--rc-fs-t);line-height:1.4}
${P} .rc-note.warn{border-color:var(--bad);background:var(--bad-bg)}
${P} .rc-note+p{margin-top:6px}
${P} .rc-t{width:100%;margin:6px 0 0;border-collapse:collapse;font-size:var(--rc-fs-t);line-height:1.35}
${P} .rc-t th{padding:5px 6px;border-top:1px solid var(--line-strong);border-bottom:1px solid var(--line-strong);background:var(--soft);font-weight:700;text-align:left;vertical-align:bottom}
${P} .rc-t td{padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}
${P} .rc-t .rc-n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
${P} .rc-t th:first-child,${P} .rc-t td.rc-first{white-space:nowrap}
${P} .rc-t td.rc-pre{white-space:pre-wrap}
${P} .rc-t .rc-s{display:block;font-size:var(--rc-fs-sm);font-weight:400;color:var(--muted);white-space:normal}
${P} .rc-t thead{display:table-header-group}
${P} .rc-t tr{break-inside:avoid;page-break-inside:avoid}
${P} .rc-t tr.rc-total td{border-top:1px solid var(--line-strong);background:var(--soft);font-weight:700}
${P} .rc-case{margin:0 0 12px;padding:8px 12px;border:1px solid var(--line);border-left:4px solid var(--bad);border-radius:var(--r-md);break-inside:avoid;page-break-inside:avoid}
${P} .rc-case-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 8px;margin:0 0 6px}
${P} .rc-badges{display:flex;flex-wrap:wrap;gap:4px}
${P} .rc-badge{display:inline-block;padding:1px 8px;border:1px solid var(--bad);border-radius:var(--r-pill);background:var(--bad-bg);color:var(--bad);font-size:var(--rc-fs-sm);font-weight:700;line-height:1.4;white-space:nowrap}
${P} .rc-badge.plain{border-color:var(--line-ctl);background:var(--soft);color:var(--ink)}
${P} .rc-row{display:grid;grid-template-columns:34mm minmax(0,1fr);gap:2px 12px;padding:6px 0;border-top:1px solid var(--line)}
${P} .rc-row>.rc-k{font-weight:700}
${P} .rc-row>div{min-width:0}
${P} .rc-row .rc-t{margin-top:0}
${P} .rc-opts{display:flex;flex-wrap:wrap;gap:2px 18px;margin:0 0 6px}
${P} .rc-opt::before{content:"";display:inline-block;width:.85em;height:.85em;margin-right:6px;border:1.5px solid var(--ink);border-radius:2px;vertical-align:-.1em}
${P} .rc-opt.on{font-weight:700}
${P} .rc-opt.on::before{background:var(--ink);box-shadow:inset 0 0 0 2px var(--white)}
${P} .rc-memo{min-height:9mm;padding:4px 8px;border:1px solid var(--line-ctl);border-radius:var(--r-sm);white-space:pre-wrap}
@media screen{${P} .rc-memo:empty::before{content:"(적어 둔 메모 없음)";color:var(--muted)}}
@media screen and (max-width:620px){
${P}{margin:8px 8px 24px;padding:14px 12px}
${P} .rc-sum{grid-template-columns:repeat(2,minmax(0,1fr))}
${P} .rc-meta{grid-template-columns:minmax(0,1fr)}
${P} .rc-row{grid-template-columns:minmax(0,1fr)}
${P} .rc-case{padding:8px 10px}
${P} .rc-t thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
${P} .rc-t,${P} .rc-t tbody{display:block}
${P} .rc-t tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 12px;padding:8px 0;border-bottom:1px solid var(--line)}
${P} .rc-t td{display:block;min-width:0;padding:0;border:0}
${P} .rc-t td::before{content:attr(data-l);display:block;font-size:var(--rc-fs-sm);font-weight:400;color:var(--muted)}
${P} .rc-t td.rc-first{grid-column:1/-1;font-weight:700;white-space:normal}
${P} .rc-t td.rc-first::before{display:none}
${P} .rc-t td.rc-wide{grid-column:1/-1}
${P} .rc-t td.rc-n{text-align:left}
${P} .rc-t td:empty{display:none}
${P} .rc-t tr.rc-total{padding:8px 6px;background:var(--soft)}
${P} .rc-t tr.rc-total td{border:0;background:none}
}
@page rc{size:A4;margin:12mm}
/* @page 바닥글(마진 박스)은 .rc-sheet-wrap 안이 아니라 쪽 문맥(:root 상속)에서 그려진다. 그래서 .rc-sheet-wrap 에 정의한 변수는 못 받지만, :root 의 앱 토큰(--muted)은 받는다(PDF 로 확인) */
@page rc{@bottom-center{content:"${footer}" counter(page) " / " counter(pages);font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif;font-size:9pt;color:var(--muted)}}
@media print{
html.rc-sheet-open,html.rc-sheet-open body{page:rc;margin:0!important;padding:0!important;height:auto!important;overflow:visible!important;background:var(--white)!important}
html.rc-sheet-open body>*:not(.rc-sheet-wrap){display:none!important}
${W}{--rc-fs:10pt;--rc-fs-t:9.5pt;--rc-fs-sm:9pt;--rc-fs-h1:18pt;--rc-fs-h2:12.5pt;--rc-fs-h3:10.5pt;--rc-fs-big:15pt;--rc-fs-val:14pt;
page:rc;position:static;inset:auto;z-index:auto;overflow:visible;background:var(--white);line-height:1.4;letter-spacing:0}
${W} .rc-sheet-bar,${W} .rc-sheet-note{display:none!important}
${P}{max-width:none;margin:0;padding:0;border:0;border-radius:0}
${P} .rc-meta{margin-bottom:8px}
}
`;
}

// 열 때마다 새로 주입한다(가상 데이터 여부에 따라 바닥글이 달라서). 닫을 때는 반환한 요소를 지운다 — 닫은 뒤 메인 화면에는 이 스타일이 남지 않는다
function injectStyle(isDemo) {
  document.getElementById("rc-print-css")?.remove(); // 혹시 남은 것(이전에 비정상으로 끝난 경우)
  const el = h("style", { id: "rc-print-css" }, makeCss(isDemo));
  document.head.append(el);
  return el;
}

/* ---------------- 작은 도우미 ---------------- */
const ymKo = (m) => `${m.slice(0, 4)}년 ${Number(m.slice(5))}월`;
const kstText = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "); // 한국 시간 'YYYY-MM-DD HH:MM'
const md = (s) => labelMD(s);
const mdShort = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`; // 요일 없이 '11/1'
const isoOk = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
// 차이: 부호로도 구분한다(−는 부족, +는 초과). 색에만 기대지 않는다
const diffText = (d) => (d.diff > 0 ? fmtMan(-d.diff) : "+" + fmtMan(-d.diff));
const diffWord = (d) => (d.diff > 0 ? "부족" : "초과");

// 표. cols: [{ l: 머리글, n: 숫자(오른쪽 정렬), w: 좁은 화면에서 한 줄 전체, pre: 줄바꿈 그대로 }], rows: [{ cells: […], cls }]. 첫 열은 좁은 화면에서 줄 제목이 된다.
function table(cols, rows) {
  return h("table", { class: "rc-t" },
    h("thead", null, h("tr", null, cols.map((c) => h("th", { scope: "col", class: c.n ? "rc-n" : null }, c.l)))),
    h("tbody", null, rows.map((r) => h("tr", { class: r.cls || null },
      r.cells.map((v, i) => h("td", { "data-l": cols[i].l, class: [cols[i].n && "rc-n", cols[i].w && "rc-wide", cols[i].pre && "rc-pre", i === 0 && "rc-first"].filter(Boolean).join(" ") || null }, v))))));
}
const line = (k, ...kids) => h("div", { class: "rc-row" }, h("b", { class: "rc-k" }, k), h("div", null, ...kids));

/* ---------------- 내용 ---------------- */
function causeNote(d) {
  const c = d.cause;
  if (!c) return null;
  if (c.code === "none") return "이 매출에 배정된 입금이 하나도 없어요.";
  if (c.code === "fee_high") return `받은 입금액으로 거꾸로 따진 수수료율 ${fmtPct(c.impliedFee)}가 계약 ${fmtPct(c.contract)}보다 높아요.`;
  if (c.code === "partial" && c.noFeeInfo) return "수수료 정보가 없는 입금이 섞여 있어서, 수수료만큼도 차이로 보일 수 있어요.";
  if (c.code === "over") return "매출보다 더 많이 들어왔어요. 다른 날 매출의 입금이 섞였을 수 있어요.";
  return null;
}
// 후보 입금이 왜 후보인지 — 화면(누락 상세의 후보 배지)과 같은 문구
function candReason(c) {
  const out = [];
  if (c.amountHit) out.push("금액 ±5% 이내");
  if (c.dateHit) out.push(c.dueGap === 0 ? "기한 당일" : `기한 ${c.dueGap}일 차이`);
  if (!c.sameMethod) out.push(`${METHOD_LABEL[c.method] ?? c.method} 입금`);
  return out.join(" · ");
}
const feeCell = (p) => p.feeSource === "contract" ? [fmtMan(p.fee), h("span", { class: "rc-s" }, "계약율로 역산")] : p.feeSource === "none" ? "정보 없음" : fmtMan(p.fee);

// 누락 한 건의 상세. 쪽 끝에서 끊기지 않게(break-inside:avoid) 한 덩어리로 만든다
function caseBox(d, i, modeKo, dueRule) {
  const parts = d.parts.length
    ? [table([{ l: "입금일" }, { l: "입금처", w: true }, { l: "입금액", n: true }, { l: "수수료", n: true }, { l: "배정 방식", w: true }],
        d.parts.map((p) => ({ cells: [md(p.date), p.payer || "(입금처 미기재)", fmtMan(p.net), feeCell(p), p.modeText] }))),
      h("p", { class: "rc-hint" }, `배정 합계: 입금 ${fmtMan(d.net)} + 수수료 ${fmtMan(d.fee)} = ${fmtMan(d.paid)} (매출 ${fmtMan(d.amount)})`)]
    : h("p", null, "배정된 입금 없음");
  const note = causeNote(d);
  return h("article", { class: "rc-case" },
    h("div", { class: "rc-case-h" }, h("h4", null, `${i + 1}. ${md(d.date)} · ${METHOD_LABEL[d.method]}`),
      h("span", { class: "rc-badges" }, h("span", { class: "rc-badge" }, STATE_KO[d.state] ?? d.state), d.estimated && h("span", { class: "rc-badge plain" }, "추정 포함"))),
    line("그날 매출",
      h("p", null, "결제수단 ", h("b", null, METHOD_LABEL[d.method]), " · 금액 ", h("b", null, fmtMan(d.amount))),
      h("p", null, "입금 기한 ", h("b", null, md(d.due)), ` (${dueRule(d.days)}, ${modeKo} 기준) · 기준일 현재 ${d.lateDays}일 지남`)),
    line("배정된 입금", parts),
    line("차이 금액과 원인 추정",
      h("p", null, "차이 ", h("b", null, `${diffText(d)} (${diffWord(d)})`), d.cause && [" · 원인 추정: ", h("b", null, d.cause.text)]),
      note && h("p", { class: "rc-hint" }, note)),
    d.candidates.length > 0 && line("후보 입금",
      h("p", null, h("b", null, "이 입금이 그 매출 것일 수 있음"), " (확정 아님 — 짝이 없는 입금 중 금액이 비슷하거나 기한 전후 3일 안에 들어온 것)"),
      table([{ l: "입금일" }, { l: "입금처", w: true }, { l: "입금액", n: true }, { l: "수수료", n: true }, { l: "비슷한 이유", w: true }],
        d.candidates.map((c) => ({ cells: [md(c.date), [c.payer || "(입금처 미기재)", c.used ? h("span", { class: "rc-s" }, "일부는 다른 매출에 배정됨(남은 몫)") : null], fmtMan(c.net), fmtMan(c.fee ?? 0), candReason(c)] })))),
    line("확인 메모 · 처리 상태",
      h("div", { class: "rc-opts" }, STATUS_KEYS.map((k) => h("span", { class: "rc-opt" + (k === d.status ? " on" : ""), "aria-current": k === d.status ? "true" : null }, statusLabel(k, d.method)))),
      h("div", { class: "rc-memo" }, d.memo)));
}

// 사람이 눌러 연결한 입금 목록(ctx.linked). 없으면 null — 구역 자체를 그리지 않는다
function linkedBlock(linked) {
  const list = (Array.isArray(linked) ? linked : []).filter((x) => x && typeof x === "object")
    .map((x, i) => ({ x, i })).sort((a, b) => String(a.x.date).localeCompare(String(b.x.date)) || a.i - b.i).map(({ x }) => x); // 입금일 순(같으면 넘어온 순서)
  if (!list.length) return null;
  const day = (s) => (isoOk(s) ? md(s) : "-");
  const money = (v) => (Number.isFinite(v) ? fmtMan(v) : "-");
  const rows = list.map((x) => ({ cells: [
    day(x.date),
    String(x.payer ?? "").trim() || "(입금처 미기재)",
    money(x.net),
    Number.isFinite(x.fee) ? fmtMan(x.fee) : "정보 없음",
    [`→ ${day(x.saleDate)}`, h("span", { class: "rc-s" }, METHOD_LABEL[x.method] ?? String(x.method ?? ""))],
    String(x.statusText ?? "").trim() || "-",
    String(x.memo ?? "").trim() || "-"] }));
  if (list.length > 1) rows.push({ cls: "rc-total", cells: ["합계", null, fmtMan(sum(list, (x) => (Number.isFinite(x.net) ? x.net : 0))), fmtMan(sum(list, (x) => (Number.isFinite(x.fee) ? x.fee : 0))), null, null, null] });
  return h("div", { class: "rc-linked" + (list.length <= 10 ? " rc-keep" : "") },
    h("h3", { class: "rc-cat" }, `직접 연결한 입금 ${list.length}건`),
    h("p", { class: "rc-hint" }, "사람이 ‘후보 입금’에서 골라 매출에 연결한 입금이에요. 연결한 매출 쪽 배정 방식에는 ‘직접 연결(사람이 선택)’로 나와요."),
    table([{ l: "입금일" }, { l: "입금처", w: true }, { l: "입금액", n: true }, { l: "수수료", n: true }, { l: "→ 연결한 매출" }, { l: "그 건의 처리 상태" }, { l: "메모", w: true, pre: true }], rows));
}

function buildPaper(ctx) {
  const { res, user } = ctx, notes = ctx.notes ?? {}, settings = ctx.settings ?? {};
  const now = ctx.now instanceof Date && !Number.isNaN(ctx.now.getTime()) ? ctx.now : new Date();
  const s = res.summary, per = res.period, partial = s.T < per.monthTo;
  const biz = res.mode === "business";
  const modeKo = biz ? "영업일" : "달력";
  const dayWord = (n) => (biz ? `${n}영업일` : `${n}일`);                              // 정산일수 표기
  const dueRule = (n) => (biz ? `매출일 + ${n}영업일` : `매출일 + 정산 ${n}일`);        // 입금 기한 규칙 표기
  const tol = settings.tol ?? DEFAULT_TOL;
  const details = res.missing.map((r) => buildDetail(r, res, notes));
  const userName = String(user.name ?? "").trim(); // 이름이 비면(공백뿐 포함) 역할만 표시
  const roleKo = ROLE_KO[user.role] ?? user.role;
  const who = userName ? `${userName} (${roleKo})` : roleKo;

  /* 1) 가상 데이터 띠 — 맨 위. 색만이 아니라 테두리·굵은 글씨·문구로 구분 */
  const demo = ctx.isDemo ? h("div", { class: "rc-demo", role: "note" }, "가상 데이터 (실제 자료 아님)", h("small", null, "시험용 예시 숫자예요. 실제 결산·증빙으로 쓰지 마세요.")) : null;

  /* 2) 제목·기준일·기간·출력 정보 */
  const head = h("header", null,
    h("h1", null, SHEET_TITLE),
    h("dl", { class: "rc-meta" },
      h("div", null, h("dt", null, "대조 월"), h("dd", null, ymKo(res.month))),
      h("div", null, h("dt", null, "기준일"), h("dd", null, res.asOf, res.asOf < per.depositsTo && h("small", null, "이 날짜까지 들어온 입금만 반영"))),
      h("div", { class: "rc-w" }, h("dt", null, "분석 기간"), h("dd", null, h("span", { class: "rc-nb" }, `매출 ${per.from} ~ ${per.monthTo}`), h("span", { class: "rc-nb" }, `입금 ${per.from} ~ ${per.depositsTo}`))),
      h("div", null, h("dt", null, "출력 일시"), h("dd", null, kstText(now))),
      h("div", null, h("dt", null, "출력한 사람"), h("dd", null, who))));

  /* 3) 한 장 요약 */
  const stat = (k, v, sub, warn) => h("div", { class: "rc-stat" + (warn ? " warn" : "") }, h("span", { class: "k" }, k), h("b", { class: "v" }, v), h("span", { class: "s" }, sub));
  const unSum = sum(res.unmatchedDeposits, (d) => d.amount);
  const od = s.orphanDelta ?? 0; // 검산식의 '짝 없는 입금 증가분'(짝 없는 입금은 미수금에서 빼지 않고 따로 더해 맞춘다)
  // 4번째 칸: 실제 입금 예정 날짜 범위(다음 달 1일 ~ 월말 매출의 입금 기한). 진행 중인 달이면 '기준일 이후 입금 예정'. 영업일 모드면 '매출일 + N영업일'
  const range = `${mdShort(per.nextFrom)}~${mdShort(per.depositsTo)}`;
  const dayNs = [...new Set(res.methods.map((m) => m.days))].sort((a, b) => a - b);
  const bizRule = biz && dayNs.length ? `매출일 + ${dayNs.length > 1 ? `${dayNs[0]}~${dayNs[dayNs.length - 1]}` : dayNs[0]}영업일` : null;
  const nextSub = [partial ? `${mdShort(addDays(s.T, 1))}~${mdShort(per.depositsTo)}` : res.asOf > per.monthTo ? "월말 기준" : null, bizRule, "수수료 뺀 금액"].filter(Boolean).join(" · ");
  // 계산 결과의 경고(res.warnings)를 종이에도 남긴다. 경고 필드가 없는 옛 결과면 짝 없는 입금 안내만 한다
  const warnNote = (w) => {
    const ms = (w.methods ?? []).map((m) => METHOD_LABEL[m] ?? m).join("·");
    if (w.code === "orphan") return h("p", { class: "rc-note" }, h("b", null, "짝 없는 입금: "), `매출과 짝이 없는 입금 ${w.n}건(${fmtMan(w.amount)})이 있어요. 초과 입금이거나 분석 시작 전 매출의 입금일 수 있어요. 미수금에는 넣지 않았어요.`);
    if (w.code === "orphanBig") return h("p", { class: "rc-note warn" }, h("b", null, "확인 필요: "), `${ms}은(는) 짝 없는 입금이 미수금보다 ${fmtMan(w.amount)} 많아요. 입금이 어느 매출 것인지 확인하거나 이월 미수금을 넣어 주세요.`);
    if (w.code === "pre") return h("p", { class: "rc-note warn" }, h("b", null, "분석 시작 전 매출: "), `입금 기한이 지났는데 못 받은 돈이 ${fmtMan(w.amount)} 있어요. 누락 점검표에는 나오지 않고 미수금에는 들어 있어요.`);
    if (w.code === "autoOpening") return h("p", { class: "rc-note" }, h("b", null, "이월 미수금 자동 반영: "), `${ms}의 이월 미수금 ${fmtMan(w.amount)}을 입금에 적힌 매출일로 자동으로 잡았어요.`);
    return null;
  };
  const warnings = Array.isArray(res.warnings)
    ? res.warnings.map(warnNote)
    : res.unmatchedDeposits.length > 0 && h("p", { class: "rc-note" }, h("b", null, "짝 없는 입금: "), `매출과 짝이 없는 입금 ${res.unmatchedDeposits.length}건(${fmtMan(unSum)})이 있어요. 초과 입금이거나 분석 시작 전 매출의 입금일 수 있어요.`);
  const mrows = res.methods.map((m) => ({ cells: [
    [METHOD_LABEL[m.method], m.contractFee ? h("span", { class: "rc-s" }, `계약 ${fmtPct(m.contractFee)}`) : null],
    fmtMan(m.salesMonth), fmtMan(m.netMonth), fmtMan(m.feeMonth),
    [fmtMan(m.arEnd), m.overdueAtEnd > 0 ? h("span", { class: "rc-s" }, `기한 지난 ${fmtMan(m.overdueAtEnd)}`) : null],
    dayWord(m.days)] }));
  if (res.methods.length > 1) mrows.push({ cls: "rc-total", cells: ["합계", fmtMan(s.sales), fmtMan(s.net), fmtMan(s.fee), fmtMan(s.arEnd), null] });
  // 분석 시작 전 자료는 미수금 계산에만 쓴다는 안내(건수를 넘겨받았을 때만)
  const preS = Number(ctx.pre?.sales), preD = Number(ctx.pre?.deposits);
  const preNote = Number.isFinite(preS) && Number.isFinite(preD) && preS + preD > 0
    ? h("p", { class: "rc-hint" }, `분석 시작(${md(per.from)}) 전 자료(매출 ${preS}건·입금 ${preD}건)는 미수금 계산에만 썼어요. 누락 점검표에는 나오지 않아요.`) : null;
  const summary = h("section", { class: "rc-sec" },
    h("h2", null, `한 장 요약 · ${Number(res.month.slice(5))}월`),
    h("div", { class: "rc-sum" },
      stat("이번 달 매출", fmtMan(s.sales), `${md(per.monthFrom)} ~ ${md(s.T)}`),
      stat("이번 달 입금", fmtMan(s.net), s.fee ? `수수료 ${fmtMan(s.fee)} 별도` : "수수료 정보 없음"),
      stat(partial ? "기준일 미수금" : "월말 미수금", fmtMan(s.arEnd), [`전월 말 ${fmtMan(s.arPrev)}에서`, s.overdueAtEnd > 0 && h("b", { class: "rc-late" }, `기한 지난 미수 ${fmtMan(s.overdueAtEnd)} 포함`)], s.overdueAtEnd > 0),
      stat(partial ? "기준일 이후 입금 예정" : `${range} 입금 예정`, fmtMan(s.nextExpectedNet), nextSub)),
    h("p", { class: s.formulaOk ? "rc-hint" : "rc-note warn" }, h("b", null, "검산: "),
      `입금 ${fmtMan(s.net)} = 전월 말 미수 ${fmtMan(s.arPrev)} + 매출 ${fmtMan(s.sales)} − ${partial ? "기준일" : "월말"} 미수 ${fmtMan(s.arEnd)} − 수수료 ${fmtMan(s.fee)}${od ? ` ${od > 0 ? "+" : "−"} 짝 없는 입금 증가분 ${fmtMan(Math.abs(od))}` : ""} → `,
      h("b", null, s.formulaOk ? "맞음" : "안 맞음(자료 확인 필요)"), " · 만원 단위로 줄여 보여서 숫자끼리 1~2만원 어긋나 보일 수 있어요(계산은 원 단위로 정확)."),
    res.methods.length ? table([{ l: "결제수단" }, { l: "매출", n: true }, { l: "입금", n: true }, { l: "수수료", n: true }, { l: partial ? "기준일 미수" : "월말 미수", n: true }, { l: "정산일수", n: true }], mrows) : h("p", { class: "rc-note" }, "결제수단별로 나눌 자료가 없어요."),
    warnings,
    h("p", { class: "rc-hint" }, `대조 기준: 정산일수 ${res.methods.map((m) => `${METHOD_LABEL[m.method]} ${dayWord(m.days)}`).join(" · ") || "-"} · ${modeKo} 기준 · ${tol.toLocaleString("ko-KR")}원 이하 차이는 같은 금액으로 봄`),
    preNote);

  /* 4) 누락 점검표 + 건별 상세 (+ 직접 연결한 입금) */
  const confirmed = res.rows.filter((r) => r.confirmed);
  const fifoNote = res.rows.some((r) => r.confirmed && r.est && !r.explicit) // 확정 구간에 '오래된 매출부터 채운 추정'만 있는 날이 있으면
    ? h("p", { class: "rc-note" }, h("b", null, "추정 주의: "), "매출일이 없는 입금은 오래된 매출부터 채운 추정이라 누락이 뒤 입금에 가려질 수 있어요. 결제수단별 합계(요약)를 같이 보세요.") : null;
  const lastRow = details.length
    ? [table([{ l: "매출일" }, { l: "결제수단" }, { l: "매출액", n: true }, { l: "입금+수수료", n: true }, { l: "차이", n: true }, { l: "기한 경과", n: true }, { l: "처리 상태" }],
        details.map((d, i) => ({ cells: [`${i + 1}. ${md(d.date)}`, METHOD_LABEL[d.method], fmtMan(d.amount),
          [fmtMan(d.paid), d.estimated ? h("span", { class: "rc-s" }, "추정") : null],
          [h("b", null, diffText(d)), h("span", { class: "rc-s" }, `${diffWord(d)} · ${STATE_KO[d.state] ?? d.state}`)],
          `${d.lateDays}일`, d.statusText] }))),
      res.missing.some((r) => r.est) && h("p", { class: "rc-hint" }, "‘추정’은 매출일 없는 입금을 오래된 매출부터 채워서 계산했다는 뜻이에요. 날짜는 어긋날 수 있고 결제수단별 합계는 정확해요."),
      h("h3", { class: "rc-cat" }, `건별 상세 (${details.length}건)`),
      details.map((d, i) => caseBox(d, i, modeKo, dueRule))]
    : [h("p", null, h("b", null, "누락 의심 없음")),
      h("p", { class: "rc-hint" }, !res.rows.length ? "이 달 분석 범위에 매출 자료가 없어요." : !confirmed.length ? "입금 기한이 지난 매출이 아직 없어요." : "입금 기한이 지난 매출은 모두 입금과 맞아요.")];
  const missing = h("section", { class: "rc-sec" },
    h("h2", null, `누락 점검표${details.length ? ` (${details.length}건)` : ""}`),
    h("p", { class: "rc-hint" }, `입금 기한(${biz ? "매출일 + 정산 영업일수" : "매출일 + 정산일수"})이 기준일 이전인데 입금이 안 맞는 매출이에요. 차이는 − 부족, + 초과로 표시해요.`),
    fifoNote,
    lastRow,
    linkedBlock(ctx.linked));

  /* 5) 결제수단별 수수료율 */
  const fr = res.feeRates.filter((f) => f.salesDone > 0);
  const verdict = (f) => {
    const useClean = f.missingN > 0 && f.rateClean != null, base = useClean ? f.rateClean : f.rate;
    const pp = f.contract != null && base != null ? (base - f.contract) * 100 : null;
    if (pp == null) return "-";
    return (Math.abs(pp) < 0.05 ? "계약과 같음" : pp > 0 ? `계약보다 ${pp.toFixed(2)}%p 높음` : `계약보다 ${(-pp).toFixed(2)}%p 낮음`) + (useClean ? " (누락 제외 값 기준)" : "");
  };
  const derived = fr.filter((f) => f.derived).map((f) => METHOD_LABEL[f.method]);
  const fees = h("section", { class: "rc-sec" },
    h("h2", null, "결제수단별 수수료율"),
    h("p", { class: "rc-hint" }, "입금 기한이 지난 ‘완료 구간’의 (매출 − 입금) ÷ 매출이에요. 누락 의심인 날이 섞이면 그만큼 높게 나오니, 그런 날을 뺀 값도 같이 보여요."),
    fr.length ? table([{ l: "결제수단" }, { l: "완료 구간 매출", n: true }, { l: "입금", n: true }, { l: "실효 수수료율", n: true }, { l: "누락 제외", n: true }, { l: "계약율", n: true }, { l: "계약 대비", w: true }],
      fr.map((f) => ({ cells: [METHOD_LABEL[f.method], fmtMan(f.salesDone), fmtMan(f.netDone), fmtPct(f.rate), f.missingN > 0 && f.rateClean != null ? fmtPct(f.rateClean) : "-", f.contract != null ? fmtPct(f.contract) : "미입력", verdict(f)] })))
      : h("p", { class: "rc-hint" }, "입금 기한이 지난 매출이 아직 없어요."),
    derived.length > 0 && h("p", { class: "rc-hint" }, `${derived.join("·")}은(는) 입금에 수수료 칸이 없어 계약 수수료율로 역산했어요. 실제 수수료가 계약보다 높으면 ‘누락 의심’으로 보일 수 있어요.`));

  return h("div", { class: "rc-paper", role: "document" }, demo, head, summary, missing, fees);
}

/* ---------------- 열기·닫기 ---------------- */
let current = null;

/** 인쇄 미리보기 레이어를 연다. 열람 권한이 없으면 Error. 반환: { el, close } */
export function openPrintSheet(ctx) {
  if (!ctx || !ctx.user || !canViewFinance(ctx.user.role)) throw new Error("대표·부대표·회장만 대조 내역서를 출력할 수 있어요.");
  if (!ctx.res || !ctx.res.summary || !ctx.res.period) throw new Error("대조 결과가 없어서 내역서를 만들 수 없어요.");
  const paper = buildPaper(ctx); // 그리다 실패하면 여기서 던지므로 화면에는 아무 흔적이 남지 않는다
  current?.close();
  const styleEl = injectStyle(!!ctx.isDemo);

  const prevFocus = document.activeElement, prevTitle = document.title, inerted = [];
  let closed = false;
  const print = () => { try { window.print(); } catch { toast("인쇄 창을 열지 못했어요. 브라우저 메뉴의 인쇄를 이용해 주세요", 4000); } };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const wrap = h("div", { class: "rc-sheet-wrap", role: "dialog", "aria-modal": "true", "aria-label": "인쇄 미리보기", tabindex: "-1" },
    h("div", { class: "rc-sheet-bar" },
      h("button", { type: "button", class: "rc-b-main", onclick: print }, "인쇄 / PDF로 저장"),
      h("button", { type: "button", onclick: () => close() }, "닫기")),
    h("p", { class: "rc-sheet-note" }, "A4 용지 기준 미리보기예요. 휴대폰에서는 표를 칸으로 쌓아 보여 주고, 인쇄·PDF에서는 표 모양으로 나와요."),
    paper);
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    wrap.remove();
    styleEl.remove(); // 닫은 뒤에는 이 스타일이 남지 않게(열 때마다 다시 주입)
    for (const el of inerted) el.inert = false;
    document.documentElement.classList.remove("rc-sheet-open");
    document.title = prevTitle;
    if (current === handle) current = null;
    try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  }
  const handle = { el: wrap, close };
  current = handle;
  document.body.append(wrap);
  for (const el of document.body.children) if (el !== wrap && !el.inert) { el.inert = true; inerted.push(el); } // 뒤 화면은 키보드·읽기 도구가 못 들어가게
  document.documentElement.classList.add("rc-sheet-open");
  document.title = `${SHEET_TITLE}_${ctx.res.asOf}`; // PDF 로 저장할 때 기본 파일 이름이 된다
  document.addEventListener("keydown", onKey, true);
  wrap.focus({ preventScroll: true });
  return handle;
}
