// 수금 대조 — 순수 로직(화면·DB 없음). 받을 돈(receivable)과 통장 입금(deposit)을 맞춰 본다.
// receivable: { id, source, counterparty, expected_date, amount, estimated, closed, ... }
// deposit:    { id, date, amount, memo }
import { addDays } from "./kst.js";

export const SOURCES = {
  naver: { label: "네이버 스토어", alias: ["네이버", "NAVER", "naver", "네이버페이"], grace: 3 },
  talkdeal: { label: "톡딜", alias: ["카카오", "KAKAO", "kakao", "톡딜", "카카오페이"], grace: 3 },
  coupang: { label: "쿠팡", alias: ["쿠팡", "COUPANG", "coupang"], grace: 3 },
  invoice: { label: "세금계산서", alias: [], grace: 5 },
  manual: { label: "직접 입력", alias: [], grace: 3 },
};

export const won = (n) => Math.round(n).toLocaleString("ko-KR") + "원";

export function daysBetween(a, b) { // b - a (YYYY-MM-DD)
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

const has = (memo, words) => words.some((w) => memo.toLowerCase().includes(w.toLowerCase()));

// 이 입금이 이 받을 돈의 거래처 것으로 보이는지(적요에 거래처명·플랫폼명이 있는가). 단서가 없으면 null.
function nameHit(r, d) {
  const memo = d.memo ?? "";
  const words = [...(SOURCES[r.source]?.alias ?? [])];
  if (r.counterparty) words.push(r.counterparty, ...(r.aliases ?? []));
  const key = words.filter(Boolean);
  if (!key.length) return null;
  return has(memo, key);
}

/**
 * 대조. opts: { today, windowBefore=3, windowAfter=45, tolerance=0 }
 * 반환: 받을 돈마다 { ...r, status, deposits:[], paid, diff, lateDays, overdueDays }
 * status: paid(입금확인) | paid_late | diff(금액 다름) | overdue(미입금) | waiting(예정일 전/유예) | closed(수동 종결)
 */
export function reconcile(receivables, deposits, opts = {}) {
  const today = opts.today;
  const before = opts.windowBefore ?? 3;
  const after = opts.windowAfter ?? 45;
  const used = new Set();
  const res = new Map(receivables.map((r) => [r.id, { ...r, deposits: [], paid: 0 }]));
  const inWin = (r, d) => d.date >= addDays(r.expected_date, -before) && d.date <= addDays(r.expected_date, after);
  const free = () => deposits.filter((d) => !used.has(d.id) && d.amount > 0);
  const order = receivables.filter((r) => !r.closed).slice().sort((a, b) => a.expected_date.localeCompare(b.expected_date));
  const take = (r, ds) => { const x = res.get(r.id); for (const d of ds) { used.add(d.id); x.deposits.push(d); x.paid += d.amount; } };
  const cmpHit = (r) => (a, b) => {
    const ha = nameHit(r, a) ? 0 : 1, hb = nameHit(r, b) ? 0 : 1;
    return ha - hb || Math.abs(daysBetween(r.expected_date, a.date)) - Math.abs(daysBetween(r.expected_date, b.date));
  };

  // 1) 금액이 정확히 같은 입금 (이름 단서가 맞는 것·예정일에 가까운 것 우선)
  const done = new Set();
  for (const r of order) {
    const pick = free().filter((d) => d.amount === r.amount && inWin(r, d)).sort(cmpHit(r))[0];
    if (pick) { take(r, [pick]); done.add(r.id); }
  }
  // 2) 같은 거래처의 받을 돈 여러 건을 한 번에 입금한 경우 (합계 일치, 최대 6건 연속)
  const byParty = new Map();
  for (const r of order) if (!done.has(r.id)) { const k = r.source + "|" + (r.counterparty ?? ""); (byParty.get(k) ?? byParty.set(k, []).get(k)).push(r); }
  for (const list of byParty.values()) {
    for (let i = 0; i < list.length; i++) {
      if (done.has(list[i].id)) continue;
      let sum = 0; const grp = [];
      for (let j = i; j < Math.min(list.length, i + 6); j++) {
        if (done.has(list[j].id)) break;
        sum += list[j].amount; grp.push(list[j]);
        if (grp.length < 2) continue;
        const d = free().filter((d) => d.amount === sum && grp.every((g) => inWin(g, d)) && nameHit(grp[0], d) !== false).sort(cmpHit(grp[0]))[0];
        if (d) { used.add(d.id); for (const g of grp) { const x = res.get(g.id); x.deposits.push({ ...d, shared: true }); x.paid += g.amount; done.add(g.id); } break; }
      }
    }
  }
  // 3) 금액이 조금 다른 입금 — 이름 단서가 맞고 허용오차(기본 10%) 안이면 '금액 다름'으로 잡아 둔다
  const tol = opts.tolerance ?? 0.1;
  for (const r of order) {
    if (done.has(r.id)) continue;
    const c = free().filter((d) => nameHit(r, d) === true && inWin(r, d) && Math.abs(d.amount - r.amount) <= r.amount * tol).sort(cmpHit(r))[0];
    if (c) { take(r, [c]); done.add(r.id); }
  }

  const out = [];
  for (const r of receivables) {
    const x = res.get(r.id);
    const last = x.deposits.map((d) => d.date).sort().at(-1);
    x.diff = x.deposits.length ? x.paid - r.amount : 0;
    if (r.closed) x.status = "closed";
    else if (x.deposits.length) {
      x.lateDays = Math.max(0, daysBetween(r.expected_date, last));
      x.status = x.diff !== 0 ? "diff" : x.lateDays > (SOURCES[r.source]?.grace ?? 3) ? "paid_late" : "paid";
    } else {
      x.overdueDays = today ? daysBetween(r.expected_date, today) : 0;
      const grace = SOURCES[r.source]?.grace ?? 3;
      x.status = x.overdueDays > grace ? "overdue" : "waiting";
    }
    out.push(x);
  }
  return { rows: out, unmatchedDeposits: deposits.filter((d) => d.amount > 0 && !used.has(d.id)) };
}

export function summarize(rows) {
  const s = { overdue: 0, overdueAmt: 0, diff: 0, diffAmt: 0, waiting: 0, waitingAmt: 0, paid: 0, paidAmt: 0 };
  for (const r of rows) {
    if (r.status === "overdue") { s.overdue++; s.overdueAmt += r.amount; }
    else if (r.status === "diff") { s.diff++; s.diffAmt += r.diff; }
    else if (r.status === "waiting") { s.waiting++; s.waitingAmt += r.amount; }
    else if (r.status === "paid" || r.status === "paid_late") { s.paid++; s.paidAmt += r.amount; }
  }
  return s;
}

/* ---------------- 엑셀 읽기 (표 → 레코드) ---------------- */
const norm = (v) => String(v ?? "").replace(/[\s \n\r_·()\[\]]/g, "").toLowerCase();
const num = (v) => {
  if (typeof v === "number") return v;
  const t = String(v ?? "").replace(/[,원\s]/g, "");
  return t && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
};
export function toDate(v) { // 엑셀 날짜(숫자/Date/문자열) → YYYY-MM-DD
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0");
  if (typeof v === "number" && v > 30000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000); return d.toISOString().slice(0, 10); }
  const m = String(v ?? "").match(/(\d{4})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

const COLS = {
  bank: {
    date: ["거래일시", "거래일자", "거래일", "일자", "날짜", "입금일", "승인일시"],
    deposit: ["입금액", "입금금액", "입금", "맡기신금액", "입금(원)", "받은금액", "입금액(원)"],
    memo: ["적요", "내용", "기재내용", "거래내용", "보낸분", "보낸분받는분", "입금자", "의뢰인", "거래기록사항", "송금인", "메모"],
    amount: ["거래금액", "금액"], kind: ["구분", "입출금구분", "거래구분"],
  },
  invoice: {
    date: ["작성일자", "발급일자", "작성일", "전송일자"],
    party: ["공급받는자상호", "공급받는자", "상호", "거래처", "공급받는자법인명"],
    total: ["합계금액", "합계", "총금액", "총액"],
    supply: ["공급가액"], tax: ["세액"], no: ["승인번호", "국세청승인번호"],
  },
  settle: {
    // 같은 표에 후보가 여러 개면 앞쪽 이름을 우선한다 (예: 톡딜 대금지급현황은 "최종정산금액"이 실제 입금액)
    date: ["정산예정일", "정산확정예정일", "입금예정일", "지급예정일", "송금예정일", "정산일", "정산기준일"],
    amount: ["최종정산금액", "정산예정금액", "정산금액", "입금예정금액", "정산예정액", "지급예정금액", "정산액", "실지급액", "판매정산금액"],
    done: ["정산완료일", "송금완료일"],
    order: ["상품주문번호", "주문번호"], party: ["스토어", "판매자", "채널"],
  },
};

function findHeader(rows, spec) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = (rows[i] ?? []).map(norm);
    const map = {}; let hit = 0;
    for (const [k, names] of Object.entries(spec)) {
      const want = names.map(norm);
      let idx = -1;
      for (const w of want) { idx = cells.indexOf(w); if (idx >= 0) break; } // 앞쪽 이름 우선
      if (idx < 0) idx = cells.findIndex((c) => c && want.some((w) => w.length > 1 && c.includes(w)));
      if (idx >= 0) { map[k] = idx; hit++; }
    }
    if (hit >= 2 && ("date" in map)) return { row: i, map, cells };
  }
  return null;
}

