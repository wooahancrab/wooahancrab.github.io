// 매출-입금 대조 내역서의 엑셀 파일(4시트). SheetJS(XLSX 전역)를 인자로 받는 순수 함수 — 화면 코드 없음.
// 시트: ①요약 ②누락 건 상세 ③일별 전체 대조 ④짝 없는 입금(아래에 ctx.linked 가 있으면 '직접 연결한 입금' 구역). 금액은 인쇄물과 달리 '원 단위 그대로'(숫자 셀, 서식 #,##0)라 엑셀에서 다시 계산할 수 있다.
// 합계·차이·검산은 엑셀 수식(f)으로 넣고, 수식을 다시 계산하지 않는 뷰어에서도 보이도록 계산값(v)을 같이 적는다.
// 열람 권한(대표·부대표·회장)이 없으면 오류를 던진다 — 화면의 버튼 숨김에만 의존하지 않는다.
import { t, tx, lang, fmtNum } from "./i18n.js";
import { buildDetail, candidatesFor, canViewFinance, METHODS, METHOD_LABEL, MODE_KO } from "./recon18.js";

// 엑셀 파일은 '내려받는 순간'의 화면 언어를 따른다(한국어·베트남어·영어). 시트 이름·머리글·수식 안의 글자까지 모두 함수 안에서 t() 로 만든다(모듈이 불러와질 때는 아직 한국어라서).
// 한국어 결과(셀 값·수식·서식)는 예전 파일과 똑같다. 결제수단·원인·배정 방식·처리 상태 이름은 lib/recon18.js 가 화면 언어로 돌려준다.
// 시트 이름은 31자 이하이고 [ ] : * ? / \ 를 쓸 수 없다(사전에도 이 글자를 넣지 않는다).
export const SHEET_NAMES = {
  get summary() { return T("요약"); }, get detail() { return t("누락 건 상세"); }, get daily() { return t("일별 전체 대조"); }, get unmatched() { return t("짝 없는 입금"); },
};
export const demoText = () => t("가상 데이터 (실제 자료 아님)");
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FMT_WON = "#,##0", FMT_DATE = "yyyy-mm-dd", FMT_DT = "yyyy-mm-dd hh:mm", FMT_PCT = "0.00%";
const T = (k, p) => tx("내역서", k, p); // 짧고 흔한 낱말은 '내역서::낱말' 로 따로 번역한다(다른 화면의 같은 한국어와 뜻이 달라도 서로 안 섞이게). 사전에 맥락 키가 없으면 그냥 낱말 키를 쓴다
const roleName = (r) => ({ owner: t("대표"), deputy: t("부대표"), chairman: t("회장") })[r] ?? r;
const stateName = (s) => ({ done: t("완료 확정"), missing: t("누락 의심"), over: t("초과 입금"), partial: t("일부 입금"), waiting: t("입금 대기"), early: t("기한 전 입금") })[s] ?? s;
const shortMode = (m) => ({ explicit: t("정확히 연결"), manual: t("직접 연결"), fifo: t("추정") })[m] ?? m;
const calText = (m) => (m === "business" ? t("영업일 기준(주말·휴일 제외)") : t("달력일 기준(매출일 + 정산일수)"));
const nItem = (n) => (n === 1 ? T("1건") : T("{n}건", { n })); // 1 item · 3 items
/** 엑셀 수식 안의 문자열 리터럴 */
const fq = (s) => `"${String(s).replace(/"/g, '""')}"`;
/** 숫자 서식에 붙는 단위 글자: t("{n}영업일") 같은 문장에서 {n} 앞뒤 글자를 따와 '0"영업일"' · '0" business days"' 로 만든다(값은 숫자 그대로) */
const unitFmt = (tpl) => { const [pre, post] = tpl.split("{n}"); return (pre ? `"${pre.replace(/"/g, "")}"` : "") + "0" + (post ? `"${post.replace(/"/g, "")}"` : ""); };

/* ---------------- 권한·입력 확인 ---------------- */
function guard(ctx) {
  if (!canViewFinance(ctx?.user?.role)) throw new Error(t("매출-입금 대조 내역서는 대표·부대표·회장만 내려받을 수 있어요"));
  if (!ctx.res || !ctx.res.summary || !ctx.res.period) throw new Error(t("대조 결과가 없어서 엑셀을 만들 수 없어요"));
}
const isDemoOf = (ctx) => !!(ctx.isDemo ?? ctx.settings?.isDemo);
const modeOf = (ctx) => ctx.res.mode ?? ctx.settings?.mode ?? "calendar";
const isBiz = (ctx) => modeOf(ctx) === "business";
/** 정산일수 셀 서식: 영업일 모드면 '18영업일'처럼 보이게(값은 숫자 그대로), 달력 모드는 숫자만 */
const daysFmt = (ctx) => (isBiz(ctx) ? unitFmt(t("{n}영업일")) : "0");
const daysHead = (ctx) => (isBiz(ctx) ? t("정산일수(영업일)") : T("정산일수"));
const BLANK_NAME = /[\s​-‍⁠﻿ᅟᅠㅤ]/g; // 공백·눈에 안 보이는 글자(너비 없는 공백, 한글 채움 문자)

