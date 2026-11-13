// 매출-입금 대조(정산 18일 규칙; 열람은 대표·부대표·회장) — 순수 계산(화면·DB 없음). 금액은 모두 정수(원), 날짜는 'YYYY-MM-DD'.
//
// 규칙
//  1) 매출일 당일 ~ 최대 N일(기본 18일, 결제수단별 설정) 뒤에 입금된다. 입금 기한 = 매출일 + N일.
//  2) 기준일(asOf) 이전에 기한이 지난 매출(매출일 + N ≤ 기준일)은 입금이 끝났어야 한다 → '완료 확정 구간'.
//     예) 기준일 10/31, N=18 → 10/1~10/13 매출은 완료 확정, 10/14~10/31 매출은 11/1~11/18 입금 예정.
//  3) 이번 달 입금(순입금) = 전월 말 미수금 + 이번 달 매출 − 이번 달 말 미수금 − 수수료.
//     미수금(T) = 이월(opening) + 누적 매출(≤T) − 누적 (입금 + 수수료)(≤T).
//  4) 입금 배정: ①입금에 매출일이 있으면 그 매출에 먼저 채운다 ②나머지는 오래된 매출부터(FIFO) 채운다(매출일보다 이른 입금은 못 채움).
//     매출일 없는 입금은 날짜별 대응이 추정이다(est). 총액(결제수단별 합계) 대조는 정확하다.
//  5) 수수료: 입금에 수수료 칸이 있으면 그대로, 없으면 계약 수수료율로 역산(입금 ÷ (1−율)), 둘 다 없으면 0(차이에 수수료가 섞임).
import { addDays, dow } from "./kst.js";

export const METHODS = [
  ["card", "카드"], ["cash", "현금"], ["delivery", "배달앱"], ["smartstore", "스마트스토어"], ["etc", "기타"],
];
export const METHOD_LABEL = Object.fromEntries(METHODS);
export const DEFAULT_DAYS = 18;
// 열람 권한: 대표·부대표·회장. 서버(supabase/recon18.sql 의 can_view_finance)와 같아야 한다. 'chairman'은 회장 역할을 만들 때 이름을 맞춘다.
export const FINANCE_VIEW_ROLES = ["owner", "deputy", "chairman"];
export const canViewFinance = (role) => FINANCE_VIEW_ROLES.includes(role);
export const DEFAULT_TOL = 1000; // 이 금액 이하의 차이는 같은 금액으로 본다(원)

/* ---------------- 날짜 ---------------- */
export const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const isoOk = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
export const monthStart = (m) => m + "-01";
export const monthEnd = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
export const prevMonth = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7); };
export const nextMonth = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7); };

const isBusinessDay = (d, holidays) => { const w = dow(d); return w !== 0 && w !== 6 && !(holidays ?? []).includes(d); };
/** 입금 기한: calendar=달력 N일 뒤, business=주말·휴일 제외 N영업일 뒤(매출일이 휴일이어도 다음 영업일부터 셈) */
export function settleDate(date, days, mode = "calendar", holidays = []) {
  if (mode !== "business") return addDays(date, days);
  let d = date, left = days;
  while (left > 0) { d = addDays(d, 1); if (isBusinessDay(d, holidays)) left--; }
  return d;
}

/**
 * 분석 범위: 매출은 '입금 기한이 월 1일 이후인 가장 이른 매출일'부터(달력 18일이면 월 1일 − 18일), 입금은 '월말 매출의 입금 기한'까지(달력 18일이면 다음 달 18일).
 * 영업일 모드에서도 같은 방식으로 계산한다.
 */
export function periodOf(month, maxDays = DEFAULT_DAYS, mode = "calendar", holidays = []) {
  const mf = monthStart(month);
  let from = mf;
  for (let i = 0; i < 400 && settleDate(addDays(from, -1), maxDays, mode, holidays) >= mf; i++) from = addDays(from, -1);
  return { month, from, monthFrom: mf, monthTo: monthEnd(month), nextFrom: monthStart(nextMonth(month)), depositsTo: settleDate(monthEnd(month), maxDays, mode, holidays) };
}

