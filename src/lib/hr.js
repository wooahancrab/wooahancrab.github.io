// 인사 현황(4단계) 순수 함수·상수. 설계: 기획/4단계_인사현황_설계.md (8.5·8.6절)
// 화면 코드·owner.js 를 불러오지 않는다(직원 화면의 hr-me.js 도 이 파일을 쓰므로 가볍게 둔다).
// 모듈 최상위에서 t() 를 부르지 않는다. 정규식에 lookbehind 를 쓰지 않는다(아이폰 사파리 16.3 이하).
// 급여·4대보험 값은 이 파일 어디에도 저장하지 않는다(순수 계산만).
import { t, tx } from "./i18n.js";

/* ---------- 역할: 두 곳 규칙 (서버 SQL 함수 한 곳 + 여기 한 곳. 항상 같게. tools/role-test.html 이 본다) ---------- */
// 인사 현황을 열람·수정하는 역할. 서버 supabase/hr.sql 의 hr_can_manage() 와 같게 둔다.
export const HR_ROLES = ["owner", "deputy", "chairman"];
// 부대표·회장 행(급여 등)까지 볼 수 있는 역할. 서버 hr_can_see_senior() 와 같게 둔다. 기본은 대표·회장만(부대표는 회장·부대표 행을 못 봄 — 대표가 정할 일, 설계 D1).
export const HR_SENIOR_ROLES = ["owner", "chairman"];
export const canManageHr = (role) => HR_ROLES.includes(role);
const HR_PLAIN_TARGETS = ["staff", "manager", "supervisor"]; // 관리자 3역할이 늘 볼 수 있는 대상
const HR_SENIOR_TARGETS = ["deputy", "chairman"]; // 이 둘의 행은 HR_SENIOR_ROLES 만 본다
/** 서버 hr_target_ok() 와 같은 대상 행 규칙(설계 3절). 대표(owner) 행과 모르는 역할은 누구에게도 대상이 아니다 */
export function canSeeHrTarget(viewerRole, targetRole) {
  if (!canManageHr(viewerRole)) return false;
  if (HR_PLAIN_TARGETS.includes(targetRole)) return true;
  if (HR_SENIOR_TARGETS.includes(targetRole)) return HR_SENIOR_ROLES.includes(viewerRole);
  return false;
}

/* ---------- 상수 ---------- */
export const HR_PERIODS = ["this_month", "last_month", "last_3_months"];
export const RATE_WARN_PCT = 80; // 출근율이 이 값 미만이고 고정 근무일 때만 "낮음" 배지(설계 D6)
export const HR_FILE_LIMIT = 5; // 직원당 근로계약서 파일 수(서버 hr_cf_guard 와 같게)
export const HR_FILE_MAX = 20 * 1024 * 1024; // 파일당 20MB(보관함 한도와 같게)
export const HR_FILE_EXT = ["jpg", "jpeg", "png", "webp", "heic", "heif", "pdf", "doc", "docx", "hwp", "hwpx"]; // 보관함 올리기 정책의 확장자 정규식과 같게
// 보관함 hr-contracts 가 받는 종류(supabase/hr.sql 2.7 의 allowed_mime_types 와 같게). 이 밖의 종류는 octet-stream 으로 올린다
export const HR_FILE_MIME = [
  "application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-hwp", "application/haansofthwp", "application/vnd.hancom.hwp", "application/vnd.hancom.hwpx", "application/hwp+zip",
  "application/octet-stream",
];
export const HR_PAY_MAX = { monthly: 100000000, hourly: 1000000 }; // 서버 hr_secret_pay_chk 와 같게
export const HR_PAY_SMALL = { monthly: 100000, hourly: 1000 }; // 이보다 작으면 원 단위 착오가 아닌지 한 번 더 묻는다(막지는 않는다)
export const HR_DATE_MIN = "2000-01-01", HR_DATE_MAX = "2100-12-31"; // 서버 날짜 제약과 같게
// 시험이 시간을 줄여 쓸 수 있게 한 곳에 둔다(기본값은 설계 7.2: 급여 보기는 30초 뒤 자동으로 다시 가린다)
export const HR_REVEAL_MS = 30000;
export const hrTune = { revealMs: HR_REVEAL_MS };