/* ---------------- 값 도우미 ---------------- */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const serial = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000 + 25569; }; // 엑셀 날짜 일련번호
const clean = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").slice(0, 32000); // XML 에 못 쓰는 문자 제거, 셀 한도(32767자)
const won = (n) => fmtNum(Math.round(Number(n) || 0) || 0); // 천 단위 구분은 화면 언어를 따른다(1,234 · 1.234). -0 은 0 으로
const S = (v) => ({ t: "s", v: clean(v) });
const N = (v, z = FMT_WON) => ({ t: "n", v: Number.isFinite(v) ? v : 0, z });
const D = (iso) => (ISO.test(iso ?? "") ? { t: "n", v: serial(iso), z: FMT_DATE } : S(iso ?? ""));
/** 수식 셀: v 가 문자열이면 문자 결과, 아니면 숫자 결과 */
const F = (f, v, z = FMT_WON) => (typeof v === "string" ? { t: "s", f, v } : { t: "n", f, v: Number.isFinite(v) ? v : 0, z });
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const methodOrder = (m) => { const i = METHODS.findIndex(([k]) => k === m); return i < 0 ? 99 : i; };
const mlabel = (m) => METHOD_LABEL[m] ?? m;

function sheetOf(X) {
  const ws = {};
  let maxR = 0, maxC = 0;
  const texts = [];   // 글자 칸의 줄·열·글자 수(영어·베트남어 열 너비 계산용)
  const api = {
    ws, texts,
    set(r, c, cell) { ws[X.utils.encode_cell({ r, c })] = cell; if (cell && cell.t === "s") texts.push({ r, c, len: [...String(cell.v)].length }); if (r > maxR) maxR = r; if (c > maxC) maxC = c; },
    has: (r, c) => X.utils.encode_cell({ r, c }) in ws,
    row(r, cells, c0 = 0) { cells.forEach((cell, i) => { if (cell != null) api.set(r, c0 + i, cell); }); },
    col: (c) => X.utils.encode_col(c),
    done() { ws["!ref"] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } }); return ws; },
  };
  return api;
}
const titleOf = (ctx, name, note = "") => (isDemoOf(ctx) ? `[${demoText()}] ` : "") + t("{name} · {month} · 기준일 {asOf}", { name, month: ctx.res.month, asOf: ctx.res.asOf }) + (note ? ` · ${note}` : "");
const diffNote = () => t("차이 = 매출액 − (입금+수수료), 양수면 덜 들어옴·음수면 더 들어옴");
const widths = (arr) => arr.map((wch) => ({ wch }));
/** 영어·베트남어는 머리글·라벨이 한국어보다 길어서 열 너비를 글자 길이에 맞춰 넓힌다(한국어는 기존 너비 그대로). 머리글 줄은 모든 칸을, 그 밖의 줄은 오른쪽 칸이 차 있어 글이 잘릴 칸만 센다 */
function fitWidths(sh, base, hdrRows = []) {
  if (lang() === "ko") return widths(base);
  const need = base.slice(), hdr = new Set(hdrRows);
  for (const { r, c, len } of sh.texts) {
    if (c >= need.length) continue;
    if (hdr.has(r) || sh.has(r, c + 1)) need[c] = Math.max(need[c], Math.min(len + 2, Math.max(base[c], 60)));
  }
  return widths(need);
}

/** res.warnings 한 건의 문장 (code: orphan / orphanBig / pre / autoOpening, 모르는 code 는 그대로 알린다) */
function warningText(w) {
  const names = (w.methods ?? []).map(mlabel).join(lang() === "ko" ? "·" : ", ");
  switch (w.code) {
    case "orphan": return t("짝 없는 입금 {n}건(입금+수수료 {amt}원)이 남아 있어요. 미수금에는 반영하지 않았어요.", { n: w.n, amt: won(w.amount) });
    case "orphanBig": return t("{names}: 짝 없는 입금이 미수금보다 {amt}원 더 커요. 이월 미수금이나 입금의 매출일을 확인해 주세요.", { names, amt: won(w.amount) });
    case "pre": return t("분석 시작 전 매출 중 기한이 지났는데 못 받은 돈이 {amt}원 있어요.", { amt: won(w.amount) });
    case "autoOpening": return t("이월 미수금 {amt}원({names})을 짝 없는 입금의 매출일로 자동 반영했어요.", { amt: won(w.amount), names });
    default: return t("확인 필요({code})", { code: String(w.code) });
  }
}

