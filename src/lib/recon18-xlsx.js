// 매출-입금 대조 내역서의 엑셀 파일(4시트). SheetJS(XLSX 전역)를 인자로 받는 순수 함수 — 화면 코드 없음.
// 시트: ①요약 ②누락 건 상세 ③일별 전체 대조 ④짝 없는 입금(아래에 ctx.linked 가 있으면 '직접 연결한 입금' 구역). 금액은 인쇄물과 달리 '원 단위 그대로'(숫자 셀, 서식 #,##0)라 엑셀에서 다시 계산할 수 있다.
// 합계·차이·검산은 엑셀 수식(f)으로 넣고, 수식을 다시 계산하지 않는 뷰어에서도 보이도록 계산값(v)을 같이 적는다.
// 열람 권한(대표·부대표·회장)이 없으면 오류를 던진다 — 화면의 버튼 숨김에만 의존하지 않는다.
import { buildDetail, candidatesFor, canViewFinance, METHODS, METHOD_LABEL, MODE_KO } from "./recon18.js";

export const SHEET_NAMES = { summary: "요약", detail: "누락 건 상세", daily: "일별 전체 대조", unmatched: "짝 없는 입금" };
export const DEMO_TEXT = "가상 데이터 (실제 자료 아님)";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FMT_WON = "#,##0", FMT_DATE = "yyyy-mm-dd", FMT_DT = "yyyy-mm-dd hh:mm", FMT_PCT = "0.00%";
const ROLE_KO = { owner: "대표", deputy: "부대표", chairman: "회장" };
const STATE_KO = { done: "완료 확정", missing: "누락 의심", over: "초과 입금", partial: "일부 입금", waiting: "입금 대기", early: "기한 전 입금" };
const SHORT_MODE = { explicit: "정확히 연결", manual: "직접 연결", fifo: "추정" };
const CAL_KO = { calendar: "달력일 기준(매출일 + 정산일수)", business: "영업일 기준(주말·휴일 제외)" };
const NO_PERMISSION = "매출-입금 대조 내역서는 대표·부대표·회장만 내려받을 수 있어요";

/* ---------------- 권한·입력 확인 ---------------- */
function guard(ctx) {
  if (!canViewFinance(ctx?.user?.role)) throw new Error(NO_PERMISSION);
  if (!ctx.res || !ctx.res.summary || !ctx.res.period) throw new Error("대조 결과가 없어서 엑셀을 만들 수 없어요");
}
const isDemoOf = (ctx) => !!(ctx.isDemo ?? ctx.settings?.isDemo);
const modeOf = (ctx) => ctx.res.mode ?? ctx.settings?.mode ?? "calendar";
const isBiz = (ctx) => modeOf(ctx) === "business";
/** 정산일수 셀 서식: 영업일 모드면 '18영업일'처럼 보이게(값은 숫자 그대로), 달력 모드는 숫자만 */
const daysFmt = (ctx) => (isBiz(ctx) ? '0"영업일"' : "0");
const daysHead = (ctx) => (isBiz(ctx) ? "정산일수(영업일)" : "정산일수");
const BLANK_NAME = /[\s​-‍⁠﻿ᅟᅠㅤ]/g; // 공백·눈에 안 보이는 글자(너비 없는 공백, 한글 채움 문자)

