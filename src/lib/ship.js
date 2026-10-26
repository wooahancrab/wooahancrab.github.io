// 송장 처리 — 채널 발주서 → 로젠 가져오기 파일 → (로젠에서 송장번호가 채워진 출력본) → 채널에 올릴 송장 파일.
// 순수 로직(화면·파일 입출력 없음). 시트는 2차원 배열, 열은 머리글 이름으로 찾는다.

const flat = (c) => String(c ?? "").replace(/\s/g, "");
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const str = (v) => (v == null ? "" : String(v).trim());

/**
 * 채널별 설정
 *  head: 이 머리글들이 모두 있는 줄이 표 머리글 / col: 읽을 열 이름(앞의 것이 우선) / out: 송장을 채울 열 / sheetOut: 올릴 시트 이름
 *  courier: 택배사 칸에 넣을 값(로젠택배) — 채널이 다른 이름을 요구하면 여기만 바꾼다
 */
export const CHANNELS = {
  smart: {
    label: "스마트스토어", head: ["상품주문번호", "수취인명"],
    col: { name: ["수취인명"], phone: ["수취인연락처1"], addr: ["통합배송지", "기본배송지"], qty: ["수량"], opt: ["옵션정보", "상품명"], msg: ["배송메세지"] },
    out: { method: "배송방법", courier: "택배사", track: "송장번호" }, methodValue: "택배,등기,소포", courier: "로젠택배",
    sheetOut: "발송처리", dropAbove: true,
    tip: "스마트스토어 발송처리: 판매자센터 → 엑셀 일괄발송에 올리세요 (시트 이름 '발송처리', 안내문 줄은 지워 둠).",
  },
  talk: {
    label: "톡딜", head: ["결제번호", "수령인명"],
    col: { name: ["수령인명"], phone: ["수령인연락처1", "하이픈포함 수령인연락처1"], addr: ["배송지주소"], qty: ["수량"], opt: ["옵션", "상품명"], msg: ["배송메세지"] },
    out: { courier: "택배사코드", track: "송장번호" }, courier: "로젠택배",
    tip: "톡딜 택배사코드 칸에 '로젠택배'를 넣었어요. 톡딜이 다른 코드를 요구하면 알려 주세요.",
  },
  dolsoe: {
    label: "돌쇠네", head: ["수령인명", "택배사**"],
    col: { name: ["수령인명"], phone: ["수령인연락처"], addr: ["주소"], qty: ["주문수량"], fee: ["공급사배송비"], opt: ["상품명"], msg: ["배송시요청사항"] },
    out: { courier: "택배사**", track: "배송번호" }, courier: "로젠",
    tip: "돌쇠네 송장 파일의 택배사(로젠)·배송번호 칸을 채웠어요.",
  },
  grip: {
    label: "착밀(Grip)", head: ["주문번호", "수령인"],
    col: { name: ["수령인"], buyer: ["구매자 이름"], phone: ["수령인 연락처"], addr: ["수령인 주소"], qty: ["수량"], opt: ["옵션", "상품명"], msg: ["배송 메시지"] },
    out: { courier: "택배사", track: "송장번호" }, courier: "로젠택배",
    tip: "착밀 발주서의 택배사·송장번호 칸을 채웠어요.",
  },
  wadiz: {
    label: "와디즈", head: ["받는사람 성명", "배송지 주소"],
    col: { name: ["받는사람 성명"], phone: ["받는사람 전화번호"], addr: ["배송지 주소"], qty: ["수량"], opt: ["리워드"], msg: ["배송시 요청사항"] },
    out: { track: "송장번호" }, courier: "로젠택배", appendTrack: true,
    tip: "와디즈는 파일 맨 끝에 '송장번호' 칸을 추가했어요. 와디즈 발송 양식에 맞게 옮겨야 하면 알려 주세요.",
  },
};

function findHeader(rows, head) {
  const need = head.map(flat);
  return rows.findIndex((r) => { const h = (r ?? []).map(flat); return need.every((n) => h.includes(n)); });
}
const colIdx = (headRow, names) => { const h = headRow.map(flat); for (const n of names ?? []) { const i = h.indexOf(flat(n)); if (i >= 0) return i; } return -1; };

/**
 * 발주서 읽기. sheets: 시트별 2차원 배열 — 채널 머리글이 있는 첫 시트를 쓴다.
 * 반환: { rows, headRow, hi, orders:[{i, name, phone, addr, qty, fee, opt, msg, buyer}] }  (i = rows 안의 줄 번호)
 */
export function parseOrders(channel, sheets) {
  const ch = CHANNELS[channel];
  for (const rows of sheets) {
    const hi = findHeader(rows, ch.head);
    if (hi < 0) continue;
    const headRow = rows[hi], ix = {};
    for (const [k, names] of Object.entries(ch.col)) ix[k] = colIdx(headRow, names);
    if (ix.name < 0 || ix.addr < 0) continue;
    const orders = [];
    rows.slice(hi + 1).forEach((r, k) => {
      const name = str(r[ix.name]); if (!name) return;
      orders.push({
        i: hi + 1 + k, name, phone: ix.phone >= 0 ? str(r[ix.phone]) : "", addr: str(r[ix.addr]),
        qty: ix.qty >= 0 ? (Number(r[ix.qty]) || str(r[ix.qty])) : "", fee: ix.fee >= 0 ? r[ix.fee] : "",
        opt: ix.opt >= 0 ? str(r[ix.opt]) : "", msg: ix.msg >= 0 ? str(r[ix.msg]) : "", buyer: ix.buyer >= 0 ? str(r[ix.buyer]) : "",
      });
    });
    if (!orders.length) throw new Error(`${ch.label} 발주서에 주문이 한 건도 없어요`);
    return { rows, headRow, hi, orders };
  }
  throw new Error(`${ch.label} 발주서 형식이 아니에요. 머리글에 ${ch.head.map((h) => `'${h}'`).join("·")}이(가) 있는 파일을 올려 주세요`);
}