/* ---------------- 시트 1: 요약 ---------------- */
function summarySheet(X, ctx, details) {
  const { res } = ctx, sm = res.summary, per = res.period, sh = sheetOf(X);
  let r = 0;
  const demo = isDemoOf(ctx);
  const hdrRows = []; // 머리글 줄(영어·베트남어 열 너비 계산용)
  if (demo) sh.set(r++, 0, S(demoText()));
  sh.set(r++, 0, S(t("매출-입금 대조 내역서")));
  r++;
  sh.row(r++, [S(t("기준일")), D(res.asOf)]);
  sh.row(r++, [S(t("분석 월")), S(res.month)]);
  sh.row(r++, [S(t("정산일수 계산")), S(calText(modeOf(ctx)))]);
  hdrRows.push(r);
  sh.row(r++, [S(t("분석 기간")), S(t("시작일")), S(T("끝일")), S(T("비고"))]);
  const cut = t("기준일({asOf}) 이후 자료는 반영하지 않음", { asOf: res.asOf });
  sh.row(r++, [S("  " + t("매출")), D(per.from), D(per.monthTo), S(cut)]);
  sh.row(r++, [S("  " + t("입금")), D(per.from), D(per.depositsTo), S(cut)]);
  const now = ctx.now instanceof Date && !Number.isNaN(ctx.now.getTime()) ? ctx.now : new Date();
  const kstMin = (Math.floor(now.getTime() / 60000) * 60000 + 9 * 3600000) / 86400000 + 25569; // 한국 시각, 분 단위
  sh.row(r++, [S(t("출력 일시")), { t: "n", v: kstMin, z: FMT_DT }, S(t("한국 시각"))]);
  // 이름이 비었거나 공백(눈에 안 보이는 글자 포함)뿐이면 역할만 적는다
  const nmRaw = clean(ctx.user.name ?? ""), nm = nmRaw.replace(BLANK_NAME, "") ? nmRaw.trim() : "", role = roleName(ctx.user.role);
  sh.row(r++, [S(t("출력한 사람")), S(nm ? `${nm} (${role})` : role)]);
  r++;

  // 이번 달 요약(금액은 원 단위)
  const inProgress = sm.T < per.monthTo;
  hdrRows.push(r);
  sh.row(r++, [S(t("이번 달 요약 (금액 단위: 원)")), S(t("금액")), S(T("비고"))]);
  const at = {};
  const money = (key, label, value, note) => { at[key] = r; sh.row(r, [S(label), N(value), S(note)]); r++; };
  const span = `${per.monthFrom} ~ ${sm.T}`;
  money("sales", t("이번 달 매출"), sm.sales, span + (inProgress ? " " + t("(진행 중인 달이라 기준일까지)") : ""));
  money("net", t("이번 달 입금(순입금)"), sm.net, t("{span} 입금, 수수료를 뺀 실제 입금액", { span }));
  money("fee", t("수수료"), sm.fee, t("입금의 수수료 칸 합계(칸이 없으면 계약 수수료율로 역산)"));
  money("arPrev", t("전월 말 미수금"), sm.arPrev, t("{d} 기준", { d: sm.prevEnd }));
  money("arEnd", inProgress ? t("미수금(진행 중이라 기준일)") : t("월말 미수금"), sm.arEnd, t("{d} 기준", { d: sm.T }));
  // 진행 중인 달이면 '기준일 이후', 월이 끝났으면 입금 예정 날짜 범위(다음 달 1일 ~ 입금 마감일)로 적는다
  const expBase = inProgress ? t("기준일 이후 입금 예정") : t("입금 예정({from} ~ {to})", { from: per.nextFrom, to: per.depositsTo });
  const expLabel = (tail) => (inProgress ? t("기준일 이후 입금 예정({tail})", { tail }) : t("입금 예정({from} ~ {to}, {tail})", { from: per.nextFrom, to: per.depositsTo, tail }));
  money("nextExpected", expLabel(t("수수료 전")), sm.nextExpected, t("입금 기한이 {d} 뒤인 미수 매출", { d: sm.T }));
  money("nextExpectedNet", expLabel(t("수수료 후")), sm.nextExpectedNet, t("계약 수수료율을 뺀 예상 입금액"));
  money("overdue", t("기한 지난 미수 금액"), sm.overdueAtEnd, t("입금 기한이 {d} 이전인데 못 받은 금액", { d: sm.T }));
  // 분석 시작 전 매출·짝 없는 입금(미수금에서 빼지 않고 따로 보여 주는 입금). 이 값들이 없는 옛 결과(res)면 0으로 본다
  const orphanPrev = sm.orphanPrev ?? 0, orphanEnd = sm.orphanEnd ?? 0;
  money("opening", t("이월 미수금(분석 시작 전 매출)"), sm.openingTotal ?? 0, sm.openingAuto > 0 ? t("그중 {amt}원은 매출일이 시작 전으로 적힌 짝 없는 입금으로 자동 반영", { amt: won(sm.openingAuto) }) : (sm.openingTotal ?? 0) > 0 ? t("입력한 이월 미수금") : t("분석 시작 전 매출 중 못 받은 돈"));
  money("overduePre", t("시작 전 매출 중 기한 지난 미수"), sm.overduePre ?? 0, t("표에는 안 보이지만 '{label}'에 포함", { label: t("기한 지난 미수 금액") }));
  money("orphanPrev", t("전월 말 짝 없는 입금"), orphanPrev, t("{d} 기준, 입금+수수료. 미수금에서 빼지 않음", { d: sm.prevEnd }));
  money("orphanEnd", t("월말 짝 없는 입금"), orphanEnd, t("{d} 기준, 입금+수수료. 미수금에서 빼지 않음", { d: sm.T }));
  sh.row(r++, [S(t("누락 점검표 건수")), N(details.length), S(t("기한이 지났는데 안 맞는 건({a}·{b})", { a: stateName("missing"), b: stateName("over") }))]);
  sh.row(r++, [S(t("짝 없는 입금 건수")), N((res.unmatchedDeposits ?? []).length), S(t("기준일·월말까지 들어왔는데 어느 매출에도 배정되지 않은 입금(다음 달 매출을 가리키는 입금은 제외)"))]);
  r++;

  // 검산: 입금 = 전월 말 미수 + 매출 − 월말 미수 − 수수료 + 짝 없는 입금 증가분(월말 − 전월 말)
  const cell = (k) => `B${at[k] + 1}`;
  const calc = sm.arPrev + sm.sales - sm.arEnd - sm.fee + (orphanEnd - orphanPrev), diff = calc - sm.net;
  sh.row(r++, [S(t("검산: 입금 = 전월 말 미수 + 매출 − 월말 미수 − 수수료 + 짝 없는 입금 증가분"))]);
  hdrRows.push(r);
  sh.row(r++, [S(t("검산 (금액 단위: 원)")), S(t("금액")), S(T("비고"))]);
  const calcRow = r;
  const okText = T("일치"), badText = T("불일치");
  sh.row(r++, [S(t("계산값")), F(`${cell("arPrev")}+${cell("sales")}-${cell("arEnd")}-${cell("fee")}+(${cell("orphanEnd")}-${cell("orphanPrev")})`, calc), S(t("짝 없는 입금 증가분 = 월말 짝 없는 입금 − 전월 말 짝 없는 입금"))]);
  sh.row(r++, [S(t("이번 달 입금(순입금)과의 차이")), F(`B${calcRow + 1}-${cell("net")}`, diff), S(t("0이면 일치"))]);
  sh.row(r++, [S(t("일치 여부")), F(`IF(ROUND(B${calcRow + 2},0)=0,${fq(okText)},${fq(badText)})`, Math.round(diff) === 0 ? okText : badText)]);
  r++;

  // 확인할 점(res.warnings)
  sh.row(r++, [S(t("확인할 점"))]);
  const warns = (res.warnings ?? []).map((w) => warningText(w));
  if (warns.length) for (const wt of warns) sh.row(r++, [S("  " + wt)]);
  else sh.row(r++, [S("  " + t("없음"))]);
  r++;

  // 결제수단별 표
  sh.row(r++, [S(t("결제수단별 (금액 단위: 원)"))]);
  const mh = [t("결제수단"), daysHead(ctx), t("계약 수수료율"), t("전월 말 미수금"), t("이번 달 매출"), t("이번 달 입금(순)"), t("수수료"), t("월말 미수금"), t("짝 없는 입금 증가분"), t("검산(0이면 일치)"), expBase, t("기한 지난 미수")];
  hdrRows.push(r);
  sh.row(r++, mh.map(S));
  const m0 = r;
  if (!res.methods.length) sh.row(r++, [S(t("결제수단별 자료가 없어요"))]); // 합계 수식이 자기 줄을 가리키지 않도록 빈 줄 1칸을 둔다
  const orphanDeltaOf = (m) => (m.orphanEnd ?? 0) - (m.orphanPrev ?? 0);
  const checkOf = (m) => m.netMonth - (m.arPrev + m.salesMonth - m.arEnd - m.feeMonth + orphanDeltaOf(m));
  for (const m of res.methods) {
    const x = r + 1;
    sh.row(r, [S(mlabel(m.method)), N(m.days, daysFmt(ctx)), m.contractFee ? N(m.contractFee, FMT_PCT) : S("-"), N(m.arPrev), N(m.salesMonth), N(m.netMonth), N(m.feeMonth), N(m.arEnd),
      N(orphanDeltaOf(m)), F(`F${x}-(D${x}+E${x}-H${x}-G${x}+I${x})`, checkOf(m)), N(m.nextExpected), N(m.overdueAtEnd)]);
    r++;
  }
  const ms = res.methods, a = m0 + 1, b = m0 + Math.max(ms.length, 1); // SUM 범위(결제수단이 없으면 빈 줄 1칸)
  const tot = (c, f) => F(`SUM(${c}${a}:${c}${b})`, sum(ms, f));
  sh.row(r++, [S(t("합계")), null, null, tot("D", (m) => m.arPrev), tot("E", (m) => m.salesMonth), tot("F", (m) => m.netMonth), tot("G", (m) => m.feeMonth), tot("H", (m) => m.arEnd),
    tot("I", orphanDeltaOf), tot("J", checkOf), tot("K", (m) => m.nextExpected), tot("L", (m) => m.overdueAtEnd)]);
  r++;

  // 결제수단별 수수료율 표
  sh.row(r++, [S(t("결제수단별 수수료율 (완료 구간 = 입금 기한이 기준일 이전인 매출)"))]);
  sh.row(r++, [S(t("실효율 = (매출 − 입금) ÷ 매출. 누락·초과로 걸린 날이 섞이면 높게 나오므로, 그런 날을 뺀 값도 함께 적었어요."))]);
  const fh = [t("결제수단"), t("완료 구간 매출"), t("완료 구간 입금(순)"), t("실효율"), t("누락 제외 매출"), t("누락 제외 입금"), t("누락 제외 실효율"), t("계약 수수료율"), t("수수료 근거"), t("누락·초과 건수")];
  hdrRows.push(r);
  sh.row(r++, fh.map(S));
  if (!res.feeRates.length) sh.row(r++, [S(t("수수료율을 계산할 자료가 없어요"))]);
  for (const f of res.feeRates) {
    const x = r + 1;
    sh.row(r, [S(mlabel(f.method)), N(f.salesDone), N(f.netDone),
      F(`IF(B${x}=0,"",(B${x}-C${x})/B${x})`, f.rate == null ? "" : f.rate, FMT_PCT),
      N(f.salesClean), N(f.netClean),
      F(`IF(E${x}=0,"",(E${x}-F${x})/E${x})`, f.rateClean == null ? "" : f.rateClean, FMT_PCT),
      f.contract ? N(f.contract, FMT_PCT) : S("-"), S(f.derived ? t("계약 수수료율로 역산") : f.contract == null && !f.feeDone ? t("수수료 정보 없음(0원으로 계산)") : t("입금 내역의 수수료 칸")), N(f.missingN)]);
    r++;
  }
  const ws = sh.done();
  ws["!cols"] = fitWidths(sh, [inProgress ? 38 : 48, 18, 18, 18, 18, 20, 18, 18, 20, 20, inProgress ? 22 : 40, 16], hdrRows); // 날짜 범위가 들어가는 라벨·머리글이 잘리지 않게
  return ws;
}