/* ---------------- 값 도우미 ---------------- */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const serial = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000 + 25569; }; // 엑셀 날짜 일련번호
const clean = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").slice(0, 32000); // XML 에 못 쓰는 문자 제거, 셀 한도(32767자)
const won = (n) => { const v = Math.round(Number(n) || 0); return (v < 0 ? "-" : "") + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };
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
  const api = {
    ws,
    set(r, c, cell) { ws[X.utils.encode_cell({ r, c })] = cell; if (r > maxR) maxR = r; if (c > maxC) maxC = c; },
    row(r, cells, c0 = 0) { cells.forEach((cell, i) => { if (cell != null) api.set(r, c0 + i, cell); }); },
    col: (c) => X.utils.encode_col(c),
    done() { ws["!ref"] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } }); return ws; },
  };
  return api;
}
const titleOf = (ctx, name, note = "") => (isDemoOf(ctx) ? `[${DEMO_TEXT}] ` : "") + `${name} · ${ctx.res.month} · 기준일 ${ctx.res.asOf}` + (note ? ` · ${note}` : "");
const DIFF_NOTE = "차이 = 매출액 − (입금+수수료), 양수면 덜 들어옴·음수면 더 들어옴";
const widths = (arr) => arr.map((wch) => ({ wch }));

/** res.warnings 한 건의 한국어 문장 (code: orphan / orphanBig / pre / autoOpening, 모르는 code 는 그대로 알린다) */
function warningText(w) {
  const names = (w.methods ?? []).map(mlabel).join("·");
  switch (w.code) {
    case "orphan": return `짝 없는 입금 ${w.n}건(입금+수수료 ${won(w.amount)}원)이 남아 있어요. 미수금에는 반영하지 않았어요.`;
    case "orphanBig": return `${names}: 짝 없는 입금이 미수금보다 ${won(w.amount)}원 더 커요. 이월 미수금이나 입금의 매출일을 확인해 주세요.`;
    case "pre": return `분석 시작 전 매출 중 기한이 지났는데 못 받은 돈이 ${won(w.amount)}원 있어요.`;
    case "autoOpening": return `이월 미수금 ${won(w.amount)}원(${names})을 짝 없는 입금의 매출일로 자동 반영했어요.`;
    default: return `확인 필요(${w.code})`;
  }
}