/** 로젠 가져오기 파일(2차원 배열): A 받는분, B 구매자, C 주소, D, E 연락처, F 수량, G 배송비, H 송장번호(비움), I 상품/옵션, J 요청사항 */
export function logenRows(orders) {
  const head = ["수령인명", "구매자", "배송지주소", "", "수령인연락처", "수량", "배송비", "송장번호", "옵션", "배송메세지"];
  return [head, ...orders.map((o) => [o.name, o.buyer, o.addr, "", o.phone, o.qty, o.fee ?? "", "", o.opt, o.msg])];
}

/**
 * 로젠에서 송장번호가 채워져 돌아온 파일을 읽는다. 받는분·연락처·송장번호를 뽑는다.
 * 송장번호 열: 머리글에 '송장'이 있으면 그 열, 없으면 로젠 양식대로 H열(8번째).
 */
export function parseLogenReturn(sheets) {
  for (const rows of sheets) {
    const hi = rows.findIndex((r) => (r ?? []).some((c) => /수령인|수취인|받는사람|받는분/.test(flat(c))));
    if (hi < 0) continue;
    const head = rows[hi].map(flat);
    const iName = head.findIndex((c) => /수령인|수취인|받는사람|받는분/.test(c) && !/연락|전화/.test(c));
    const iPhone = head.findIndex((c) => /연락처|전화/.test(c));
    let iTrack = head.findIndex((c) => /송장|운송장/.test(c) && !/출력/.test(c)); if (iTrack < 0) iTrack = 7;
    const list = [];
    for (const r of rows.slice(hi + 1)) {
      const name = str(r[iName]), track = digits(r[iTrack]);
      if (name && track.length >= 8) list.push({ name, phone: digits(r[iPhone]), track });
    }
    if (list.length) return list;
  }
  throw new Error("송장번호가 채워진 줄을 못 찾았어요. 로젠에서 송장번호가 들어간 출력본인지 확인해 주세요 (H열에 송장번호)");
}

/** 주문 ↔ 송장 맞추기: 받는분+연락처로, 같은 사람이 여러 건이면 순서대로 */
export function matchTracking(orders, returned) {
  const pool = new Map();
  for (const r of returned) { const k = r.name + "|" + r.phone; (pool.get(k) ?? pool.set(k, []).get(k)).push(r.track); }
  const byName = new Map();
  for (const r of returned) (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)).push(r);
  const done = [], missing = [];
  for (const o of orders) {
    const k = o.name + "|" + digits(o.phone);
    let t = pool.get(k)?.shift();
    if (!t) { // 연락처 형식이 달라 못 맞춘 경우: 이름이 하나뿐이면 그걸로
      const c = byName.get(o.name)?.filter((x) => !x.used);
      if (c?.length === 1) { t = c[0].track; c[0].used = true; }
    }
    (t ? done : missing).push({ ...o, track: t });
  }
  const used = new Set(done.map((d) => d.track));
  const extra = returned.filter((r) => !used.has(r.track));
  return { done, missing, extra };
}

/** 채널에 올릴 송장 파일(2차원 배열): 원본 발주서에 택배사·송장번호를 채운다. 반환 {name, rows} */
export function fillTracking(channel, parsed, matched) {
  const ch = CHANNELS[channel];
  let rows = parsed.rows.map((r) => [...r]);
  const head = parsed.headRow.map(flat);
  const find = (n) => head.indexOf(flat(n));
  let iTrack = ch.out.track ? find(ch.out.track) : -1;
  if (ch.appendTrack && iTrack < 0) { iTrack = parsed.headRow.length; rows[parsed.hi][iTrack] = "송장번호"; }
  if (iTrack < 0) throw new Error(`발주서에 '${ch.out.track}' 칸이 없어요`);
  const iCour = ch.out.courier ? find(ch.out.courier) : -1, iMethod = ch.out.method ? find(ch.out.method) : -1;
  for (const m of matched) {
    const r = rows[m.i]; if (!r) continue;
    r[iTrack] = m.track;
    if (iCour >= 0) r[iCour] = ch.courier;
    if (iMethod >= 0) r[iMethod] = ch.methodValue;
  }
  if (ch.dropAbove) rows = rows.slice(parsed.hi); // 스마트스토어: 머리글 위 안내문 줄은 올릴 때 지운다
  return { name: ch.sheetOut ?? "Sheet1", rows };
}

/** 오늘 보낼 물량 요약: 옵션(상품)별 수량 */
export function summarize(orders) {
  const m = new Map();
  for (const o of orders) m.set(o.opt || "(옵션 없음)", (m.get(o.opt || "(옵션 없음)") ?? 0) + (Number(o.qty) || 1));
  return [...m].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
}