/* ---------------- 시트 2: 누락 건 상세 ---------------- */
const partText = (p, i) => t("{no}) {date} {payer} 입금 {net}원 · 수수료 {fee}원 · {mode}", { no: i + 1, date: p.date, payer: p.payer || t("입금처 없음"), net: won(p.net), fee: won(p.fee), mode: shortMode(p.mode) });
const candText = (c, i) => {
  const tags = [];
  if (c.amountHit) tags.push(t("금액 ±5% 이내"));
  if (c.dateHit) tags.push(c.dueGap === 0 ? t("기한 당일") : t("기한 앞뒤 {n}일", { n: c.dueGap }));
  if (!c.sameMethod) tags.push(t("다른 결제수단: {m}", { m: mlabel(c.method) }));
  return t("{no}) {date} {payer} · 입금 {net}원 + 수수료 {fee}원 ({tags})", { no: i + 1, date: c.date, payer: c.payer || t("입금처 없음"), net: won(c.net), fee: won(c.fee ?? 0), tags: tags.join(", ") });
};
const modeSummary = (parts) => (parts.length ? [...new Set(parts.map((p) => MODE_KO[p.mode] ?? p.mode))].join(" + ") : t("배정된 입금 없음"));

function detailSheet(X, ctx, details) {
  const sh = sheetOf(X);
  sh.set(0, 0, S(titleOf(ctx, SHEET_NAMES.detail, diffNote())));
  const head = [t("매출일"), t("결제수단"), t("매출액(원)"), daysHead(ctx), t("입금 기한"), t("기한 경과일"), t("배정된 입금액(순)(원)"), t("수수료(원)"), t("입금+수수료(원)"), t("차이(원)"), t("원인 추정"), t("배정 방식"), t("배정된 입금 내역"), t("후보 입금(아직 짝 없는 입금)"), T("처리 상태"), t("확인 메모")];
  sh.row(1, head.map(S));
  const R0 = 2, n = details.length;
  details.forEach((d, i) => {
    const r = R0 + i, x = r + 1;
    sh.row(r, [D(d.date), S(mlabel(d.method)), N(d.amount), N(d.days, daysFmt(ctx)), D(d.due), N(d.lateDays, "0"), N(d.net), N(d.fee),
      F(`G${x}+H${x}`, d.net + d.fee), F(`C${x}-I${x}`, d.amount - (d.net + d.fee)),
      S(d.cause?.text ?? ""), S(modeSummary(d.parts)), S(d.parts.length ? d.parts.map(partText).join(" / ") : t("배정된 입금 없음")),
      S(d.candidates.length ? d.candidates.map(candText).join(" / ") : t("후보 없음")), S(d.statusText), S(d.memo)]);
  });
  if (!n) sh.set(R0, 0, S(t("기한이 지났는데 안 맞는 건({a}·{b})이 없어요", { a: stateName("missing"), b: stateName("over") })));
  const last = R0 + Math.max(n, 1), a = R0 + 1, b = last; // SUM 범위(건이 없으면 빈 줄 1칸)
  const tot = (c, f) => F(`SUM(${c}${a}:${c}${b})`, sum(details, f));
  sh.row(last, [S(t("합계")), S(nItem(n)), tot("C", (d) => d.amount), null, null, null, tot("G", (d) => d.net), tot("H", (d) => d.fee), tot("I", (d) => d.net + d.fee), tot("J", (d) => d.amount - (d.net + d.fee))]);
  const ws = sh.done();
  ws["!cols"] = fitWidths(sh, [12, 12, 14, isBiz(ctx) ? 18 : 10, 12, 12, 20, 12, 16, 14, 22, 30, 80, 100, 16, 30], [1]);
  if (n) ws["!autofilter"] = { ref: `A2:P${R0 + n}` };
  ws["!freeze"] = { xSplit: 2, ySplit: 2 }; // 제목·머리글 줄, 매출일·결제수단 열 고정(SheetJS 무료판은 못 써서 buildXlsxBytes 가 넣는다)
  return ws;
}