/* ---------- 날짜 ---------- */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 'YYYY-MM-DD' 가 실제 있는 날짜인가 */
export function isDateStr(s) {
  const m = DATE_RE.exec(String(s ?? ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const utcDay = (s) => { const m = DATE_RE.exec(s); return Date.UTC(+m[1], +m[2] - 1, +m[3]); };
/** 만료일까지 남은 일수(오늘이 만료 당일이면 0, 지났으면 음수). 둘 중 하나가 없거나 날짜가 아니면 null. today 는 서버가 준 KST 오늘 */
export function daysLeft(expiresOn, today) {
  if (!isDateStr(expiresOn) || !isDateStr(today)) return null;
  return Math.round((utcDay(expiresOn) - utcDay(today)) / 86400000);
}
/** 날짜 범위(2000-01-01 ~ 2100-12-31) 안인가 */
export const dateInRange = (s) => isDateStr(s) && s >= HR_DATE_MIN && s <= HR_DATE_MAX;

/* ---------- 보건증 ---------- */
/** h = { need, expires_on, days_left } → "expired" | "d7" | "d30" | "ok" | "unset" | "na" | "unknown" */
export function healthLevel(h) {
  const need = h && h.need;
  if (need === "no") return "na";
  if (need !== "yes") return "unknown";
  if (!h.expires_on) return "unset";
  const d = h.days_left;
  if (typeof d !== "number" || !Number.isFinite(d)) return "unknown";
  if (d < 0) return "expired";
  if (d <= 7) return "d7";
  if (d <= 30) return "d30";
  return "ok";
}
/** 보건증 배지: { text(한국어 키), params, cls, ctx? }. 색과 글자를 항상 함께 쓴다. 화면은 badgeText(b) 로 화면 언어 글을 얻는다 */
export function healthBadge(h) {
  const lv = healthLevel(h), n = h && h.days_left;
  if (lv === "expired") return { text: "만료 · {n}일 지남", params: { n: -n }, cls: "bad" };
  if (lv === "d7") return n === 0 ? { text: "오늘 만료", params: null, cls: "bad" } : { text: "D-{n} · {n}일 남음", params: { n }, cls: "bad" };
  if (lv === "d30") return { text: "D-{n} · 30일 이내", params: { n }, cls: "warn" };
  if (lv === "ok") return { text: "D-{n} · 정상", params: { n }, cls: "ok" };
  if (lv === "unset") return { text: "미등록 · 만료일을 입력해 주세요", params: null, cls: "warn" };
  if (lv === "na") return { ctx: "인사", text: "해당 없음", params: null, cls: "" };
  return { ctx: "인사", text: "미확인", params: null, cls: "" };
}
/** 배지 한 개의 화면 언어 글자 */
export const badgeText = (b) => (b.ctx ? tx(b.ctx, b.text, b.params) : t(b.text, b.params));

/* ---------- 근로계약서 있음 여부(설계 6절) ---------- */
/** state = hr_secret.contract_state("unknown"|"yes"|"no"), files = 파일 개수 → "files" | "yes" | "no" | "unknown" */
export function contractLevel(state, files) {
  if ((Number(files) || 0) > 0) return "files";
  if (state === "yes") return "yes";
  if (state === "no") return "no";
  return "unknown";
}
export function contractBadge(state, files) {
  const lv = contractLevel(state, files);
  if (lv === "files") return { text: "계약서 있음 {n}개", params: { n: Number(files) }, cls: "ok" };
  if (lv === "yes") return { text: "계약서 있음 · 파일 없음", params: null, cls: "ok" };
  if (lv === "no") return { text: "계약서 없음", params: null, cls: "warn" };
  return { text: "계약서 미확인", params: null, cls: "" };
}

/* ---------- 출근율 ---------- */
/** 80% 미만이고 고정 근무일 때만 "낮음". 자유 근무는 숫자만 보인다(정해진 근무 요일이 없어 같은 분모로 세면 늘 낮게 나오므로) */
export function rateBadge(att) {
  if (!att || typeof att.rate_pct !== "number") return null;
  if (att.rate_pct < RATE_WARN_PCT && att.work_type === "fixed") return { ctx: "인사", text: "낮음", cls: "warn" };
  return null;
}

/* ---------- 급여 입력 ---------- */
/** 2100000 → "2,100,000" (언어와 상관없이 같은 모양) */
export const fmtWon = (n) => (Number.isFinite(n) ? String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "");
/** "2,100,000" → 2100000. 숫자·콤마·공백만 받고 그 밖의 글자가 있거나 비었으면 null */
export function parseWon(s) {
  const v = String(s ?? "").replace(/[,\s]/g, "");
  return /^\d{1,12}$/.test(v) ? Number(v) : null;
}
/** 급여 유형·금액 검증: 문제가 없으면 null, 있으면 한국어 문구 키(화면이 t() 로 번역). amount 는 parseWon 의 결과(정수|null) */
export function payProblem(type, amount) {
  if (type !== "monthly" && type !== "hourly") return null;
  if (!Number.isInteger(amount)) return "급여 금액을 숫자로 입력해 주세요";
  if (amount < 1 || amount > HR_PAY_MAX[type]) return type === "monthly" ? "월급은 1원부터 1억 원까지 입력할 수 있어요" : "시급은 1원부터 100만 원까지 입력할 수 있어요";
  return null;
}
/** 월급 10만 원 미만·시급 1천 원 미만이면 true(원 단위 착오 의심) */
export const payTooSmall = (type, amount) => (type === "monthly" || type === "hourly") && Number.isInteger(amount) && amount < HR_PAY_SMALL[type];

/* ---------- 오류 (설계 8.6) ---------- */
// 서버가 준 글(error.message·details·hint)은 Postgres 가 실패한 행의 값(급여)을 담을 수 있어서 화면·토스트·콘솔 어디에도 쓰지 않는다. 아래 고정 문구만 쓴다
const MSG = {
  forbidden: "인사 정보를 볼 수 있는 권한이 없어요",
  not_ready: "인사 현황을 쓰려면 먼저 hr.sql 을 Run 해야 해요. 대표님께 알려 주세요",
  invalid_money: "금액을 확인해 주세요",
  invalid_date: "날짜를 확인해 주세요",
  too_many_files: "근로계약서는 직원당 5개까지 올릴 수 있어요",
  too_big: "{nm}: 20MB보다 커서 올릴 수 없어요 ({size}MB)",
  bad_type: "{nm}: 올릴 수 없는 파일 형식이에요 (pdf·사진·doc·docx·hwp·hwpx만 가능해요)",
  network: "서버에 연결하지 못했어요",
  unknown_read: "인사 정보를 불러오지 못했어요",
  unknown_write: "인사 정보를 저장하지 못했어요",
  unknown_open: "파일을 열지 못했어요",
};
/**
 * 인사 현황 오류. message 는 위 표의 한국어 문구 키이고, code 는 forbidden·not_ready·invalid·too_many_files·too_big·bad_type·network·unknown 중 하나.
 * opts: { kind: "money"|"date"(invalid 일 때), mode: "read"|"write"|"open"(unknown 일 때. open = 계약서 파일 열기), params, pg(서버 오류 코드만), key(문구 키를 직접 정함) }
 */
export function hrError(code, opts = {}) {
  const key = opts.key ?? (code === "invalid" ? (opts.kind === "date" ? MSG.invalid_date : MSG.invalid_money)
    : code === "unknown" ? (opts.mode === "write" ? MSG.unknown_write : opts.mode === "open" ? MSG.unknown_open : MSG.unknown_read) : MSG[code] ?? MSG.unknown_read);
  return Object.assign(new Error(key), { name: "HrError", code, params: opts.params ?? null, pg: opts.pg ?? "" });
}
/** 사용자에게 보일 문장(화면 언어). HrError 가 아니면(예: 예상 못 한 예외) 서버 글을 그대로 쓰지 않고 고정 문구를 쓴다 */
export function hrErrText(e) {
  if (e && e.name === "HrError") return t(e.message, e.params ?? undefined);
  return t(MSG.unknown_read);
}
/** 콘솔에는 코드만 남긴다(메시지·상세에는 급여 값이 들어 있을 수 있다) */
export function hrLog(e) {
  try { console.warn("[인사]", (e && (e.code || e.pg)) || "unknown"); } catch { /* 무시 */ }
}

/* ---------- 계약서 파일 ---------- */
export const extOfName = (name) => (String(name ?? "").match(/\.([A-Za-z0-9]{1,8})$/) || [])[1]?.toLowerCase() ?? "";
// 파일 이름을 화면용으로: 제어 문자·방향 문자를 지우고 30자(코드포인트)까지
export function shortFileName(s) {
  const a = Array.from(String(s ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ""));
  return a.length > 30 ? a.slice(0, 29).join("") + "…" : a.join("");
}
export const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB");
/** 올릴 수 없는 파일이면 그 이유의 HrError(bad_type·too_big·too_many_files·unknown), 올릴 수 있으면 null. countNow = 지금 이 직원의 파일 수 */
export function fileError(file, countNow) {
  const nm = shortFileName(file?.name);
  if (!HR_FILE_EXT.includes(extOfName(file?.name))) return hrError("bad_type", { params: { nm } });
  if (!(file.size >= 1)) return hrError("unknown", { mode: "write", key: "{nm}: 올리지 못했어요. 다시 시도해 주세요", params: { nm } });
  if (file.size > HR_FILE_MAX) return hrError("too_big", { params: { nm, size: (file.size / 1048576).toFixed(1) } });
  if ((Number(countNow) || 0) >= HR_FILE_LIMIT) return hrError("too_many_files");
  return null;
}
/** 올릴 수 있으면 null, 아니면 이유(화면 언어 문장) */
export function checkHrFile(file, countNow) {
  const e = fileError(file, countNow);
  return e ? hrErrText(e) : null;
}

/* ---------- 요약 칩(걸러 보기) 정의 — 설계 7.2. 칩 숫자는 걸러 보기와 상관없이 전체 기준 ---------- */
export const HR_FILTERS = ["soon", "expired", "no_contract", "ins_unknown", "unset"];
/** 한 직원이 그 칩의 조건에 맞는가 */
export function matchFilter(row, key) {
  const hl = row && row.health ? row.health : { need: "unknown" };
  if (key === "soon") return hl.need === "yes" && typeof hl.days_left === "number" && hl.days_left >= 0 && hl.days_left <= 30;
  if (key === "expired") return hl.need === "yes" && typeof hl.days_left === "number" && hl.days_left < 0;
  if (key === "unset") return hl.need === "yes" && !hl.expires_on;
  if (key === "no_contract") { const lv = contractLevel(row.contract_state, row.contracts); return lv === "no" || lv === "unknown"; }
  if (key === "ins_unknown") return !!row.ins && Object.values(row.ins).some((v) => v === "unknown");
  return false;
}
/** 칩마다 몇 명인지 → { soon, expired, no_contract, ins_unknown, unset } */
export function countFilters(rows) {
  const n = {};
  for (const k of HR_FILTERS) n[k] = (rows ?? []).filter((r) => matchFilter(r, k)).length;
  return n;
}

/* ---------- 목록 묶음 ---------- */
const ROLE_ORDER = ["deputy", "chairman", "supervisor", "manager", "staff"]; // 한 사업장 안 정렬: 부대표 → 회장 → 중간관리자 → 매니저 → 직원
const STORE_ORDER = ["gejang", "ck", "fnb"]; // 사업장 순서: 게장 → CK → F&B → 그 밖 이름순
const roleRank = (r) => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? ROLE_ORDER.length : i; };
const cmpName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), "ko");
/** rows(HrRow[]) 를 사업장별로 묶는다 → [{ key, store(객체|null=소속 미지정), rows }]. 소속 미지정은 맨 끝 */
export function groupByStore(rows, stores) {
  const list = Array.isArray(stores) ? stores : [];
  const byId = new Map(list.map((s) => [s.id, s]));
  const groups = new Map();
  for (const r of rows ?? []) {
    const st = r.store_id && byId.has(r.store_id) ? byId.get(r.store_id) : null;
    const key = st ? st.id : "";
    if (!groups.has(key)) groups.set(key, { key, store: st, rows: [] });
    groups.get(key).rows.push(r);
  }
  const rank = (g) => {
    if (!g.store) return 1000;
    const i = STORE_ORDER.indexOf(g.store.app_key);
    return i < 0 ? 100 : i;
  };
  const out = [...groups.values()].sort((a, b) => rank(a) - rank(b) || String(a.store?.display_name || a.store?.name || "").localeCompare(String(b.store?.display_name || b.store?.name || ""), "ko"));
  for (const g of out) g.rows.sort((a, b) => roleRank(a.role) - roleRank(b.role) || cmpName(a, b));
  return out;
}
