// 홈택스 매입 (세금)계산서 ↔ 통장 출금 대조 — 순수 로직(화면·DB 없음).
// 홈택스 "전자(세금)계산서 목록조회" 엑셀: 작성일자·승인번호·공급자(사업자번호·상호·대표자명)·합계금액·품목명 …
// 같은 거래처의 계산서 여러 장을 한 번에 이체하기도 해서, 건별이 아니라 "거래처별 합계"로 맞춘다.
import { toDate } from "./settle.js";
import { matchRule, classifySpend } from "./bank.js";

const num = (v) => {
  if (typeof v === "number") return v;
  const t = String(v ?? "").replace(/[,원₩\s]/g, "");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : 0;
};
const flat = (c) => String(c ?? "").replace(/\s/g, "");
const OWNER_NAMES = ["이홍근", "김형곤", "이한만", "이명근", "이경희"];

/** 거래처 이름 비교용: 법인 표기·괄호·공백·기호 제거 */
export const nz = (s) => String(s ?? "").normalize("NFKC").replace(/주식회사|유한회사|\(주\)|\(유\)|\(사\)|㈜|[\s()[\]·.,&_\-/]/g, "").toLowerCase();

/**
 * sheets: 시트별 2차원 배열. 반환: [{date, no, supplier, rep, bizNo, amount, taxFree, item}]
 * 승인번호로 중복을 없앤다(분기 파일과 월 파일이 겹쳐 들어와도 한 번만).
 */
export function parseInvoices(sheets) {
  const out = [], seen = new Set();
  let found = false;
  for (const rows of sheets) {
    const hi = rows.findIndex((r) => { const h = (r ?? []).map(flat); return h.includes("작성일자") && h.includes("합계금액"); });
    if (hi < 0) continue;
    found = true;
    const head = rows[hi].map(flat);
    const ix = (n) => head.indexOf(n);
    const c = { date: ix("작성일자"), no: ix("승인번호"), biz: ix("공급자사업자등록번호"), sup: ix("상호"), rep: ix("대표자명"), amt: ix("합계금액"), cls: ix("전자세금계산서분류"), item: ix("품목명") };
    if (c.amt < 0 || c.sup < 0) continue;
    for (const r of rows.slice(hi + 1)) {
      const date = toDate(r[c.date]); if (!date) continue;
      const amount = num(r[c.amt]); if (!amount) continue;
      const no = String(r[c.no] ?? "").trim() || `${date}|${r[c.sup]}|${amount}`;
      if (seen.has(no)) continue; seen.add(no);
      out.push({
        date, no, amount,
        supplier: String(r[c.sup] ?? "").trim(), rep: String(r[c.rep] ?? "").replace(/\s*외\s*\d+\s*명/, "").trim(),
        bizNo: c.biz >= 0 ? String(r[c.biz] ?? "").trim() : "",
        taxFree: c.cls >= 0 ? !/세금/.test(String(r[c.cls])) : false,
        item: c.item >= 0 ? String(r[c.item] ?? "").trim() : "",
      });
    }
  }
  if (!found) throw new Error("계산서 목록 표를 못 찾았어요. 홈택스 '전자(세금)계산서 목록조회' 엑셀인지 확인해 주세요 ('작성일자'와 '합계금액' 열이 필요해요)");
  if (!out.length) throw new Error("계산서가 한 건도 없어요");
  return out;
}

/** 출금 적요가 이 거래처 것인가: 상호 또는 대표자 이름이 들어 있으면 일치. 점수가 높을수록 확실 */
function score(memoN, v) {
  if (!memoN) return 0;
  let s = 0;
  if (v.nameN.length >= 3 && memoN.includes(v.nameN)) s = Math.max(s, 100 + v.nameN.length);
  if (memoN.length >= 3 && v.nameN.includes(memoN)) s = Math.max(s, 60 + memoN.length);
  if (v.repN.length >= 2 && !OWNER_NAMES.includes(v.rep) && memoN.includes(v.repN)) s = Math.max(s, 50 + v.repN.length);
  return s;
}