/* ---------------- 입금처 → 결제수단 ---------------- */
const ALIAS = [
  ["smartstore", ["스마트스토어", "네이버페이", "네이버", "naver"]],
  ["delivery", ["배달의민족", "배민", "우아한형제들", "요기요", "쿠팡이츠", "땡겨요", "배달"]],
  ["card", ["카드", "나이스정보통신", "나이스", "nice", "kicc", "한국정보통신", "스마트로", "kcp", "토스페이먼츠", "다우데이타", "여신금융"]],
  ["cash", ["현금", "시재", "무통장"]],
];
export function inferMethod(text) {
  const t = String(text ?? "").toLowerCase().replace(/\s/g, "");
  if (!t) return null;
  for (const [m, words] of ALIAS) if (words.some((w) => t.includes(w.toLowerCase()))) return m;
  return null;
}

/* ---------------- 정규화 ---------------- */
function cleanSales(sales) {
  return (sales ?? []).filter((s) => s && isoOk(s.date) && Number.isFinite(s.amount) && s.amount > 0).map((s) => ({ date: s.date, method: METHOD_LABEL[s.method] ? s.method : "etc", amount: Math.round(s.amount) }));
}
function cleanDeps(deps) {
  return (deps ?? []).map((d, i) => ({ d, i })).filter(({ d }) => d && isoOk(d.date) && Number.isFinite(d.amount) && d.amount > 0).map(({ d, i }) => ({
    idx: i, date: d.date, payer: String(d.payer ?? ""), amount: Math.round(d.amount),
    saleDate: isoOk(d.saleDate) ? d.saleDate : null,
    fee: Number.isFinite(d.fee) && d.fee >= 0 ? Math.round(d.fee) : null,
    method: METHOD_LABEL[d.method] ? d.method : (inferMethod(d.payer) ?? "etc"),
    linked: d.linked === true, // 사람이 눌러서 매출에 연결한 입금(saleDate 를 지정한 것과 같게 처리)
  }));
}
const daysOf = (st, m) => { const v = st.days?.[m]; return Number.isFinite(v) && v >= 0 ? Math.round(v) : (st.defaultDays ?? DEFAULT_DAYS); };

/* ---------------- 배정 (결제수단 1개) ---------------- */
/**
 * cutoff: 이 날짜까지 들어온 입금만 쓴다. 반환: 매출일별 배정과 남은 입금.
 * item: { date, amount, remaining, net, fee, explicit(true면 매출일 지정 입금이 채운 몫 있음), est(true면 FIFO 추정 몫 있음) }
 */
function allocate(saleDays, opening, deps, rate, cutoff, from) {
  const items = [];
  if (opening > 0) items.push({ date: "0000-00-00", amount: opening, remaining: opening, net: 0, fee: 0, opening: true, explicit: false, est: false, parts: [] });
  for (const s of saleDays) items.push({ date: s.date, amount: s.amount, remaining: s.amount, net: 0, fee: 0, opening: false, explicit: false, est: false, parts: [] });
  const byDate = new Map(items.filter((x) => !x.opening).map((x) => [x.date, x]));
  const ds = deps.filter((d) => d.date <= cutoff).map((d) => {
    const feeKnown = d.fee != null;
    const fee = feeKnown ? d.fee : rate > 0 ? Math.round(d.amount / (1 - rate)) - d.amount : 0;
    return { ...d, fee, gross: d.amount + fee, left: d.amount + fee, leftFee: fee, feeSource: feeKnown ? "actual" : rate > 0 ? "contract" : "none" };
  });
  const give = (dep, item, take, est) => {
    const feePart = take === dep.left ? dep.leftFee : Math.max(0, Math.min(dep.leftFee, Math.round(dep.fee * take / dep.gross)));
    item.remaining -= take; item.net += take - feePart; item.fee += feePart;
    if (est) item.est = true; else item.explicit = true;
    // 이 매출에 배정된 입금의 내역(상세·내역서용). mode: explicit=매출일로 정확히 연결, manual=사람이 눌러 연결, fifo=오래된 매출부터 채운 추정
    item.parts.push({ idx: dep.idx, date: dep.date, payer: dep.payer, net: take - feePart, fee: feePart, mode: est ? "fifo" : dep.linked ? "manual" : "explicit", feeSource: dep.feeSource });
    dep.left -= take; dep.leftFee -= feePart;
  };
  // 같은 날 입금은 (매출일, 금액 큰 것, 입력 순서)로 정해 입력 행 순서와 상관없이 같은 결과가 나오게 한다
  const order = ds.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.saleDate ?? "").localeCompare(String(b.saleDate ?? "")) || b.amount - a.amount || a.idx - b.idx);
  // ① 매출일이 적힌 입금은 그 매출에 먼저 채운다(매출일이 입금일보다 늦으면 못 채움)
  for (const dep of order) {
    if (!dep.saleDate) continue;
    const it = byDate.get(dep.saleDate);
    if (it && it.remaining > 0 && dep.left > 0 && it.date <= dep.date) give(dep, it, Math.min(dep.left, it.remaining), false);
    // 매출일이 분석 시작 전으로 적혀 있고 자료에 그 매출이 없으면 이월(시작 전 미수) 몫을 먼저 채운다 — 매출일 없는 입금이 이월을 가로채지 못하게
    else if (!it && from && dep.saleDate < from && opening > 0 && items[0].opening && items[0].remaining > 0 && dep.left > 0) give(dep, items[0], Math.min(dep.left, items[0].remaining), false);
  }
  // ② 나머지는 오래된 매출부터(FIFO). 매출일이 적힌 입금은 구간 안 다른 매출을 채우지 않는다 — 이월(분석 시작 전 매출) 몫만 채우고 남으면 '짝 없는 입금'
  for (const dep of order) {
    if (dep.left <= 0) continue;
    for (const it of items) {
      if (dep.left <= 0) break;
      if (it.remaining <= 0 || it.date > dep.date) continue;
      if (dep.saleDate && !it.opening) continue;
      give(dep, it, Math.min(dep.left, it.remaining), true);
    }
  }
  return { items, deps: ds, leftover: ds.filter((d) => d.left > 0) };
}