// 통장 거래내역 → [{date, amount(입금만), memo}]
export function parseBank(rows) {
  const hd = findHeader(rows, COLS.bank);
  if (!hd) throw new Error("입금 열을 못 찾았어요. 헤더에 '거래일자'와 '입금액'이 있는 표인지 확인해 주세요");
  const { map } = hd;
  const memoCols = hd.cells.map((c, i) => [c, i]).filter(([c]) => COLS.bank.memo.map(norm).some((w) => c && (c === w || c.includes(w)))).map(([, i]) => i);
  const out = [];
  for (const r of rows.slice(hd.row + 1)) {
    const date = toDate(r[map.date]); if (!date) continue;
    let amt = map.deposit != null ? num(r[map.deposit]) : NaN;
    if (!(amt > 0) && map.amount != null && map.kind != null && /입금/.test(String(r[map.kind]))) amt = num(r[map.amount]);
    if (!(amt > 0)) continue;
    out.push({ date, amount: amt, memo: memoCols.map((i) => String(r[i] ?? "").trim()).filter(Boolean).join(" ") });
  }
  if (!out.length) throw new Error("입금 내역이 한 건도 없어요");
  return out;
}

// 홈택스 세금계산서(매출) → 받을 돈. termDays: 작성일 + N일을 입금 예정일로 본다
export function parseInvoice(rows, termDays = 30) {
  const hd = findHeader(rows, COLS.invoice);
  if (!hd || hd.map.total == null && hd.map.supply == null) throw new Error("세금계산서 표가 아니에요. '작성일자'와 '합계금액' 열이 필요해요");
  const { map } = hd; const out = [];
  for (const r of rows.slice(hd.row + 1)) {
    const date = toDate(r[map.date]); if (!date) continue;
    let amt = map.total != null ? num(r[map.total]) : NaN;
    if (!(amt > 0) && map.supply != null) amt = num(r[map.supply]) + (map.tax != null ? num(r[map.tax]) || 0 : 0);
    if (!(amt > 0)) continue;
    const party = String(r[map.party] ?? "").trim();
    out.push({ source: "invoice", counterparty: party, expected_date: addDays(date, termDays), amount: amt, ref: map.no != null && r[map.no] ? "inv:" + r[map.no] : `inv:${date}:${party}:${amt}`, estimated: false, note: `계산서 ${date}` });
  }
  if (!out.length) throw new Error("세금계산서 내역이 없어요");
  return out;
}