/* ---------------- 시트 1: 요약 ---------------- */
function summarySheet(X, ctx, details) {
  const { res } = ctx, sm = res.summary, per = res.period, sh = sheetOf(X);
  let r = 0;
  const demo = isDemoOf(ctx);
  if (demo) sh.set(r++, 0, S(DEMO_TEXT));
  sh.set(r++, 0, S("매출-입금 대조 내역서"));
  r++;
  sh.row(r++, [S("기준일"), D(res.asOf)]);
  sh.row(r++, [S("분석 월"), S(res.month)]);
  sh.row(r++, [S("정산일수 계산"), S(CAL_KO[modeOf(ctx)] ?? CAL_KO.calendar)]);
  sh.row(r++, [S("분석 기간"), S("시작일"), S("끝일"), S("비고")]);
  const cut = `기준일(${res.asOf}) 이후 자료는 반영하지 않음`;
  sh.row(r++, [S("  매출"), D(per.from), D(per.monthTo), S(cut)]);
  sh.row(r++, [S("  입금"), D(per.from), D(per.depositsTo), S(cut)]);
  const now = ctx.now instanceof Date && !Number.isNaN(ctx.now.getTime()) ? ctx.now : new Date();
  const kstMin = (Math.floor(now.getTime() / 60000) * 60000 + 9 * 3600000) / 86400000 + 25569; // 한국 시각, 분 단위
  sh.row(r++, [S("출력 일시"), { t: "n", v: kstMin, z: FMT_DT }, S("한국 시각")]);
  // 이름이 비었거나 공백(눈에 안 보이는 글자 포함)뿐이면 역할만 적는다
  const nmRaw = clean(ctx.user.name ?? ""), nm = nmRaw.replace(BLANK_NAME, "") ? nmRaw.trim() : "", role = ROLE_KO[ctx.user.role] ?? ctx.user.role;
  sh.row(r++, [S("출력한 사람"), S(nm ? `${nm} (${role})` : role)]);
  r++;

  // 이번 달 요약(금액은 원 단위)
  const inProgress = sm.T < per.monthTo;
  sh.row(r++, [S("이번 달 요약 (금액 단위: 원)"), S("금액"), S("비고")]);
  const at = {};
  const money = (key, label, value, note) => { at[key] = r; sh.row(r, [S(label), N(value), S(note)]); r++; };
  const span = `${per.monthFrom} ~ ${sm.T}`;
  money("sales", "이번 달 매출", sm.sales, span + (inProgress ? " (진행 중인 달이라 기준일까지)" : ""));
  money("net", "이번 달 입금(순입금)", sm.net, `${span} 입금, 수수료를 뺀 실제 입금액`);
  money("fee", "수수료", sm.fee, "입금의 수수료 칸 합계(칸이 없으면 계약 수수료율로 역산)");
  money("arPrev", "전월 말 미수금", sm.arPrev, `${sm.prevEnd} 기준`);
  money("arEnd", inProgress ? "미수금(진행 중이라 기준일)" : "월말 미수금", sm.arEnd, `${sm.T} 기준`);
  // 진행 중인 달이면 '기준일 이후', 월이 끝났으면 입금 예정 날짜 범위(다음 달 1일 ~ 입금 마감일)로 적는다
  const expBase = inProgress ? "기준일 이후 입금 예정" : `입금 예정(${per.nextFrom} ~ ${per.depositsTo})`;
  const expLabel = (tail) => (inProgress ? `${expBase}(${tail})` : `입금 예정(${per.nextFrom} ~ ${per.depositsTo}, ${tail})`);
  money("nextExpected", expLabel("수수료 전"), sm.nextExpected, `입금 기한이 ${sm.T} 뒤인 미수 매출`);
  money("nextExpectedNet", expLabel("수수료 후"), sm.nextExpectedNet, "계약 수수료율을 뺀 예상 입금액");
  money("overdue", "기한 지난 미수 금액", sm.overdueAtEnd, `입금 기한이 ${sm.T} 이전인데 못 받은 금액`);
  // 분석 시작 전 매출·짝 없는 입금(미수금에서 빼지 않고 따로 보여 주는 입금). 이 값들이 없는 옛 결과(res)면 0으로 본다
  const orphanPrev = sm.orphanPrev ?? 0, orphanEnd = sm.orphanEnd ?? 0;
  money("opening", "이월 미수금(분석 시작 전 매출)", sm.openingTotal ?? 0, sm.openingAuto > 0 ? `그중 ${won(sm.openingAuto)}원은 매출일이 시작 전으로 적힌 짝 없는 입금으로 자동 반영` : (sm.openingTotal ?? 0) > 0 ? "입력한 이월 미수금" : "분석 시작 전 매출 중 못 받은 돈");
  money("overduePre", "시작 전 매출 중 기한 지난 미수", sm.overduePre ?? 0, "표에는 안 보이지만 '기한 지난 미수 금액'에 포함");
  money("orphanPrev", "전월 말 짝 없는 입금", orphanPrev, `${sm.prevEnd} 기준, 입금+수수료. 미수금에서 빼지 않음`);
  money("orphanEnd", "월말 짝 없는 입금", orphanEnd, `${sm.T} 기준, 입금+수수료. 미수금에서 빼지 않음`);
  sh.row(r++, [S("누락 점검표 건수"), N(details.length), S("기한이 지났는데 안 맞는 건(누락 의심·초과 입금)")]);
  sh.row(r++, [S("짝 없는 입금 건수"), N((res.unmatchedDeposits ?? []).length), S("기준일·월말까지 들어왔는데 어느 매출에도 배정되지 않은 입금(다음 달 매출을 가리키는 입금은 제외)")]);
  r++;

  // 검산: 입금 = 전월 말 미수 + 매출 − 월말 미수 − 수수료 + 짝 없는 입금 증가분(월말 − 전월 말)
  const cell = (k) => `B${at[k] + 1}`;
  const calc = sm.arPrev + sm.sales - sm.arEnd - sm.fee + (orphanEnd - orphanPrev), diff = calc - sm.net;
  sh.row(r++, [S("검산: 입금 = 전월 말 미수 + 매출 − 월말 미수 − 수수료 + 짝 없는 입금 증가분")]);
  sh.row(r++, [S("검산 (금액 단위: 원)"), S("금액"), S("비고")]);
  const calcRow = r;
  sh.row(r++, [S("계산값"), F(`${cell("arPrev")}+${cell("sales")}-${cell("arEnd")}-${cell("fee")}+(${cell("orphanEnd")}-${cell("orphanPrev")})`, calc), S("짝 없는 입금 증가분 = 월말 짝 없는 입금 − 전월 말 짝 없는 입금")]);
  sh.row(r++, [S("이번 달 입금(순입금)과의 차이"), F(`B${calcRow + 1}-${cell("net")}`, diff), S("0이면 일치")]);
  sh.row(r++, [S("일치 여부"), F(`IF(ROUND(B${calcRow + 2},0)=0,"일치","불일치")`, Math.round(diff) === 0 ? "일치" : "불일치")]);
  r++;

  // 확인할 점(res.warnings)
  sh.row(r++, [S("확인할 점")]);
  const warns = (res.warnings ?? []).map((w) => warningText(w));
  if (warns.length) for (const t of warns) sh.row(r++, [S("  " + t)]);
  else sh.row(r++, [S("  없음")]);
  r++;

  // 결제수단별 표
  sh.row(r++, [S("결제수단별 (금액 단위: 원)")]);
  const mh = ["결제수단", daysHead(ctx), "계약 수수료율", "전월 말 미수금", "이번 달 매출", "이번 달 입금(순)", "수수료", "월말 미수금", "짝 없는 입금 증가분", "검산(0이면 일치)", expBase, "기한 지난 미수"];
  sh.row(r++, mh.map(S));
  const m0 = r;
  if (!res.methods.length) sh.row(r++, [S("결제수단별 자료가 없어요")]); // 합계 수식이 자기 줄을 가리키지 않도록 빈 줄 1칸을 둔다
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
  sh.row(r++, [S("합계"), null, null, tot("D", (m) => m.arPrev), tot("E", (m) => m.salesMonth), tot("F", (m) => m.netMonth), tot("G", (m) => m.feeMonth), tot("H", (m) => m.arEnd),
    tot("I", orphanDeltaOf), tot("J", checkOf), tot("K", (m) => m.nextExpected), tot("L", (m) => m.overdueAtEnd)]);
  r++;

  // 결제수단별 수수료율 표
  sh.row(r++, [S("결제수단별 수수료율 (완료 구간 = 입금 기한이 기준일 이전인 매출)")]);
  sh.row(r++, [S("실효율 = (매출 − 입금) ÷ 매출. 누락·초과로 걸린 날이 섞이면 높게 나오므로, 그런 날을 뺀 값도 함께 적었어요.")]);
  const fh = ["결제수단", "완료 구간 매출", "완료 구간 입금(순)", "실효율", "누락 제외 매출", "누락 제외 입금", "누락 제외 실효율", "계약 수수료율", "수수료 근거", "누락·초과 건수"];
  sh.row(r++, fh.map(S));
  if (!res.feeRates.length) sh.row(r++, [S("수수료율을 계산할 자료가 없어요")]);
  for (const f of res.feeRates) {
    const x = r + 1;
    sh.row(r, [S(mlabel(f.method)), N(f.salesDone), N(f.netDone),
      F(`IF(B${x}=0,"",(B${x}-C${x})/B${x})`, f.rate == null ? "" : f.rate, FMT_PCT),
      N(f.salesClean), N(f.netClean),
      F(`IF(E${x}=0,"",(E${x}-F${x})/E${x})`, f.rateClean == null ? "" : f.rateClean, FMT_PCT),
      f.contract ? N(f.contract, FMT_PCT) : S("-"), S(f.derived ? "계약 수수료율로 역산" : f.contract == null && !f.feeDone ? "수수료 정보 없음(0원으로 계산)" : "입금 내역의 수수료 칸"), N(f.missingN)]);
    r++;
  }
  const ws = sh.done();
  ws["!cols"] = widths([inProgress ? 38 : 48, 18, 18, 18, 18, 20, 18, 18, 20, 20, inProgress ? 22 : 40, 16]); // 날짜 범위가 들어가는 라벨·머리글이 잘리지 않게
  return ws;
}