/* ---------------- 시트 3: 일별 전체 대조 ---------------- */
const dailyMode = (parts) => (parts.length ? [...new Set(parts.map((p) => shortMode(p.mode)))].join(" + ") : t("없음"));

function dailySheet(X, ctx) {
  const sh = sheetOf(X);
  const rows = (ctx.res.rows ?? []).slice().sort((a, b) => a.date.localeCompare(b.date) || methodOrder(a.method) - methodOrder(b.method));
  sh.set(0, 0, S(titleOf(ctx, SHEET_NAMES.daily, diffNote())));
  const head = [t("매출일"), t("결제수단"), t("매출액(원)"), t("입금 기한"), T("구분"), T("상태"), t("배정 입금액(순)(원)"), t("수수료(원)"), t("입금+수수료(원)"), t("차이(원)"), t("배정 방식")];
  sh.row(1, head.map(S));
  const R0 = 2, n = rows.length;
  rows.forEach((w, i) => {
    const r = R0 + i, x = r + 1;
    sh.row(r, [D(w.date), S(mlabel(w.method)), N(w.amount), D(w.due), S(w.confirmed ? t("완료 확정") : t("입금 대기")), S(stateName(w.state)),
      N(w.net), N(w.fee), F(`G${x}+H${x}`, w.net + w.fee), F(`C${x}-I${x}`, w.amount - (w.net + w.fee)), S(dailyMode(w.parts))]);
  });
  if (!n) sh.set(R0, 0, S(t("분석 기간에 매출이 없어요")));
  const last = R0 + Math.max(n, 1), a = R0 + 1, b = last;
  // 합계는 SUBTOTAL(9) — 필터를 걸면 보이는 행만 더한다(필터가 없으면 SUM 과 같다)
  const tot = (c, f) => F(`SUBTOTAL(9,${c}${a}:${c}${b})`, sum(rows, f));
  sh.row(last, [S(t("합계")), S(nItem(n)), tot("C", (w) => w.amount), null, null, null, tot("G", (w) => w.net), tot("H", (w) => w.fee), tot("I", (w) => w.net + w.fee), tot("J", (w) => w.amount - (w.net + w.fee)), S(t("필터를 걸면 보이는 행만 더해요"))]);
  const ws = sh.done();
  ws["!cols"] = fitWidths(sh, [12, 12, 14, 12, 12, 14, 20, 12, 16, 14, 30], [1]);
  if (n) ws["!autofilter"] = { ref: `A2:K${R0 + n}` };
  ws["!freeze"] = { xSplit: 0, ySplit: 2 };
  return ws;
}