/* ---------------- 누락 건 원인·후보 ---------------- */
export const FEE_OVERRUN_MAX = 0.10; // 실효 수수료율이 계약보다 이만큼(10%p)까지만 높으면 '수수료가 더 떼였다'고 본다. 그보다 크면 일부 누락
/** 기한이 지난 안 맞는 매출의 원인 추정: over=초과 입금 / none=입금 자체가 없음 / fee_high=수수료가 계약보다 많이 떼임(계약율 역산 입금일 때) / partial=일부만 들어옴 */
function causeOf(row, rate, tol) {
  if (row.diff < -tol) return { code: "over", amount: -row.diff };
  if (row.paid === 0) return { code: "none", amount: row.diff };
  const implied = 1 - row.net / row.amount;
  const derived = row.parts.length > 0 && row.parts.every((p) => p.feeSource === "contract");
  if (rate > 0 && derived && implied > rate + 0.0005 && implied - rate <= FEE_OVERRUN_MAX) return { code: "fee_high", amount: row.diff, impliedFee: implied, contract: rate };
  return { code: "partial", amount: row.diff, noFeeInfo: row.parts.some((p) => p.feeSource === "none") };
}
/**
 * 짝 없는 입금(analyze().unmatchedDeposits) 중 이 매출 것일 수 있는 후보. 사람이 눌러서 연결한다.
 * 조건: 매출일 이후에 들어왔고, (금액이 부족액·매출액·수수료 뺀 예상 입금액 중 하나와 ±5% 이내)이거나 (같은 결제수단이고 입금 기한 앞뒤 3일 안).
 */
export function candidatesFor(row, unmatched, opts = {}) {
  const pct = opts.pct ?? 0.05, win = opts.days ?? 3, rate = row.contract ?? 0;
  const targets = [row.diff, row.amount, ...(rate > 0 ? [Math.round(row.amount * (1 - rate))] : [])].filter((t) => t > 0);
  const out = [];
  for (const d of unmatched ?? []) {
    if (d.date < row.date) continue; // 매출보다 먼저 들어온 입금은 그 매출 것이 될 수 없다
    if (d.used || d.linked) continue; // 일부가 다른 매출에 쓰인 입금·이미 연결한 입금은 통째로 옮기면 다른 매출이 깨지므로 후보로 안 낸다
    const gap = targets.length ? Math.min(...targets.map((t) => Math.abs(d.amount - t) / t)) : Infinity;
    const amountHit = gap <= pct, dueGap = Math.abs(daysBetween(row.due, d.date)), dateHit = dueGap <= win, sameMethod = d.method === row.method;
    if (!(amountHit || (dateHit && sameMethod))) continue; // 다른 결제수단의 입금은 금액이 비슷할 때만
    out.push({ ...d, amountHit, dateHit, sameMethod, dueGap, score: (amountHit ? 2 : 0) + (dateHit ? 1 : 0) + (sameMethod ? 1 : 0), gap });
  }
  return out.sort((a, b) => Number(b.sameMethod) - Number(a.sameMethod) || b.score - a.score || a.gap - b.gap || a.dueGap - b.dueGap || a.idx - b.idx).slice(0, opts.max ?? 8); // 같은 결제수단 먼저
}