// 네이버·톡딜 등 정산내역 → 정산예정일별 합계 1건씩
export function parseSettle(rows, source) {
  const hd = findHeader(rows, COLS.settle);
  if (!hd || hd.map.amount == null) throw new Error("정산 표가 아니에요. '정산예정일'과 '정산금액' 열이 필요해요");
  const { map } = hd; const by = new Map();
  // 건별 표(네이버 "정산예정금액", 톡딜 "판매정산금액")는 아직 확정 전이라 추정으로 본다.
  // 이미 정산 완료된 건은 일별 정산 표(정산금액)로 받는 게 정확해서(혜택 정산 등이 빠진 값) 네이버 건별 표에서는 뺀다.
  const perOrder = ["정산예정금액", "판매정산금액"].includes(hd.cells[map.amount]);
  const doneCol = hd.cells.findIndex((c) => COLS.settle.done.map(norm).includes(c));
  for (const r of rows.slice(hd.row + 1)) {
    const date = toDate(r[map.date]); const amt = num(r[map.amount]);
    if (!date || !(amt > 0)) continue;
    if (perOrder && doneCol >= 0 && String(r[doneCol] ?? "").trim() && source === "naver") continue;
    const x = by.get(date) ?? by.set(date, { n: 0, sum: 0 }).get(date);
    x.n++; x.sum += amt;
  }
  if (!by.size) throw new Error("정산할 내역이 없어요. 이미 정산 완료된 건만 있다면 일별 정산 표(정산확정금액)를 올려 주세요");
  return [...by].map(([date, x]) => ({ source, counterparty: SOURCES[source].label, expected_date: date, amount: x.sum, ref: `${source}:${date}`, estimated: perOrder, note: `${x.n}건 합계${perOrder ? " (추정)" : ""}` }));
}

