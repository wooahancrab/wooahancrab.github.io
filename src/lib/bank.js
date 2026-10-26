// 통장 거래내역 읽기·분류 — 순수 로직(화면·DB 없음).
// 신협 "입출금거래내역" 엑셀 형식에 맞춤: 거래일자·거래시간·출금금액·입금금액·거래후잔액·거래종류·거래기록사항.
// 한 파일에 시트가 여러 개일 수 있고 같은 거래가 겹쳐 들어 있어서, 거래후잔액까지 넣은 키로 중복을 없앤다.
import { toDate } from "./settle.js";

const num = (v) => {
  if (typeof v === "number") return v;
  const t = String(v ?? "").replace(/[,원\s]/g, "");
  return t && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : 0;
};
const flat = (c) => String(c ?? "").replace(/\s/g, "");

const NAMES = {
  date: ["거래일자", "거래일", "거래일시", "일자", "날짜", "승인일시"],
  time: ["거래시간", "시간"],
  out: ["출금금액", "출금액", "출금", "찾으신금액", "출금(원)"],
  inn: ["입금금액", "입금액", "입금", "맡기신금액", "입금(원)"],
  bal: ["거래후잔액", "잔액", "거래후잔액(원)"],
  memo: ["거래기록사항", "적요", "거래내용", "내용", "기재내용", "보낸분받는분", "입금자", "의뢰인"],
  kind: ["거래종류", "거래구분", "구분"],
  note: ["메모"],
};

function findCols(head) {
  const col = {};
  for (const [k, names] of Object.entries(NAMES)) {
    let idx = -1;
    for (const n of names) { idx = head.indexOf(n); if (idx >= 0) break; }
    if (idx >= 0) col[k] = idx;
  }
  return col;
}

/**
 * sheets: 시트별 2차원 배열의 배열. 반환: { deposits:[{date,amount,memo,ref}], withdrawals:[{date,amount,memo,ref}], dup }
 * 헤더 위의 안내 문구(조회기간 등)는 건너뛰고 "거래일자"와 입금/출금 열이 있는 줄을 헤더로 본다.
 */
export function parseBankStatement(sheets) {
  const deposits = [], withdrawals = [], seen = new Set(), baseCount = new Map();
  let dup = 0, found = false;
  for (const rows of sheets) {
    const hi = rows.findIndex((r) => {
      const h = (r ?? []).map(flat);
      return NAMES.date.some((n) => h.includes(n)) && (NAMES.inn.some((n) => h.includes(n)) || NAMES.out.some((n) => h.includes(n)));
    });
    if (hi < 0) continue;
    const col = findCols(rows[hi].map(flat));
    if (col.date == null || (col.inn == null && col.out == null)) continue;
    found = true;
    for (const r of rows.slice(hi + 1)) {
      const date = toDate(r[col.date]); if (!date) continue;
      const inn = col.inn != null ? num(r[col.inn]) : 0, out = col.out != null ? num(r[col.out]) : 0;
      if (!(inn > 0 || out > 0)) continue;
      const time = col.time != null ? String(r[col.time] ?? "") : "";
      const bal = col.bal != null ? num(r[col.bal]) : "";
      const key = [date, time, out, inn, bal].join("|");
      if (time || bal !== "") { if (seen.has(key)) { dup++; continue; } seen.add(key); }
      const memo = [col.memo != null ? r[col.memo] : "", col.kind != null ? "" : "", col.note != null ? r[col.note] : ""].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
      // 시간·잔액이 없는 은행 파일은 같은 날 같은 금액·적요가 여러 건일 수 있어 순번을 붙인다
      let ref = key;
      if (!time && bal === "") { const b = `${date}|${out || inn}|${memo}`; const n = (baseCount.get(b) ?? 0) + 1; baseCount.set(b, n); ref = `${b}|${n}`; }
      (inn > 0 ? deposits : withdrawals).push({ date, amount: inn > 0 ? inn : out, memo, ref });
    }
  }
  if (!found) throw new Error("통장 거래내역 표를 못 찾았어요. 헤더에 '거래일자'와 '입금금액·출금금액'이 있는 표인지 확인해 주세요");
  if (!deposits.length && !withdrawals.length) throw new Error("거래 내역이 한 건도 없어요");
  return { deposits, withdrawals, dup };
}