/* ---------------- 누락 건 상세(화면·인쇄·엑셀 공통) ---------------- */
export const CAUSE_KO = { none: "입금 자체가 없음", partial: "일부만 들어옴", fee_high: "수수료가 계약보다 많음", over: "초과 입금" };
export const MODE_KO = { explicit: "매출일로 정확히 연결", manual: "직접 연결(사람이 선택)", fifo: "오래된 매출부터 채운 추정" };
export const STATUS_KEYS = ["pre", "asking", "done"];
/** 처리 상태 이름. 가운데 상태는 결제수단에 맞춰 '카드사 문의 중' 등으로 보인다 */
export function statusLabel(status, method) {
  if (status === "done") return "확인 완료";
  if (status === "asking") return { card: "카드사 문의 중", delivery: "배달앱 문의 중", smartstore: "스마트스토어 문의 중" }[method] ?? "문의 중";
  return "확인 전";
}
export const noteKey = (row) => `${row.date}|${row.method}`;
/** 누락 점검표 한 건의 상세: 그날 매출·배정된 입금·차이와 원인·후보 입금·메모/처리 상태. notes = { 'YYYY-MM-DD|method': { status, memo } } */
export function buildDetail(row, res, notes = {}) {
  const n = notes[noteKey(row)] ?? {};
  const status = STATUS_KEYS.includes(n.status) ? n.status : "pre";
  return {
    key: noteKey(row), date: row.date, method: row.method, amount: row.amount, days: row.days, due: row.due,
    lateDays: Math.max(0, daysBetween(row.due, res.asOf)),
    state: row.state, diff: row.diff, paid: row.paid, net: row.net, fee: row.fee, contract: row.contract,
    cause: row.cause ? { ...row.cause, text: CAUSE_KO[row.cause.code] } : null,
    parts: row.parts.map((p) => ({ ...p, gross: p.net + p.fee, modeText: MODE_KO[p.mode] })),
    estimated: row.parts.some((p) => p.mode === "fifo"),
    candidates: candidatesFor(row, res.unmatchedDeposits).map((c) => ({ ...c, net: c.amount - (c.fee ?? 0) })),
    status, statusText: statusLabel(status, row.method), memo: String(n.memo ?? ""),
  };
}

/* ---------------- 분석 ---------------- */
/**
 * input: { sales:[{date,method,amount}], deposits:[{date,payer,amount,saleDate?,fee?,method?}] }
 * st: { asOf, month, days:{method:N}, defaultDays, mode, holidays, contractFee:{method:rate}, opening:{method:원}, tol }
 */