/**
 * invoices: parseInvoices 결과, wds: 통장 출금 [{date, amount, memo, ref}], rules: 사용자 분류 규칙
 * 반환: { vendors, unmatched, totals }
 *  - vendors: 거래처별 {name, rep, invoiced, paid, owed, count, category, invoices, payments, status}
 *    status: "완납" | "미지급" | "일부" | "초과"
 *  - unmatched: 계산서 거래처로 확인되지 않은 출금을 적요별로 묶은 것 [{name, total, n, category}]
 */
export function reconcile(invoices, wds, rules = []) {
  const byKey = new Map();
  for (const v of invoices) {
    // 사업자번호가 있으면 그것으로, 없으면 상호로 거래처를 구분
    const key = v.bizNo || nz(v.supplier);
    const e = byKey.get(key) ?? { name: v.supplier, rep: v.rep, nameN: nz(v.supplier), repN: nz(v.rep), invoiced: 0, count: 0, paid: 0, invoices: [], payments: [], items: new Map() };
    e.invoiced += v.amount; e.count++; e.invoices.push(v);
    if (v.item) e.items.set(v.item, (e.items.get(v.item) ?? 0) + 1);
    byKey.set(key, e);
  }
  const vendors = [...byKey.values()];
  const un = new Map(), left = [];
  for (const w of wds) {
    const memoN = nz(w.memo);
    let best = null, bs = 0;
    for (const v of vendors) { const s = score(memoN, v); if (s > bs) { bs = s; best = v; } }
    if (best) { best.paid += w.amount; best.payments.push(w); continue; }
    left.push(w);
  }
  // 이름으로 못 찾은 출금(적요가 "임차료" 같은 용도만 적힌 경우): 아직 덜 낸 거래처의 계산서 금액과 정확히 같고 날짜가 맞으면 그 거래처로 본다
  const days = (a, b) => (new Date(b) - new Date(a)) / 864e5;
  const rest = [];
  for (const w of left) {
    let hit = null;
    for (const v of vendors) {
      if (v.invoiced - v.paid <= 1000) continue;
      const i = v.invoices.find((x) => !x.paidBy && x.amount === w.amount && days(x.date, w.date) >= -3 && days(x.date, w.date) <= 75);
      if (i) { hit = { v, i }; break; }
    }
    if (hit) { hit.i.paidBy = w; hit.v.paid += w.amount; hit.v.payments.push(w); } else rest.push(w);
  }
  for (const w of rest) {
    const name = String(w.memo ?? "").trim() || "(적요 없음)";
    const e = un.get(name) ?? { name, total: 0, n: 0, category: classifySpend(name, rules) };
    e.total += w.amount; e.n++; un.set(name, e);
  }
  for (const v of vendors) {
    const item = [...v.items].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const r = matchRule(v.name, rules) ?? matchRule(v.rep, rules);
    v.category = r ? r.category : (classifySpend(v.name + " " + item, rules).replace(/^(개인 이체\(급여 등\)|기타)$/, "매입(계산서)"));
    v.owed = v.invoiced - v.paid;
    v.status = v.paid === 0 ? "미지급" : Math.abs(v.owed) <= 1000 ? "완납" : v.owed > 0 ? "일부" : "초과";
  }
  vendors.sort((a, b) => b.invoiced - a.invoiced);
  const unmatched = [...un.values()].sort((a, b) => b.total - a.total);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  return {
    vendors, unmatched,
    totals: {
      invoiced: sum(vendors, (v) => v.invoiced), paid: sum(vendors, (v) => v.paid),
      owed: sum(vendors.filter((v) => v.owed > 1000), (v) => v.owed),
      unmatched: sum(unmatched, (u) => u.total),
    },
  };
}