/* ---------------- 시트 2: 누락 건 상세 ---------------- */
const partText = (p, i) => `${i + 1}) ${p.date} ${p.payer || "입금처 없음"} 입금 ${won(p.net)}원 · 수수료 ${won(p.fee)}원 · ${SHORT_MODE[p.mode] ?? p.mode}`;
const candText = (c, i) => {
  const tags = [];
  if (c.amountHit) tags.push("금액 ±5% 이내");
  if (c.dateHit) tags.push(c.dueGap === 0 ? "기한 당일" : `기한 앞뒤 ${c.dueGap}일`);
  if (!c.sameMethod) tags.push(`다른 결제수단: ${mlabel(c.method)}`);
  return `${i + 1}) ${c.date} ${c.payer || "입금처 없음"} · 입금 ${won(c.net)}원 + 수수료 ${won(c.fee ?? 0)}원 (${tags.join(", ")})`;
};
const modeSummary = (parts) => (parts.length ? [...new Set(parts.map((p) => MODE_KO[p.mode] ?? p.mode))].join(" + ") : "배정된 입금 없음");

function detailSheet(X, ctx, details) {
  const sh = sheetOf(X);
  sh.set(0, 0, S(titleOf(ctx, SHEET_NAMES.detail, DIFF_NOTE)));
  const head = ["매출일", "결제수단", "매출액(원)", daysHead(ctx), "입금 기한", "기한 경과일", "배정된 입금액(순)(원)", "수수료(원)", "입금+수수료(원)", "차이(원)", "원인 추정", "배정 방식", "배정된 입금 내역", "후보 입금(아직 짝 없는 입금)", "처리 상태", "확인 메모"];
  sh.row(1, head.map(S));
  const R0 = 2, n = details.length;
  details.forEach((d, i) => {
    const r = R0 + i, x = r + 1;
    sh.row(r, [D(d.date), S(mlabel(d.method)), N(d.amount), N(d.days, daysFmt(ctx)), D(d.due), N(d.lateDays, "0"), N(d.net), N(d.fee),
      F(`G${x}+H${x}`, d.net + d.fee), F(`C${x}-I${x}`, d.amount - (d.net + d.fee)),
      S(d.cause?.text ?? ""), S(modeSummary(d.parts)), S(d.parts.length ? d.parts.map(partText).join(" / ") : "배정된 입금 없음"),
      S(d.candidates.length ? d.candidates.map(candText).join(" / ") : "후보 없음"), S(d.statusText), S(d.memo)]);
  });
  if (!n) sh.set(R0, 0, S("기한이 지났는데 안 맞는 건(누락 의심·초과 입금)이 없어요"));
  const last = R0 + Math.max(n, 1), a = R0 + 1, b = last; // SUM 범위(건이 없으면 빈 줄 1칸)
  const tot = (c, f) => F(`SUM(${c}${a}:${c}${b})`, sum(details, f));
  sh.row(last, [S("합계"), S(`${n}건`), tot("C", (d) => d.amount), null, null, null, tot("G", (d) => d.net), tot("H", (d) => d.fee), tot("I", (d) => d.net + d.fee), tot("J", (d) => d.amount - (d.net + d.fee))]);
  const ws = sh.done();
  ws["!cols"] = widths([12, 12, 14, isBiz(ctx) ? 18 : 10, 12, 12, 20, 12, 16, 14, 22, 30, 80, 100, 16, 30]);
  if (n) ws["!autofilter"] = { ref: `A2:P${R0 + n}` };
  ws["!freeze"] = { xSplit: 2, ySplit: 2 }; // 제목·머리글 줄, 매출일·결제수단 열 고정(SheetJS 무료판은 못 써서 buildXlsxBytes 가 넣는다)
  return ws;
}

