// 매출 보고 — 순수 계산(화면·DB 없음). 통장 입금(deposits)과 받을 돈(receivables)으로 월 누계·일별·정산 예정·거래처별을 만든다.
import { addDays } from "./kst.js";
import { SOURCES, reconcile, daysBetween } from "./settle.js";


const daysInMonth = (d) => { const [y, m] = d.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const sum = (a) => a.reduce((s, x) => s + x, 0);

/**
 * deps: [{date, amount, memo}], recv: 받을 돈 목록, today: YYYY-MM-DD
 * 입금은 매출과 시차가 있을 수 있어 "입금 기준"으로 보여준다.
 */
export function salesReport(deps, recv, today) {
  const month = today.slice(0, 7);
  const dim = daysInMonth(today);
  const elapsed = Number(today.slice(8)); // 오늘 포함 경과일
  const inMonth = deps.filter((d) => d.date.startsWith(month));
  const received = sum(inMonth.map((d) => d.amount));

  const perDay = elapsed > 0 ? received / elapsed : 0;
  const projected = Math.round(perDay * dim);

  // 일별 입금(이번 달, 최근 날짜 먼저)
  const byDate = new Map();
  for (const d of inMonth) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.amount);
  const daily = [...byDate].map(([date, amount]) => ({ date, amount })).sort((a, b) => b.date.localeCompare(a.date));

  // 받을 돈 상태(수금 대조와 같은 규칙)
  const rows = reconcile(recv, deps, { today }).rows;
  const label = (r) => r.counterparty || SOURCES[r.source]?.label || "기타";

  // 앞으로 14일 정산 예정(아직 입금 안 된 것만)
  const upcoming = rows
    .filter((r) => r.status === "waiting" && r.expected_date >= today && r.expected_date <= addDays(today, 14))
    .sort((a, b) => a.expected_date.localeCompare(b.expected_date))
    .map((r) => ({ date: r.expected_date, who: label(r), amount: r.amount, estimated: r.estimated }));

  // 거래처(플랫폼·외주 포함)별 받을 돈 현황
  const by = new Map();
  for (const r of rows) {
    if (r.status === "closed" || r.status === "paid" || r.status === "paid_late") continue;
    const k = label(r);
    const e = by.get(k) ?? { who: k, open: 0, overdue: 0, next: null, count: 0 };
    e.open += r.amount; e.count++;
    if (r.status === "overdue" || r.status === "diff") e.overdue += r.amount;
    if (!e.next || r.expected_date < e.next) e.next = r.expected_date;
    by.set(k, e);
  }
  const parties = [...by.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open);

  const lastDep = deps.map((d) => d.date).sort().at(-1) ?? null;
  return {
    month, dim, elapsed, received, projected,
    daily, upcoming, upcomingTotal: sum(upcoming.map((u) => u.amount)), parties,
    todayAmount: byDate.get(today) ?? 0, yesterdayAmount: byDate.get(addDays(today, -1)) ?? 0,
    lastDep, stale: !lastDep || daysBetween(lastDep, today) > 1,
  };
}