export function analyze(input, st) {
  const asOf = st.asOf, month = st.month, mode = st.mode ?? "calendar", holidays = st.holidays ?? [], tol = st.tol ?? DEFAULT_TOL;
  const allSales = cleanSales(input.sales), allDeps = cleanDeps(input.deposits);
  // 분석 범위는 설정(정산일수의 최댓값)으로 정한다 — 자료에 따라 범위가 달라지지 않게
  const maxDays = Math.max(DEFAULT_DAYS, st.defaultDays ?? 0, ...Object.values(st.days ?? {}).filter(Number.isFinite));
  const per = periodOf(month, maxDays, mode, holidays);
  // 원장(미수금 계산)에는 분석 시작 전 자료도 모두 쓴다: 시작 전 매출의 입금이 '짝 없는 입금'으로 남아 미수금을 깎지 않고, 전월 말 미수금이 정확해진다.
  // 화면에 보이는 행·누락 점검표·타임라인은 분석 구간(per.from ~)만이다.
  const sales = allSales.filter((s) => s.date <= per.monthTo && s.date <= asOf), deps = allDeps.filter((d) => d.date <= per.depositsTo);
  const methods = METHODS.map(([k]) => k).filter((k) => sales.some((s) => s.method === k) || deps.some((d) => d.method === k) || (st.opening?.[k] ?? 0) > 0);
  const T = asOf < per.monthTo ? asOf : per.monthTo;          // 이번 달 말(진행 중인 달이면 기준일)
  const prevEnd = addDays(per.monthFrom, -1) < asOf ? addDays(per.monthFrom, -1) : asOf; // 기준일이 전월 말보다 이르면 기준일
  const out = { asOf, month, mode, period: per, methods: [], rows: [], missing: [], days: [], feeRates: [], unmatchedDeposits: [], summary: null };
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

  const sm = { sales: 0, net: 0, fee: 0, arPrev: 0, arEnd: 0, nextExpected: 0, nextExpectedNet: 0, overdueAtEnd: 0, overduePre: 0, orphanPrev: 0, orphanEnd: 0, openingTotal: 0, openingAuto: 0 };
  for (const m of methods) {
    const N = daysOf(st, m), rate = st.contractFee?.[m] > 0 && st.contractFee[m] < 1 ? st.contractFee[m] : 0, userOpening = Math.max(0, Math.round(st.opening?.[m] ?? 0));
    const mSales = sales.filter((s) => s.method === m);
    const byDay = new Map();
    for (const s of mSales) byDay.set(s.date, (byDay.get(s.date) ?? 0) + s.amount);
    const saleDays = [...byDay].map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date));
    const mDeps = deps.filter((d) => d.method === m);
    // 이월 미수금: 대표가 넣었으면 그 값. 안 넣었으면, 매출일이 분석 시작 전으로 적혀 있는데 짝이 되는 매출이 자료에 없는 입금을 모아 자동으로 잡는다
    // (그 입금은 시작 전 매출이 전월 말에도 못 받은 돈이었다는 뜻이라 이월로 잡아야 '입금 = 전월 말 미수 + 매출 − 월말 미수 − 수수료'가 맞는다)
    let openingAuto = 0;
    {
      const saleDates = new Set(saleDays.map((s) => s.date));
      const probe = allocate(saleDays, userOpening, mDeps, rate, asOf, per.from);
      // 자료에 그 매출이 없는 입금만(있는데 초과 입금한 것은 짝 없는 입금으로 남긴다)
      openingAuto = sum(probe.leftover.filter((d) => d.saleDate && d.saleDate < per.from && !saleDates.has(d.saleDate)), (d) => d.left);
    }
    const opening = userOpening + openingAuto; // 직접 넣은 이월 + 자동 이월(직접 넣은 이월로 못 채운 시작 전 매출의 입금)
    const cut = (c) => allocate(saleDays, opening, mDeps, rate, c, per.from);

    // 기준일 시점
    const A = cut(asOf);
    for (const it of A.items) {
      if (it.opening) continue;
      const due = settleDate(it.date, N, mode, holidays);
      const confirmed = due <= asOf;
      const paid = it.net + it.fee;           // 매출을 채운 총액(입금 + 수수료)
      const diff = it.amount - paid;          // 양수=덜 들어옴, 음수=더 들어옴
      let state;
      if (confirmed) state = Math.abs(diff) <= tol ? "done" : diff > 0 ? "missing" : "over";
      else state = paid === 0 ? "waiting" : Math.abs(diff) <= tol ? "early" : "partial";
      if (it.date < per.from) continue; // 분석 시작 전 매출: 미수금 계산에만 쓰고 표에는 안 보인다(못 받은 돈은 아래 overduePre 로 알린다)
      const row = { date: it.date, method: m, amount: it.amount, due, confirmed, net: it.net, fee: it.fee, paid, diff, state, est: it.est, explicit: it.explicit, parts: it.parts, contract: rate || null, days: N };
      if (state === "missing" || state === "over") { row.cause = causeOf(row, rate, tol); out.missing.push(row); }
      out.rows.push(row);
    }
    // 짝 없는 입금: 기준일(월말)까지 들어왔고 다음 달 매출을 가리키지 않는 것만. used=일부가 다른 매출에 쓰인 입금의 남은 몫, linked=사람이 연결한 입금
    out.unmatchedDeposits.push(...A.leftover.filter((d) => d.date <= T && (!d.saleDate || d.saleDate <= per.monthTo)).map((d) => ({ date: d.date, payer: d.payer, method: m, amount: d.left, fee: d.leftFee, idx: d.idx, saleDate: d.saleDate, used: d.left < d.gross, linked: !!d.linked })));
    const confRows = out.rows.filter((r) => r.method === m && r.confirmed);
    const salesConf = sum(confRows, (r) => r.amount), netConf = sum(confRows, (r) => r.net), feeConf = sum(confRows, (r) => r.fee);
    // 수수료율 = (매출 − 입금) ÷ 매출, 완료 구간만. rateClean 은 누락·초과로 걸린 날을 뺀 값(누락이 섞여 부풀려지는 것을 가려 보려고)
    const cleanRows = confRows.filter((r) => r.state === "done");
    const salesClean = sum(cleanRows, (r) => r.amount), netClean = sum(cleanRows, (r) => r.net);
    const srcs = new Set(A.deps.map((d) => d.feeSource));
    out.feeRates.push({ method: m, derived: srcs.size === 1 && srcs.has("contract"), missingN: confRows.length - cleanRows.length, salesDone: salesConf, netDone: netConf, feeDone: feeConf, gap: salesConf - netConf, rate: salesConf > 0 ? (salesConf - netConf) / salesConf : null, rateClean: salesClean > 0 ? (salesClean - netClean) / salesClean : null, salesClean, netClean, contract: rate > 0 ? rate : null, excess: rate > 0 ? salesConf - netConf - Math.round(salesConf * rate) : null, excessClean: rate > 0 ? salesClean - netClean - Math.round(salesClean * rate) : null });

    // 월말 시점(전월 말·이번 달 말 미수금)
    const Tcut = cut(T), Pcut = cut(prevEnd);
    // 미수금 = 아직 못 받은 매출의 합(이월 포함). 짝 없는 입금(연결 안 된 입금)은 미수금에서 빼지 않고 따로 보여 준다 — 빼 버리면 미수금이 실제보다 작거나 음수로 보여서
    // (검산식에는 '짝 없는 입금 증가분'으로 들어간다: 입금 = 전월 말 미수 + 매출 − 월말 미수 − 수수료 + 짝 없는 입금 증가분)
    const arOf = (c, upto) => c.items.filter((x) => x.opening || x.date <= upto).reduce((s, x) => s + x.remaining, 0);
    const orphanOf = (c, upto) => c.leftover.filter((d) => d.date <= upto).reduce((s, d) => s + d.left, 0);
    const arPrev = arOf(Pcut, prevEnd), arEnd = arOf(Tcut, T), orphanPrev = orphanOf(Pcut, prevEnd);
    const inMonthDeps = Tcut.deps.filter((d) => d.date >= per.monthFrom && d.date <= T);
    const net = sum(inMonthDeps, (d) => d.amount), fee = sum(inMonthDeps, (d) => d.fee);
    const salesM = sum(mSales.filter((s) => s.date >= per.monthFrom && s.date <= T), (s) => s.amount);
    // 기준일(T) 시점에 못 받은 매출: 기한이 T 이하면 '기한 경과 미수', 기한이 T 뒤이고 월말 매출의 기한 안이면 '입금 예정'. 허용오차 이하 잔액은 0으로 본다
    const winTo = settleDate(per.monthTo, N, mode, holidays);
    let nextExpected = 0, nextExpectedNet = 0, overdueAtEnd = 0, overduePre = 0;
    for (const it of Tcut.items) {
      if (it.opening || it.remaining <= tol) continue;
      const due = settleDate(it.date, N, mode, holidays);
      if (due <= T) { overdueAtEnd += it.remaining; if (it.date < per.from) overduePre += it.remaining; }
      else if (due <= winTo) { nextExpected += it.remaining; nextExpectedNet += rate > 0 ? it.remaining - Math.round(it.remaining * rate) : it.remaining; }
    }
    const orphanEnd = orphanOf(Tcut, T); // 짝 없는 입금(입금+수수료): 미수금에는 반영하지 않은 입금
    out.methods.push({ method: m, days: N, contractFee: rate || null, opening, openingAuto, salesMonth: salesM, netMonth: net, feeMonth: fee, arPrev, arEnd, nextExpected, nextExpectedNet, overdueAtEnd, overduePre, orphanPrev, orphanEnd });
    sm.overduePre += overduePre; sm.orphanEnd += orphanEnd; sm.orphanPrev += orphanPrev; sm.openingTotal += opening; sm.openingAuto += openingAuto;
    sm.sales += salesM; sm.net += net; sm.fee += fee; sm.arPrev += arPrev; sm.arEnd += arEnd; sm.nextExpected += nextExpected; sm.nextExpectedNet += nextExpectedNet; sm.overdueAtEnd += overdueAtEnd;
  }

  // 일별 타임라인(매출일 기준, 결제수단 합쳐서). 나쁜 상태가 우선
  const rank = { missing: 5, over: 4, partial: 3, waiting: 2, early: 1, done: 0 };
  const dayMap = new Map();
  for (const r of out.rows) {
    const d = dayMap.get(r.date) ?? { date: r.date, sales: 0, paid: 0, state: "done", confirmed: true, bad: false, due: r.due, methods: [] };
    d.sales += r.amount; d.paid += r.paid; d.confirmed = d.confirmed && r.confirmed; if (r.due > d.due) d.due = r.due;
    if (r.state === "missing" || r.state === "over") d.bad = true; // 기한이 지난 결제수단 중 하나라도 안 맞으면 그날은 누락 의심(다른 수단이 대기라도 덮지 않는다)
    if (rank[r.state] > rank[d.state]) d.state = r.state;
    d.methods.push({ method: r.method, amount: r.amount, paid: r.paid, state: r.state });
    dayMap.set(r.date, d);
  }
  out.days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, band: d.bad ? "missing" : d.confirmed ? "done" : "pending", diff: d.sales - d.paid }));
  out.missing.sort((a, b) => a.date.localeCompare(b.date) || a.method.localeCompare(b.method));
  out.summary = { ...sm, T, prevEnd, orphanDelta: sm.orphanEnd - sm.orphanPrev, formulaOk: sm.net === sm.arPrev + sm.sales - sm.arEnd - sm.fee + (sm.orphanEnd - sm.orphanPrev) };
  // 경고: 짝 없는 입금이 남음(미수금에 반영 안 됨) / 짝 없는 입금이 미수금보다 큼 / 분석 시작 전 매출 중 못 받은 돈 / 이월을 자동으로 잡음
  out.warnings = [];
  const orphans = out.unmatchedDeposits;
  if (orphans.length) out.warnings.push({ code: "orphan", n: orphans.length, amount: sum(orphans, (d) => d.amount) });
  const over = out.methods.filter((x) => x.orphanEnd > x.arEnd);
  if (over.length) out.warnings.push({ code: "orphanBig", methods: over.map((x) => x.method), amount: sum(over, (x) => x.orphanEnd - x.arEnd) });
  if (sm.overduePre > 0) out.warnings.push({ code: "pre", amount: sm.overduePre });
  if (sm.openingAuto > 0) out.warnings.push({ code: "autoOpening", amount: sm.openingAuto, methods: out.methods.filter((x) => x.openingAuto > 0).map((x) => x.method) });
  return out;
}