// 돌쇠네 정산서(공급사 정산서) → 받을 돈 1건. 입금일 규칙이 파일에 없어서 입금 예정일은 기간 끝 + payDays 일로 둔다.
export function parseDolsoe(rows, payDays = 5) {
  let period = null, total = null;
  for (const r of rows) {
    const cells = r ?? [];
    for (let i = 0; i < cells.length; i++) {
      const t = norm(cells[i]);
      if (t === "정산기간" && !period) { const m = String(cells[i + 1] ?? "").match(/(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/); if (m) period = [m[1], m[2]]; }
      if (t === "총정산금액" && total == null) { for (let j = i + 1; j < cells.length; j++) { const n = num(cells[j]); if (n > 0) { total = n; break; } } }
    }
  }
  if (!period || !(total > 0)) throw new Error("돌쇠네 정산서가 아니에요. 정산기간과 총 정산금액이 있는 첫 시트가 필요해요");
  return [{ source: "manual", counterparty: "돌쇠", expected_date: addDays(period[1], payDays), amount: total, ref: `dolsoe:${period[0]}~${period[1]}`, estimated: false, note: `정산기간 ${period[0]} ~ ${period[1]}` }];
}

// 착밀(Grip) 정산 상세(구매확정 시트) → 정산일별 합계. 건별 실수령 = 상품금액 + 배송비 − (판매수수료·결제망 + 유입수수료 + 착밀수수료 + VAT).
// 실제 입금액과 다를 수 있어 추정으로 표시한다. 반품·수기조정 시트는 반영하지 않는다.
export function parseGrip(rows) {
  const hd = findHeader(rows, { date: ["정산일"], gross: ["최종상품금액"], ship: ["최종배송비"], fee1: ["기본판매수수료+결제망이용료", "기본판매수수료결제망이용료"], fee2: ["유입수수료"], fee3: ["착밀수수료"], vat: ["vat"] });
  if (!hd || hd.map.gross == null) throw new Error("착밀(Grip) 정산 상세 표가 아니에요. 정산일과 최종 상품금액 열이 필요해요");
  const { map } = hd; const by = new Map();
  const v = (r, k) => (map[k] == null ? 0 : num(r[map[k]]) || 0);
  for (const r of rows.slice(hd.row + 1)) {
    const date = toDate(r[map.date]); if (!date) continue;
    const net = v(r, "gross") + v(r, "ship") - v(r, "fee1") - v(r, "fee2") - v(r, "fee3") - v(r, "vat");
    const x = by.get(date) ?? by.set(date, { n: 0, sum: 0 }).get(date);
    x.n++; x.sum += net;
  }
  const out = [...by].filter(([, x]) => x.sum > 0).map(([date, x]) => ({ source: "manual", counterparty: "착밀(Grip)", expected_date: date, amount: Math.round(x.sum), ref: `grip:${date}`, estimated: true, note: `${x.n}건 합계 (수수료 계산 추정)` }));
  if (!out.length) throw new Error("정산 내역이 없어요");
  return out;
}

// 독촉 문구(복사용)
export function dunText(r) {
  const who = r.counterparty || SOURCES[r.source]?.label || "";
  return `안녕하세요, 우아한F&B입니다.\n${r.expected_date} 입금 예정이던 ${who} ${won(r.amount)} 건이 아직 확인되지 않습니다.\n확인 후 회신 부탁드립니다. 감사합니다.`;
}