/* ---------------- 시트 4: 짝 없는 입금 ---------------- */
const unmatchedNote = () => t("표시: 일부 사용 = 일부는 다른 매출에 배정되고 남은 몫 · 직접 연결 = 사람이 눌러 매출에 연결한 입금");
/** 짝 없는 입금 한 건의 '표시' 칸 글자(해당 없으면 null) */
const markOf = (d) => [d.used ? t("일부 사용") : "", d.linked ? t("직접 연결") : ""].filter(Boolean).join(" · ") || null;
/** ctx.linked(사람이 눌러 연결한 입금) 정리 — 배열이 아니거나 빈 칸투성이 항목은 버린다 */
const linkedOf = (ctx) => (Array.isArray(ctx.linked) ? ctx.linked : []).filter((x) => x && typeof x === "object")
  .map((x) => ({ ...x, netV: Math.round(Number(x.net) || 0), feeV: Math.round(Number(x.fee) || 0) }))
  .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));

function unmatchedSheet(X, ctx) {
  const { res } = ctx, sh = sheetOf(X);
  const deps = (res.unmatchedDeposits ?? []).slice().sort((a, b) => a.date.localeCompare(b.date) || a.idx - b.idx);
  sh.set(0, 0, S(titleOf(ctx, SHEET_NAMES.unmatched, unmatchedNote())));
  const head = [t("입금일"), t("입금처"), t("결제수단"), t("입금액(순)(원)"), t("수수료(원)"), t("입금+수수료(원)"), t("연결 후보가 될 수 있는 누락 매출"), T("표시")];
  sh.row(1, head.map(S));
  const hdrRows = [1];
  // 누락 매출마다 '이 입금이 그 매출 것일 수 있음' 후보를 구해 입금 쪽에서 거꾸로 모은다(화면의 후보 입금과 같은 규칙)
  const hits = new Map();
  for (const m of res.missing ?? []) {
    for (const c of candidatesFor(m, res.unmatchedDeposits)) {
      if (!hits.has(c.idx)) hits.set(c.idx, []);
      hits.get(c.idx).push(m);
    }
  }
  const R0 = 2, n = deps.length;
  deps.forEach((d, i) => {
    const r = R0 + i, x = r + 1, net = d.amount - (d.fee ?? 0), fee = d.fee ?? 0;
    const ms = hits.get(d.idx) ?? [];
    sh.row(r, [D(d.date), S(d.payer || t("입금처 없음")), S(mlabel(d.method)), N(net), N(fee), F(`D${x}+E${x}`, net + fee),
      S(ms.length ? ms.map((m) => t("{date} {method} (매출 {amt}원, 차이 {diff}원)", { date: m.date, method: mlabel(m.method), amt: won(m.amount), diff: won(m.diff) })).join(" / ") : t("없음")), markOf(d) ? S(markOf(d)) : null]);
  });
  if (!n) sh.set(R0, 0, S(t("짝 없는 입금이 없어요")));
  const last = R0 + Math.max(n, 1), a = R0 + 1, b = last;
  const tot = (c, f) => F(`SUM(${c}${a}:${c}${b})`, sum(deps, f));
  sh.row(last, [S(t("합계")), S(nItem(n)), null, tot("D", (d) => d.amount - (d.fee ?? 0)), tot("E", (d) => d.fee ?? 0), tot("F", (d) => d.amount)]);

  // 직접 연결한 입금 — ctx.linked 가 있을 때만 아래에 별도 구역을 만든다(없으면 그리지 않는다)
  const lk = linkedOf(ctx);
  if (lk.length) {
    let q = last + 2;
    sh.set(q++, 0, S(t("직접 연결한 입금 (사람이 눌러 매출에 연결한 입금 · 입금+수수료 = 입금액(순) + 수수료)")));
    hdrRows.push(q);
    sh.row(q++, [t("입금일"), t("입금처"), t("입금액(순)(원)"), t("수수료(원)"), t("입금+수수료(원)"), t("연결한 매출일"), t("연결한 결제수단"), T("처리 상태"), t("확인 메모")].map(S));
    const q0 = q;
    lk.forEach((x, i) => {
      const y = q0 + i + 1;
      sh.row(q0 + i, [D(x.date), S(x.payer || t("입금처 없음")), N(x.netV), N(x.feeV), F(`C${y}+D${y}`, x.netV + x.feeV), D(x.saleDate), S(mlabel(x.method ?? "")), S(x.statusText ?? ""), S(x.memo ?? "")]);
    });
    const qa = q0 + 1, qb = q0 + lk.length, lt = (c, f) => F(`SUM(${c}${qa}:${c}${qb})`, sum(lk, f));
    sh.row(q0 + lk.length, [S(t("합계")), S(nItem(lk.length)), lt("C", (x) => x.netV), lt("D", (x) => x.feeV), lt("E", (x) => x.netV + x.feeV)]);
  }
  const ws = sh.done();
  ws["!cols"] = fitWidths(sh, [12, 34, 14, 18, 18, 18, 60, 22, 40], hdrRows);
  if (n) ws["!autofilter"] = { ref: `A2:H${R0 + n}` };
  ws["!freeze"] = { xSplit: 0, ySplit: 2 };
  return ws;
}