/** 입금처에 단서가 있는 통장 입금만 결제수단별 입금으로 쓰고, 나머지는 따로 돌려준다(통장 업로드 자료 재사용) */
export function fromBankDeposits(deps) {
  const used = [], other = [];
  for (const d of deps ?? []) {
    const m = inferMethod(d.memo ?? d.payer);
    if (m) used.push({ date: d.date, payer: d.memo ?? d.payer ?? "", amount: d.amount, method: m, saleDate: null, fee: null });
    else other.push(d);
  }
  return { deposits: used, unclassified: other };
}

/* ---------------- 엑셀 읽기 ---------------- */
const norm = (v) => String(v ?? "").replace(/[\s \n\r_·()\[\]]/g, "").toLowerCase();
const numOf = (v) => { if (typeof v === "number") return v; const t = String(v ?? "").replace(/[,원\s]/g, ""); return t && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN; };
function dateOf(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null :  v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0");
  if (typeof v === "number" && v > 30000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  const m = String(v ?? "").match(/(\d{4})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}
function header(rows, spec, need) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = (rows[i] ?? []).map(norm), map = {};
    for (const [k, names] of Object.entries(spec)) {
      const want = names.map(norm);
      let idx = -1;
      for (const w of want) { idx = cells.indexOf(w); if (idx >= 0) break; }
      if (idx < 0) idx = cells.findIndex((c) => c && want.some((w) => w.length > 1 && c.includes(w)));
      if (idx >= 0) map[k] = idx;
    }
    if (need.every((k) => k in map)) return { row: i, map };
  }
  return null;
}
export function parseSalesRows(rows) {
  const hd = header(rows, { date: ["매출일", "매출일자", "일자", "날짜", "영업일"], method: ["결제수단", "결제구분", "수단", "구분", "결제방법"], amount: ["매출액", "매출금액", "금액", "합계", "승인금액"] }, ["date", "amount"]);
  if (!hd) throw new Error("매출 표가 아니에요. '일자(매출일)'와 '금액(매출액)' 열이 필요해요");
  const out = []; let dropped = 0;
  for (const r of rows.slice(hd.row + 1)) {
    const date = dateOf(r[hd.map.date]), amount = numOf(r[hd.map.amount]);
    const okAmt = Number.isFinite(amount) && amount !== 0;
    // 음수(취소·환불) 행도 읽는다 — 같은 날·같은 결제수단 합계에서 빠진다. 날짜나 금액 한쪽만 읽히는 행은 건수로 알린다(합계 줄 등)
    if (!date || !okAmt) { if (date || okAmt) dropped++; continue; }
    const raw = hd.map.method != null ? String(r[hd.map.method] ?? "") : "";
    out.push({ date, method: inferMethod(raw) ?? "etc", amount: Math.round(amount) });
  }
  if (!out.length) throw new Error("매출 내역이 한 건도 없어요");
  out.dropped = dropped;
  return out;
}
export function parseDepositRows(rows) {
  const hd = header(rows, { date: ["입금일", "입금일자", "거래일자", "일자", "날짜"], payer: ["입금처", "보낸분", "입금자", "적요", "내용", "거래처"], amount: ["입금액", "입금금액", "입금", "금액"], saleDate: ["매출일", "매출일자", "정산대상일"], fee: ["수수료", "수수료금액"], method: ["결제수단", "결제구분"] }, ["date", "amount"]);
  if (!hd) throw new Error("입금 표가 아니에요. '입금일'과 '입금액' 열이 필요해요");
  // 헤더가 '수수료율'·'%' 이면 금액이 아니라 비율이라 수수료 금액으로 읽지 않는다
  if (hd.map.fee != null && /율|%/.test(norm(rows[hd.row][hd.map.fee]))) delete hd.map.fee;
  const out = []; let dropped = 0;
  for (const r of rows.slice(hd.row + 1)) {
    const date = dateOf(r[hd.map.date]), amount = numOf(r[hd.map.amount]);
    if (!date || !(amount > 0)) { if (date || Number.isFinite(amount) && amount !== 0) dropped++; continue; }
    const payer = hd.map.payer != null ? String(r[hd.map.payer] ?? "").trim() : "";
    const fee = hd.map.fee != null ? numOf(r[hd.map.fee]) : NaN;
    out.push({ date, payer, amount: Math.round(amount), saleDate: hd.map.saleDate != null ? dateOf(r[hd.map.saleDate]) : null, fee: Number.isFinite(fee) && fee >= 0 ? Math.round(fee) : null, method: (hd.map.method != null ? inferMethod(String(r[hd.map.method] ?? "")) : null) ?? inferMethod(payer) });
  }
  if (!out.length) throw new Error("입금 내역이 한 건도 없어요");
  out.dropped = dropped;
  return out;
}

/* ---------------- 표시 ---------------- */
/** 만원 단위 표시. 1만원 미만의 차이는 원 단위 그대로(0으로 보이지 않게) */
export function fmtMan(n) {
  if (!Number.isFinite(n)) return "-";
  const a = Math.abs(n), sign = n < 0 ? "−" : "";
  if (a === 0) return "0원";
  if (a < 10000) return sign + a.toLocaleString("ko-KR") + "원";
  return sign + Math.round(a / 10000).toLocaleString("ko-KR") + "만원";
}
export const fmtPct = (r) => (r == null ? "-" : (r * 100).toFixed(1) + "%");
