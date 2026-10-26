import { dow, labelMD } from "./kst.js";

export const STORE_NAME = "본촌점";

// 요일별 기본 점검 주제 (일=0)
export const TOPICS = ["", "인사·첫 응대", "청결·위생", "반찬·리필 응대", "지난 클레임 사례", "주말 대비(웨이팅·회전)", "한 주 칭찬·정리"];

export const OPEN_ITEMS = [
  "테이블·수저 세팅",
  "반찬·리필 준비",
  "입구·웨이팅 공간",
  "불 켜기(카운터 쪽 스위치 전부)",
  "에어커튼 켜기",
  "천장 거미줄 제거",
];

export const TRASH = { done: "완료", noPickup: "수거 없는 날", skipped: "못 함" };

const blankAbsent = () => ({ name: "", note: "" });
const blankLate = () => ({ name: "", time: "" });
const blankClaim = () => ({ content: "", result: "" });
export { blankAbsent, blankLate, blankClaim };

export function defaultData(date) {
  return {
    att: { absent: null, absents: [blankAbsent()], late: null, lates: [blankLate()] },
    claim: { state: null, items: [blankClaim()] },
    request: "",
    chk: {
      reviewDone: false, topic: TOPICS[dow(date)],
      openDone: false, openMissing: [],
      yard: false, trash: null, closing: false,
    },
  };
}

// 저장된 보고(이전 형식 포함)를 현재 형식으로 맞춘다
export function normalize(raw, date) {
  const d = defaultData(date);
  if (!raw) return d;
  const a = raw.att || {};
  d.att.absent = a.absent ?? null;
  if (Array.isArray(a.absents) && a.absents.length) d.att.absents = a.absents.map((x) => ({ name: x.name || "", note: x.note || "" }));
  else if (a.absentNames) d.att.absents = [{ name: a.absentNames, note: "" }];
  d.att.late = a.late ?? null;
  if (Array.isArray(a.lates) && a.lates.length) d.att.lates = a.lates.map((x) => ({ name: x.name || "", time: x.time || "" }));
  const c = raw.claim || {};
  d.claim.state = c.state ?? null;
  if (Array.isArray(c.items) && c.items.length) d.claim.items = c.items.map((x) => ({ content: x.content || "", result: x.result || "" }));
  else if (c.content || c.result) d.claim.items = [{ content: c.content || "", result: c.result || "" }];
  d.request = typeof raw.request === "string" ? raw.request : "";
  d.chk = { ...d.chk, ...(raw.chk || {}) };
  d.chk.openMissing = Array.isArray(d.chk.openMissing) ? d.chk.openMissing : [];
  return d;
}

const filled = (list, key) => list.filter((x) => x[key].trim());
export const claimItems = (d) => (d.claim.state === "has" ? d.claim.items.filter((x) => x.content.trim() || x.result.trim()) : []);

export function summarize(d) {
  const reasons = [];
  if (!d.chk.reviewDone) reasons.push("조회");
  if (!d.chk.openDone) reasons.push("오픈 체크");
  if (d.chk.openMissing.length) reasons.push("오픈 빠진 항목");
  if (!d.chk.yard) reasons.push("마당 청소");
  if (d.chk.trash !== "done" && d.chk.trash !== "noPickup") reasons.push("쓰레기장 물청소");
  if (!d.chk.closing) reasons.push("마감 점검");
  return {
    has_claim: d.claim.state === "has",
    claim_count: d.claim.state === "has" ? Math.max(1, claimItems(d).length) : 0,
    incomplete: reasons.length > 0,
    late_count: d.att.late === "has" ? Math.max(1, filled(d.att.lates, "name").length) : 0,
    absent_count: d.att.absent === "has" ? Math.max(1, filled(d.att.absents, "name").length) : 0,
    reasons,
  };
}