/* ---------------- 내보내기 ---------------- */
/** ctx = { res, settings, isDemo, user:{name,role}, now:Date, notes, linked } → SheetJS workbook (시트 4개). linked = 사람이 눌러 연결한 입금 목록(없으면 빈 배열로 본다). 열람 권한이 없으면 Error */
export function buildWorkbook(X, ctx) {
  guard(ctx);
  const notes = ctx.notes ?? {};
  const details = (ctx.res.missing ?? []).map((row) => buildDetail(row, ctx.res, notes));
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, summarySheet(X, ctx, details), SHEET_NAMES.summary);
  X.utils.book_append_sheet(wb, detailSheet(X, ctx, details), SHEET_NAMES.detail);
  X.utils.book_append_sheet(wb, dailySheet(X, ctx), SHEET_NAMES.daily);
  X.utils.book_append_sheet(wb, unmatchedSheet(X, ctx), SHEET_NAMES.unmatched);
  wb.Props = { Title: (isDemoOf(ctx) ? demoText() + " " : "") + t("매출-입금 대조 내역서") };
  return wb;
}

/** '매출입금대조_YYYY-MM_기준일YYYYMMDD.xlsx', 가상 데이터면 앞에 '가상데이터_' (영어·베트남어는 알파벳 파일 이름) */
export function exportFileName(ctx) {
  guard(ctx);
  const asOf = String(ctx.res.asOf ?? ctx.settings?.asOf ?? "").replace(/-/g, "");
  return `${isDemoOf(ctx) ? t("가상데이터_") : ""}${t("매출입금대조_{month}_기준일{asOf}.xlsx", { month: ctx.res.month ?? ctx.settings?.month ?? "", asOf })}`;
}