/* ---------------- 입금 분류 ---------------- */
const CARD_RE = /^(삼성|신한|KB|NH|현대|현|롯데|하나|BC|비씨|B|국민|농협|우리|우)\s*[A-Za-z]?\d{4,}/;
const CARD_NAME = { 삼성: "삼성카드", 신한: "신한카드", KB: "국민카드", 국민: "국민카드", NH: "농협카드", 농협: "농협카드", 현대: "현대카드", 현: "현대카드", 롯데: "롯데카드", 하나: "하나카드", BC: "BC카드", 비씨: "BC카드", B: "BC카드", 우리: "우리카드", 우: "우리카드" };
const PLATFORM = [["네이버", "네이버"], ["카카오", "카카오"], ["쿠팡", "쿠팡"], ["배달의민족", "배달의민족"], ["우아한형제들", "배달의민족"], ["요기요", "요기요"], ["땡겨요", "땡겨요"], ["토스", "토스"], ["와디즈", "와디즈"], ["그립", "착밀(Grip)"], ["돌쇠", "돌쇠네"]];
const OWNER_NAMES = ["이홍근", "김형곤", "이한만", "이명근", "이경희"]; // 대표·가족 이체(매출 아님)

/** 입금 한 건 → { group: "카드"|"온라인정산"|"대표이체"|"이자·기타"|"기타 입금", name } */
export function classifyDeposit(memo) {
  const m = String(memo ?? "").trim();
  const c = CARD_RE.exec(m);
  if (c) return { group: "카드", name: CARD_NAME[c[1]] ?? c[1] };
  if (/^\d{6,}B$/.test(m)) return { group: "카드", name: "BC카드" }; // 가맹점번호+B 형태의 BC카드 정산
  if (/취소|환불|환입/.test(m)) return { group: "취소·환입", name: "취소·환입" };
  for (const [k, n] of PLATFORM) if (m.includes(k)) return { group: "온라인정산", name: n };
  if (OWNER_NAMES.some((n) => m.includes(n))) return { group: "대표이체", name: "대표·가족 이체" };
  if (/이자|캐시백|캐쉬백/.test(m)) return { group: "이자·기타", name: "이자·캐시백" };
  return { group: "기타 입금", name: m || "(적요 없음)" };
}

export function depositBreakdown(deps, month) {
  const groups = new Map();
  for (const d of deps) {
    if (!d.date.startsWith(month)) continue;
    const c = classifyDeposit(d.memo);
    const g = groups.get(c.group) ?? { group: c.group, total: 0, n: 0, items: new Map() };
    g.total += d.amount; g.n++;
    g.items.set(c.name, (g.items.get(c.name) ?? 0) + d.amount);
    groups.set(c.group, g);
  }
  const order = ["카드", "온라인정산", "기타 입금", "취소·환입", "대표이체", "이자·기타"];
  return [...groups.values()]
    .map((g) => ({ ...g, items: [...g.items].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total) }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/* ---------------- 지출 분류 ---------------- */
const SPEND_RULES = [
  ["세금·4대보험", /부가가치세|국고|국세|지방세|세금|건강보험|국민연금|고용보험|산재|원천|지방소득세/],
  ["임차료", /임차료|월세|임대|관리비/],
  ["공과금", /한국전력|전기료|도시가스|가스|수도|통신|인터넷|KT|SK|LG|유플러스/],
  ["식자재·매입", /푸드|수산|유통|마켓|농산|식자재|물산|상회|축산|청과|F&B|에프앤비|정육|물류|산업|식품|종합/],
  ["카드·수수료", /카드|수수료|결제|PG|페이/],
];
const PERSON_RE = /^[가-힣]{2,4}$|^[ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺA-Z\s]{4,}$/;

/** 출금 한 건 → 지출 분류 이름 */
export function classifySpend(memo) {
  const m = String(memo ?? "").trim();
  for (const [name, re] of SPEND_RULES) if (re.test(m)) return name;
  if (OWNER_NAMES.some((n) => m.includes(n))) return "대표·가족 이체";
  if (/^\d{8,}$/.test(m)) return "자동이체(번호)";
  if (PERSON_RE.test(m)) return "개인 이체(급여 등)";
  return "기타";
}

export function spendReport(wds, month) {
  const inMonth = wds.filter((w) => w.date.startsWith(month));
  const cats = new Map(), byDate = new Map();
  for (const w of inMonth) {
    const c = classifySpend(w.memo);
    const e = cats.get(c) ?? { name: c, total: 0, n: 0, items: new Map() };
    e.total += w.amount; e.n++;
    const who = String(w.memo ?? "").trim() || "(적요 없음)";
    e.items.set(who, (e.items.get(who) ?? 0) + w.amount);
    cats.set(c, e);
    byDate.set(w.date, (byDate.get(w.date) ?? 0) + w.amount);
  }
  return {
    total: inMonth.reduce((s, w) => s + w.amount, 0),
    cats: [...cats.values()].sort((a, b) => b.total - a.total).map((c) => ({ ...c, items: [...c.items].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total) })),
    daily: [...byDate].map(([date, amount]) => ({ date, amount })).sort((a, b) => b.date.localeCompare(a.date)),
  };
}