// 제출 전 비어 있는 칸 목록
export function validate(d, date) {
  const m = [];
  const a = d.att, c = d.claim, k = d.chk;
  if (!a.absent) m.push("결원 여부 (없으면 '결원 없음')");
  else if (a.absent === "has" && !filled(a.absents, "name").length) m.push("결원자 이름");
  if (!a.late) m.push("지각 여부 (없으면 '지각 없음')");
  else if (a.late === "has") {
    const named = filled(a.lates, "name");
    if (!named.length) m.push("지각자 이름");
    else if (named.some((l) => !/^\d{2}:\d{2}$/.test(l.time))) m.push("지각자 출근시간");
  }
  if (!c.state) m.push("클레임·특이사항 (없으면 '없음')");
  else if (c.state === "has") {
    const items = claimItems(d);
    if (!items.length) m.push("클레임 내용");
    if (items.some((x) => !x.content.trim())) m.push("클레임 내용");
    if (items.some((x) => !x.result.trim())) m.push("클레임 처리 결과");
  }
  if (!k.reviewDone) m.push("조회 완료 체크");
  if (!k.topic.trim() && dow(date) !== 0) m.push("조회 주제");
  if (!k.openDone) m.push("오픈 체크 완료 체크");
  if (!k.yard) m.push("마당 청소 완료 체크");
  if (!k.trash) m.push("쓰레기장 물청소 (완료 / 수거 없는 날 / 못 함)");
  if (!k.closing) m.push("마감 점검 완료 체크");
  return [...new Set(m)];
}

export function attText(d) {
  const a = d.att;
  const parts = [];
  if (a.absent === "has") {
    const l = filled(a.absents, "name").map((x) => `${x.name.trim()}${x.note.trim() ? `(${x.note.trim()})` : ""}`).join(", ");
    parts.push(`결원 ${l || "있음"}`);
  } else parts.push(a.absent === "none" ? "결원 없음" : "결원 미입력");
  if (a.late === "has") {
    const l = filled(a.lates, "name").map((x) => `${x.name.trim()}${x.time ? " 출근 " + x.time : ""}`).join(", ");
    parts.push(`지각 ${l || "있음"}`);
  } else parts.push(a.late === "none" ? "지각 없음" : "지각 미입력");
  return parts.join(" / ");
}

// 클레임 한 건씩의 문장 목록
export function claimLines(d) {
  const c = d.claim;
  if (c.state === "none") return ["없음"];
  if (c.state !== "has") return ["미입력"];
  const items = claimItems(d);
  if (!items.length) return ["(내용 없음)"];
  return items.map((x) => `${x.content.trim() || "(내용 없음)"} → 처리: ${x.result.trim() || "(미입력)"}`);
}

export const claimText = (d) => claimLines(d).join("\n");

export function checkText(d) {
  const k = d.chk;
  const review = k.reviewDone ? `조회 완료${k.topic.trim() ? `(${k.topic.trim()})` : ""}` : "조회 미완료";
  const open = k.openDone ? "오픈 체크 완료" : "오픈 체크 미완료";
  const missing = k.openMissing.length ? ` (빠진 항목: ${k.openMissing.join(", ")})` : "";
  const yard = k.yard ? "마당 청소 완료" : "마당 청소 미완료";
  const trash = k.trash ? `쓰레기장 물청소 ${TRASH[k.trash]}` : "쓰레기장 물청소 미입력";
  const closing = k.closing ? "마감 점검 완료" : "마감 점검 미완료";
  return { review, open: open + missing, yardTrash: `${yard}·${trash}`, closing };
}

export function kakaoText(date, d) {
  const c = checkText(d);
  const lines = claimLines(d);
  const claim = lines.length > 1
    ? "\n" + lines.map((l, i) => `  ${i + 1}) ${l}`).join("\n")
    : " " + lines[0];
  const out = [
    `[${STORE_NAME} 일일보고] ${labelMD(date)}`,
    `1. 근태: ${attText(d)}`,
    `2. 클레임·특이사항:${claim}`,
    `3. 점검: ${c.review} / ${c.open} / ${c.yardTrash} / ${c.closing}`,
  ];
  if (d.request.trim()) out.push(`4. 요청사항: ${d.request.trim()}`);
  return out.join("\n");
}