/* 머리글 고정(freeze): SheetJS 무료판(0.18.5)은 틀 고정을 못 쓰므로, 만든 .xlsx(zip)의 시트 XML 에 <pane> 을 끼워 넣는다. 실패하면 원본 그대로 쓴다. */
function panesXml(fr) {
  const x = fr.xSplit || 0, y = fr.ySplit || 0, col = X_COL(x), row = y + 1;
  if (x && y) return `<pane xSplit="${x}" ySplit="${y}" topLeftCell="${col}${row}" activePane="bottomRight" state="frozen"/><selection pane="topRight" activeCell="${col}1" sqref="${col}1"/><selection pane="bottomLeft" activeCell="A${row}" sqref="A${row}"/><selection pane="bottomRight" activeCell="${col}${row}" sqref="${col}${row}"/>`;
  if (y) return `<pane ySplit="${y}" topLeftCell="A${row}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${row}" sqref="A${row}"/>`;
  return `<pane xSplit="${x}" topLeftCell="${col}1" activePane="topRight" state="frozen"/><selection pane="topRight" activeCell="${col}1" sqref="${col}1"/>`;
}
const X_COL = (c) => String.fromCharCode(65 + c); // 고정할 열은 A~Z 안
function patchFreeze(X, raw, wb) {
  const zip = X.CFB.read(new Uint8Array(raw), { type: "array" });
  const enc = new TextEncoder(), dec = new TextDecoder("utf-8");
  wb.SheetNames.forEach((name, i) => {
    const fr = wb.Sheets[name]["!freeze"];
    if (!fr || (!fr.xSplit && !fr.ySplit)) return;
    const k = zip.FullPaths.findIndex((p) => p.endsWith(`xl/worksheets/sheet${i + 1}.xml`));
    if (k < 0) throw new Error("시트 파일을 찾지 못했어요");
    const xml = dec.decode(Uint8Array.from(zip.FileIndex[k].content));
    const from = '<sheetView workbookViewId="0"/>';
    if (!xml.includes(from)) throw new Error("시트 보기 설정을 찾지 못했어요");
    const content = enc.encode(xml.replace(from, `<sheetView workbookViewId="0">${panesXml(fr)}</sheetView>`));
    zip.FileIndex[k].content = content;
    zip.FileIndex[k].size = content.length;
  });
  const out = X.CFB.write(zip, { fileType: "zip", type: "array", compression: true });
  const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
  const back = X.read(bytes, { type: "array", bookSheets: true }); // 다시 읽혀야 쓴다
  if (back.SheetNames.join("|") !== wb.SheetNames.join("|")) throw new Error("틀 고정을 넣은 파일을 읽지 못했어요");
  return bytes;
}

/** .xlsx 바이트(Uint8Array). buildWorkbook 결과에 틀 고정(머리글)까지 넣는다 — 틀 고정을 못 넣으면 그것만 빼고 같은 파일 */
export function buildXlsxBytes(X, ctx) {
  const wb = buildWorkbook(X, ctx);
  const raw = X.write(wb, { bookType: "xlsx", type: "array", compression: true });
  try { return patchFreeze(X, raw, wb); } catch { return new Uint8Array(raw); }
}

/** 브라우저에서 바로 내려받는다(틀 고정 포함). 파일 이름을 돌려준다. 권한이 없으면 Error */
export function downloadXlsx(X, ctx) {
  const bytes = buildXlsxBytes(X, ctx), name = exportFileName(ctx);
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}