/* ---------------- 시트 3: 일별 전체 대조 ---------------- */
const dailyMode = (parts) => (parts.length ? [...new Set(parts.map((p) => SHORT_MODE[p.mode] ?? p.mode))].join(" + ") : "없음");

function dailySheet(X, ctx) {
  const sh = sheetOf(X);
  const rows = (ctx.res.rows ?? []).slice().sort((a, b) => a.date.localeCompare(b.date) || methodOrder(a.method) - methodOrder(b.method));
  sh.set(0, 0, S(titleOf(ctx, SHEET_NAMES.daily, DIFF_NOTE)));
  const head = ["매출일", "결제수단", "매출액(원)", "입금 기한", "구분", "상태", "배정 입금액(순)(원)", "수수료(원)", "입금+수수료(원)", "차이(원)", "배정 방식"];
  sh.row(1, head.map(S));
  const R0 = 2, n = rows.length;
  rows.forEach((w, i) => {
    const r = R0 + i, x = r + 1;
    sh.row(r, [D(w.date), S(mlabel(w.method)), N(w.amount), D(w.due), S(w.confirmed ? "완료 확정" : "입금 대기"), S(STATE_KO[w.state] ?? w.state),
      N(w.net), N(w.fee), F(`G${x}+H${x}`, w.net + w.fee), F(`C${x}-I${x}`, w.amount - (w.net + w.fee)), S(dailyMode(w.parts))]);
  });
  if (!n) sh.set(R0, 0, S("분석 기간에 매출이 없어요"));
  const last = R0 + Math.max(n, 1), a = R0 + 1, b = last;
  // 합계는 SUBTOTAL(9) — 필터를 걸면 보이는 행만 더한다(필터가 없으면 SUM 과 같다)
  const tot = (c, f) => F(`SUBTOTAL(9,${c}${a}:${c}${b})`, sum(rows, f));
  sh.row(last, [S("합계"), S(`${n}건`), tot("C", (w) => w.amount), null, null, null, tot("G", (w) => w.net), tot("H", (w) => w.fee), tot("I", (w) => w.net + w.fee), tot("J", (w) => w.amount - (w.net + w.fee)), S("필터를 걸면 보이는 행만 더해요")]);
  const ws = sh.done();
  ws["!cols"] = widths([12, 12, 14, 12, 12, 14, 20, 12, 16, 14, 30]);
  if (n) ws["!autofilter"] = { ref: `A2:K${R0 + n}` };
  ws["!freeze"] = { xSplit: 0, ySplit: 2 };
  return ws;
}

