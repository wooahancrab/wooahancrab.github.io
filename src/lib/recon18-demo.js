// 매출-입금 대조 — 2026년 10월 가상 데이터(실제 자료 아님). 같은 코드는 같은 데이터를 만든다(난수 고정).
// 기준일 10/31, 분석 월 10월(분석 구간: 매출 9/13~, 입금 ~11/18). 자료는 8/20(현금·배달앱은 첫 주 묶음 입금이 있는 8/24)부터 기준일(10/31)까지 들어온 것만 —
// 분석 시작(9/13) 전 매출과 그 입금도 들어 있어서 전월 말 미수금이 따로 입력하는 이월 미수금 없이도 정확하다(자료 시작 전 매출은 없다고 본 가상 설정).
// 일부러 넣은 이상: ① 카드 10/6 입금이 없다(대신 10/22에 매출일을 10/7로 잘못 적은 입금이 따로 들어와 '후보'로 보임) ② 스마트스토어 10/3 입금 없음 (둘 다 입금에 매출일이 있어 날짜가 정확히 잡힘)
//   18일 규칙: 기준일 10/31 에서 10/14 이후 매출(입금 기한 11/1~11/18)은 아직 입금 기한 전이라 '입금 대기'가 정상이다(10/13 이전 매출은 완료 확정).
import { addDays, dow } from "./kst.js";

export const DEMO_AS_OF = "2026-10-31";
export const DEMO_MONTH = "2026-10";
const RAW_FROM = "2026-08-20";   // 자료 시작일. 이날 이후 매출만 만들고, 이날 전 매출의 입금은 만들지 않는다
export const DEMO_PLANTED = { missingCardDate: "2026-10-06", missingSmartDate: "2026-10-03" };

const BASE = { card: 5200000, cash: 600000, delivery: 2100000, smartstore: 3000000 };
const DOW_F = [1.25, 0.8, 0.85, 0.9, 0.95, 1.15, 1.35]; // 일~토
const FEE = { card: 0.025, smartstore: 0.0363 };

export function demoData() {
  let x = 20261031;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const rawSales = [];
  for (let d = RAW_FROM; d <= DEMO_AS_OF; d = addDays(d, 1)) {
    for (const m of Object.keys(BASE)) {
      const amount = Math.round(BASE[m] * DOW_F[dow(d)] * (0.88 + rnd() * 0.24) / 1000) * 1000;
      rawSales.push({ date: d, method: m, amount });
    }
  }
  const raw = [];
  const sale = (m, d) => rawSales.find((s) => s.method === m && s.date === d)?.amount ?? 0;
  // 카드: 매출일마다 3~11일 뒤 입금(수수료 2.5% 떼고, 수수료 칸 있음, 매출일 있음)
  let i = 0;
  for (const s of rawSales.filter((s) => s.method === "card")) {
    i++;
    if (s.date === DEMO_PLANTED.missingCardDate) continue;
    const dep = addDays(s.date, 3 + ((i * 7) % 9));
    if (dep > DEMO_AS_OF) continue;
    const fee = Math.round(s.amount * FEE.card);
    raw.push({ date: dep, payer: "카드 합산 입금(나이스정보통신)", amount: s.amount - fee, fee, saleDate: s.date, method: "card" });
  }
  // 카드사가 10/6 몫을 '10/7 매출'로 잘못 적어 10/22에 보낸 입금 — 10/7 은 이미 다 받았으므로 '짝 없는 입금'으로 남고, 10/6 누락 건의 후보 입금으로 보인다
  {
    const amt = sale("card", DEMO_PLANTED.missingCardDate), fee = Math.round(amt * FEE.card);
    raw.push({ date: "2026-10-22", payer: "카드 합산 입금(나이스정보통신)", amount: amt - fee, fee, saleDate: "2026-10-07", method: "card" });
  }
  // 스마트스토어: 매출일마다 5~9일 뒤 입금(수수료 3.63%, 매출일 있음)
  i = 0;
  for (const s of rawSales.filter((s) => s.method === "smartstore")) {
    i++;
    if (s.date === DEMO_PLANTED.missingSmartDate) continue;
    const dep = addDays(s.date, 5 + ((i * 3) % 5));
    if (dep > DEMO_AS_OF) continue;
    const fee = Math.round(s.amount * FEE.smartstore);
    raw.push({ date: dep, payer: "네이버페이 정산", amount: s.amount - fee, fee, saleDate: s.date, method: "smartstore" });
  }
  // 현금: 월요일마다 지난주(월~일) 현금 매출을 은행에 입금(수수료·매출일 없음)
  for (let d = RAW_FROM; d <= DEMO_AS_OF; d = addDays(d, 1)) {
    if (dow(d) !== 1 || addDays(d, -7) < RAW_FROM) continue; // 지난주 전체가 자료 안에 있을 때만
    let sum = 0;
    for (let k = 1; k <= 7; k++) sum += sale("cash", addDays(d, -k));
    if (sum > 0) raw.push({ date: d, payer: "현금 입금(시재)", amount: sum, fee: null, saleDate: null, method: "cash" });
  }
  // 배달앱: 수요일마다 지난주(월~일) 배달 매출에서 수수료 12% 뗀 금액이 입금(수수료 칸·매출일 없음 → 계약 수수료율로 역산)
  for (let d = RAW_FROM; d <= DEMO_AS_OF; d = addDays(d, 1)) {
    if (dow(d) !== 3 || addDays(d, -9) < RAW_FROM) continue;
    let sum = 0;
    for (let k = 3; k <= 9; k++) sum += sale("delivery", addDays(d, -k)); // 수요일 기준 9~3일 전 = 지난주 월~일
    if (sum > 0) raw.push({ date: d, payer: "우아한형제들 배달정산", amount: Math.round(sum * 0.88), fee: null, saleDate: null, method: "delivery" });
  }
  // 현금·배달앱은 한 주 묶음으로 입금되므로 첫 묶음(8/24~)이 온전한 날부터만 자료에 둔다(앞의 몇 일은 입금이 자료에 없어 가짜 미수가 생긴다)
  const LUMP_START = addDays(RAW_FROM, (8 - dow(RAW_FROM)) % 7 || 7); // 자료 시작일 다음 월요일
  return {
    sales: rawSales.filter((s) => !((s.method === "cash" || s.method === "delivery") && s.date < LUMP_START)),
    deposits: raw.sort((a, b) => a.date.localeCompare(b.date)),
    settings: {
      asOf: DEMO_AS_OF, month: DEMO_MONTH, mode: "calendar", defaultDays: 18, holidays: [],
      days: { card: 18, cash: 18, delivery: 18, smartstore: 18, etc: 18 },
      contractFee: { card: 0.023, delivery: 0.12, smartstore: 0.0363 },
      opening: {}, // 이월 미수금: 분석 시작 전 자료가 들어 있어 따로 넣지 않는다
    },
  };
}