/* ---------------- 시트 4: 짝 없는 입금 ---------------- */
const UNMATCHED_NOTE = "표시: 일부 사용 = 일부는 다른 매출에 배정되고 남은 몫 · 직접 연결 = 사람이 눌러 매출에 연결한 입금";
/** 짝 없는 입금 한 건의 '표시' 칸 글자(해당 없으면 null) */
const markOf = (d) => [d.used ? "일부 사용" : "", d.linked ? "직접 연결" : ""].filter(Boolean).join(" · ") || null;
/** ctx.linked(사람이 눌러 연결한 입금) 정리 — 배열이 아니거나 빈 칸투성이 항목은 버린다 */
const linkedOf = (ctx) => (Array.isArray(ctx.linked) ? ctx.linked : []).filter((x) => x && typeof x === "object")
  .map((x) => ({ ...x, netV: Math.round(Number(x.net) || 0), feeV: Math.round(Number(x.fee) || 0) }))
  .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));

function unmatchedSheet(X, ctx) {
  const { res } = ctx, sh = sheetOf(X);
  const deps = (res.unmatchedDeposits ?? []).slice().sort((a, b) => a.date.localeCompare(b.date) || a.idx - b.idx);
  sh.set(0, 0, S(titleOf(ctx, SHEET_NAMES.unmatched, UNMATCHED_NOTE)));
  const head = ["입금일", "입금처", "결제수단", "입금액(순)(원)", "수수료(원)", "입금+수수료(원)", "연결 후보가 될 수 있는 누락 매출", "표시"];
  sh.row(1, head.map(S));
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
    sh.row(r, [D(d.date), S(d.payer || "입금처 없음"), S(mlabel(d.method)), N(net), N(fee), F(`D${x}+E${x}`, net + fee),
      S(ms.length ? ms.map((m) => `${m.date} ${mlabel(m.method)} (매출 ${won(m.amount)}원, 차이 ${won(m.diff)}원)`).join(" / ") : "없음"), markOf(d) ? S(markOf(d)) : null]);
  });
  if (!n) sh.set(R0, 0, S("짝 없는 입금이 없어요"));
  const last = R0 + Math.max(n, 1), a = R0 + 1, b = last;
  const tot = (c, f) => F(`SUM(${c}${a}:${c}${b})`, sum(deps, f));
  sh.row(last, [S("합계"), S(`${n}건`), null, tot("D", (d) => d.amount - (d.fee ?? 0)), tot("E", (d) => d.fee ?? 0), tot("F", (d) => d.amount)]);

  // 직접 연결한 입금 — ctx.linked 가 있을 때만 아래에 별도 구역을 만든다(없으면 그리지 않는다)
  const lk = linkedOf(ctx);
  if (lk.length) {
    let q = last + 2;
    sh.set(q++, 0, S("직접 연결한 입금 (사람이 눌러 매출에 연결한 입금 · 입금+수수료 = 입금액(순) + 수수료)"));
    sh.row(q++, ["입금일", "입금처", "입금액(순)(원)", "수수료(원)", "입금+수수료(원)", "연결한 매출일", "연결한 결제수단", "처리 상태", "확인 메모"].map(S));
    const q0 = q;
    lk.forEach((x, i) => {
      const y = q0 + i + 1;
      sh.row(q0 + i, [D(x.date), S(x.payer || "입금처 없음"), N(x.netV), N(x.feeV), F(`C${y}+D${y}`, x.netV + x.feeV), D(x.saleDate), S(mlabel(x.method ?? "")), S(x.statusText ?? ""), S(x.memo ?? "")]);
    });
    const qa = q0 + 1, qb = q0 + lk.length, lt = (c, f) => F(`SUM(${c}${qa}:${c}${qb})`, sum(lk, f));
    sh.row(q0 + lk.length, [S("합계"), S(`${lk.length}건`), lt("C", (x) => x.netV), lt("D", (x) => x.feeV), lt("E", (x) => x.netV + x.feeV)]);
  }
  const ws = sh.done();
  ws["!cols"] = widths([12, 34, 14, 18, 18, 18, 60, 22, 40]);
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
  wb.Props = { Title: (isDemoOf(ctx) ? DEMO_TEXT + " " : "") + "매출-입금 대조 내역서" };
  return wb;
}

/** '매출입금대조_YYYY-MM_기준일YYYYMMDD.xlsx', 가상 데이터면 앞에 '가상데이터_' */
export function exportFileName(ctx) {
  guard(ctx);
  const asOf = String(ctx.res.asOf ?? ctx.settings?.asOf ?? "").replace(/-/g, "");
  return `${isDemoOf(ctx) ? "가상데이터_" : ""}매출입금대조_${ctx.res.month ?? ctx.settings?.month ?? ""}_기준일${asOf}.xlsx`;
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
