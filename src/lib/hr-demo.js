// 인사 현황 데모 모드(키 없는 설정): 가상 자료로 끝까지 동작한다. 서버 모드(hr-api.js)와 같은 메서드·같은 반환 모양. 설계 7.7·8.4
// 이름은 모두 가상("(데모)")이고 금액은 눈에 띄게 둥근 가상 값이다. 날짜는 오늘 기준 상대값이라 언제 열어도 같은 상태가 보인다.
// 바꾼 값은 이 화면을 연 동안 메모리에만 있다(새로 고치면 처음으로 돌아간다). 브라우저 저장 공간에는 아무것도 쓰지 않는다.
import { todayKST, addDays } from "./kst.js";
import { hrError, canManageHr, canSeeHrTarget, daysLeft, payProblem, dateInRange, fileError, extOfName } from "./hr.js";

const E = "enrolled", N = "not_enrolled", U = "unknown"; // 4대보험: 가입 / 미가입 / 미확인
const REF = { this_month: 0, last_month: 1, last_3_months: 2 };

// 가상 직원 12명(사업장 3개). att: ["rates", [이번 달 %, 지각, 퇴근 누락], [지난 달 …], [최근 3개월 …]] | ["no_records"] | ["no_days"]
// 출근율 숫자는 정해 둔 가상 값이다(출근 일수는 달력 날짜 수에서 거꾸로 맞춘다). exp = 보건증 만료까지 남은 일수(음수 = 이미 만료, null = 만료일 없음)
const PEOPLE = [
  { id: "demo-hr-01", name: "김하나(데모)", store: "gejang", role: "staff", job: "홀 서버", work: "fixed", need: "yes", exp: 5, ins: [E, E, E, E], pay: ["monthly", 2100000], files: 1, cs: "yes", att: ["rates", [92, 1, 0], [90, 2, 1], [91, 4, 1]] },
  { id: "demo-hr-02", name: "박둘(데모)", store: "gejang", role: "staff", job: "주방", work: "flex", need: "yes", exp: 24, ins: [E, E, U, U], pay: ["hourly", 12000], files: 0, cs: "no", att: ["rates", [77, 0, 1], [80, 0, 2], [79, 0, 3]] },
  { id: "demo-hr-03", name: "이셋(데모)", store: "gejang", role: "staff", job: "홀 서버", work: "fixed", need: "yes", exp: -3, ins: [E, N, N, E], pay: ["hourly", 11000], files: 1, cs: "yes", att: ["rates", [100, 0, 0], [96, 1, 0], [97, 2, 0]] },
  { id: "demo-hr-04", name: "최넷(데모)", store: "gejang", role: "manager", job: "매니저", work: "fixed", need: "yes", exp: 180, ins: [E, E, E, E], pay: ["monthly", 3000000], files: 2, cs: "yes", att: ["rates", [96, 0, 0], [95, 1, 0], [95, 1, 1]] },
  { id: "demo-hr-05", name: "정다섯(데모)", store: "ck", role: "staff", job: "포장", work: "fixed", need: "yes", exp: null, ins: [U, U, U, U], pay: [null, null], files: 0, cs: "unknown", att: ["rates", [64, 3, 2], [70, 2, 1], [68, 6, 4]] },
  { id: "demo-hr-06", name: "오여섯(데모)", store: "ck", role: "staff", job: "포장", work: "fixed", need: "yes", exp: 60, ins: [E, E, E, E], pay: ["monthly", 2500000], files: 1, cs: "yes", hired: 0, att: ["no_days"] },
  { id: "demo-hr-07", name: "윤반장(데모)", store: "ck", role: "supervisor", job: "반장", work: "fixed", need: "yes", exp: 7, ins: [E, E, E, E], pay: ["monthly", 3500000], files: 1, cs: "yes", att: ["rates", [88, 1, 0], [90, 0, 0], [89, 2, 1]] },
  { id: "demo-hr-08", name: "한일곱(데모)", store: "fnb", role: "staff", job: "사무", work: "fixed", need: "no", exp: null, ins: [E, E, E, E], pay: ["monthly", 2500000], files: 1, cs: "yes", att: ["no_records"] },
  { id: "demo-hr-09", name: "강여덟(데모)", store: "fnb", role: "staff", job: "사무", work: "fixed", need: "unknown", exp: null, ins: [U, U, U, U], pay: [null, null], files: 0, cs: "unknown", att: ["no_records"] },
  { id: "demo-hr-10", name: "김부장(데모)", store: "fnb", role: "supervisor", job: "부장", work: "fixed", need: "no", exp: null, ins: [E, E, E, E], pay: ["monthly", 3500000], files: 1, cs: "yes", att: ["rates", [100, 0, 0], [100, 0, 0], [99, 0, 0]] },
  { id: "demo-hr-11", name: "최전무(데모)", store: "fnb", role: "deputy", job: "전무", work: "fixed", need: "no", exp: null, ins: [E, E, E, E], pay: ["monthly", 3500000], files: 1, cs: "yes", att: ["no_records"] },
  { id: "demo-hr-12", name: "회장(데모)", store: "", role: "chairman", job: "회장", work: "fixed", need: "unknown", exp: null, ins: [E, E, E, E], pay: ["none", null], files: 0, cs: "yes", att: ["no_records"] },
];

let db = null, fileSeq = 0; // user_id → 그 사람의 자료(메모리에만)
export function resetHrDemo() { db = null; fileSeq = 0; }

const FILE_NAMES = ["근로계약서(데모).pdf", "근로계약서 2쪽(데모).pdf"];
function seed(stores) {
  const today = todayKST();
  const ago = (d) => new Date(Date.now() - d * 86400e3).toISOString();
  const sid = (key) => (stores.find((s) => s.app_key === key) || {}).id ?? null;
  db = new Map();
  PEOPLE.forEach((p, i) => {
    // 행이 없는 사람(모두 미확인)은 수정 기록도 없다
    const secretRow = p.ins.some((x) => x !== U) || p.pay[0] != null || p.cs !== "unknown" || p.hired === 0;
    const healthRow = p.need !== "unknown";
    const exp = p.exp == null ? null : addDays(today, p.exp);
    db.set(p.id, {
      user_id: p.id, name: p.name, job_title: p.job, role: p.role, store_id: p.store ? sid(p.store) : null, work_type: p.work,
      att: p.att,
      secret: { pay_type: p.pay[0], pay_amount: p.pay[1], ins_pension: p.ins[0], ins_health: p.ins[1], ins_employment: p.ins[2], ins_accident: p.ins[3],
        hired_on: p.hired === 0 ? today : null, contract_state: p.cs, updated_at: secretRow ? ago(2 + i) : null, updated_by_name: secretRow ? "대표(데모)" : "" },
      health: { need: p.need, issued_on: exp ? addDays(exp, -365) : null, expires_on: exp, updated_at: healthRow ? ago(2 + i) : null, updated_by_name: healthRow ? "대표(데모)" : "" },
      files: Array.from({ length: p.files }, (_, k) => ({ id: `${p.id}-f${k + 1}`, name: FILE_NAMES[k] ?? `근로계약서 ${k + 1}(데모).pdf`, size: 180000 + k * 90000, mime: "application/pdf", uploaded_at: ago(10 + k), path: `${p.id}/demo-${k + 1}.pdf` })),
    });
  });
}

/* ---------- 기간·출근율 ---------- */
const nonSundays = (from, to) => { let n = 0; for (let d = from; d <= to; d = addDays(d, 1)) if (new Date(d + "T00:00:00Z").getUTCDay() !== 0) n++; return n; }; // 데모 사업장은 일요일이 휴무라고 본다
/** 서버 hr_period_range 와 같은 날짜 계산(오늘 = KST). 모르는 기간이면 null */
export function periodRange(period, today) {
  const first = today.slice(0, 8) + "01";
  if (period === "this_month") return { from: first, to: addDays(today, -1) };
  if (period === "last_month") { const to = addDays(first, -1); return { from: to.slice(0, 8) + "01", to }; }
  if (period === "last_3_months") {
    let y = +today.slice(0, 4), m = +today.slice(5, 7) - 3;
    if (m < 1) { m += 12; y -= 1; }
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${y}-${String(m).padStart(2, "0")}-${String(Math.min(+today.slice(8, 10), dim)).padStart(2, "0")}`, to: addDays(today, -1) };
  }
  return null;
}
function attOf(p, period, range, today) {
  const kind = p.att[0];
  const hired = p.secret.hired_on;
  const countedFrom = hired && hired > range.from ? hired : range.from;
  const sched = countedFrom > range.to ? 0 : nonSundays(countedFrom, range.to);
  const base = { work_type: p.work_type, counted_from: countedFrom, sched_days: sched, present_days: 0, rate_pct: null, late_count: null, missing_out: 0, reason: null };
  if (kind === "no_records") return { ...base, reason: "no_records" };
  if (kind === "no_days" || sched === 0) return { ...base, reason: "no_days" }; // 입사 직후이거나 이 달 1일(집계할 날이 아직 없음)
  const [pct, late, miss] = p.att[1 + REF[period]];
  return { ...base, present_days: Math.min(sched, Math.round((sched * pct) / 100)), rate_pct: pct, late_count: p.work_type === "fixed" ? late : null, missing_out: miss };
}

/* ---------- 서버 검사 흉내(supabase/hr.sql 의 제약과 같은 범위) ---------- */
const INS_OK = [E, N, U], PAY_TYPES = [null, "monthly", "hourly", "none"], CS_OK = ["unknown", "yes", "no"], NEED_OK = ["unknown", "yes", "no"];
const bad = (kind) => hrError("invalid", { kind });
function checkSecret(s) {
  const pay_type = s.pay_type ?? null;
  if (!PAY_TYPES.includes(pay_type)) throw bad("money");
  const money = pay_type === "monthly" || pay_type === "hourly";
  const pay_amount = money ? (s.pay_amount ?? null) : null;
  if (money ? payProblem(pay_type, pay_amount) : s.pay_amount != null) throw bad("money"); // 월급·시급은 범위 안의 정수, 그 밖의 유형은 금액이 없어야 한다(서버 hr_secret_pay_chk)
  for (const k of ["ins_pension", "ins_health", "ins_employment", "ins_accident"]) if (!INS_OK.includes(s[k])) throw bad("money");
  if (!CS_OK.includes(s.contract_state)) throw bad("money");
  const hired_on = s.hired_on || null;
  if (hired_on && !dateInRange(hired_on)) throw bad("date");
  return { pay_type, pay_amount, ins_pension: s.ins_pension, ins_health: s.ins_health, ins_employment: s.ins_employment, ins_accident: s.ins_accident, hired_on, contract_state: s.contract_state };
}
function checkHealth(h) {
  if (!NEED_OK.includes(h.need)) throw bad("date");
  const issued_on = h.issued_on || null, expires_on = h.expires_on || null;
  if (h.need !== "yes" && (issued_on || expires_on)) throw bad("date");
  if ((issued_on && !dateInRange(issued_on)) || (expires_on && !dateInRange(expires_on)) || (issued_on && expires_on && issued_on > expires_on)) throw bad("date");
  return { need: h.need, issued_on, expires_on };
}

/**
 * 데모용 인사 현황 객체. me() = 지금 로그인한 사람({ role, display_name }), stores = 데모 사업장 목록.
 * 관리자 3역할이 아니면 모든 메서드(myHealth 제외)가 forbidden 을 던진다. 대상 행 규칙은 canSeeHrTarget(서버 hr_target_ok 와 같다).
 */
export function makeHrDemo({ me, stores }) {
  const st = Array.isArray(stores) ? stores : [];
  if (!db) seed(st);
  async function guard(target) {
    const p = await me();
    if (!p || !canManageHr(p.role)) throw hrError("forbidden");
    if (target) { const x = db.get(target); if (!x || !canSeeHrTarget(p.role, x.role)) throw hrError("forbidden"); }
    return p;
  }
  const copy = (o) => JSON.parse(JSON.stringify(o));
  return {
    async list(period = "this_month") {
      const viewer = await guard();
      const today = todayKST(), range = periodRange(period, today);
      if (!range) throw hrError("unknown", { mode: "read" });
      const rows = [...db.values()].filter((p) => canSeeHrTarget(viewer.role, p.role)).map((p) => ({
        user_id: p.user_id, name: p.name, job_title: p.job_title, role: p.role, store_id: p.store_id,
        att: attOf(p, period, range, today),
        pay: { type: p.secret.pay_type, has_amount: p.secret.pay_type === "monthly" || p.secret.pay_type === "hourly" },
        ins: { pension: p.secret.ins_pension, health: p.secret.ins_health, employment: p.secret.ins_employment, accident: p.secret.ins_accident },
        hired_on: p.secret.hired_on, contract_state: p.secret.contract_state,
        health: { need: p.health.need, issued_on: p.health.issued_on, expires_on: p.health.expires_on, days_left: daysLeft(p.health.expires_on, today) },
        contracts: p.files.length,
        updated: { secret_at: p.secret.updated_at, health_at: p.health.updated_at },
      }));
      return { period, from: range.from, to: range.to, today, stores: st.map((s) => ({ id: s.id, name: s.name, display_name: s.display_name, app_key: s.app_key, kind: s.kind })), rows };
    },
    async detail(userId) {
      await guard(userId);
      const p = db.get(userId);
      return { user_id: p.user_id, name: p.name, secret: copy(p.secret), health: copy(p.health), files: copy(p.files) };
    },
    async payAmount(userId) {
      await guard(userId);
      const a = db.get(userId).secret.pay_amount;
      return Number.isInteger(a) ? a : null;
    },
    async save(userId, patch = {}) {
      const viewer = await guard(userId);
      const p = db.get(userId), saved = [];
      const stamp = { updated_at: new Date().toISOString(), updated_by_name: viewer.display_name ?? "" };
      if (patch.secret) { Object.assign(p.secret, checkSecret(patch.secret), stamp); saved.push("secret"); }
      if (patch.health) {
        let h;
        try { h = checkHealth(patch.health); } catch (e) { throw Object.assign(e, { saved }); }
        Object.assign(p.health, h, stamp); saved.push("health");
      }
      return { saved };
    },
    async fileUpload(userId, file, opts = {}) {
      await guard(userId);
      const p = db.get(userId);
      const err = fileError(file, p.files.length);
      if (err) throw err;
      const ext = extOfName(file.name), n = ++fileSeq;
      const row = { id: `${userId}-u${n}`, name: Array.from(String(file.name ?? "")).slice(0, 200).join(""), size: file.size, mime: file.type || "", uploaded_at: new Date().toISOString(), path: `${userId}/demo-u${n}.${ext}` };
      p.files.push(row);
      if (opts.onProgress) opts.onProgress({ loaded: file.size, total: file.size });
      return copy(row);
    },
    async fileUrl(fileRow) {
      const owner = [...db.values()].find((p) => p.files.some((f) => f.id === fileRow?.id));
      await guard(owner?.user_id);
      throw hrError("unknown", { mode: "read", key: "데모 모드에서는 파일을 열 수 없어요" });
    },
    async fileDelete(fileRow) {
      const owner = [...db.values()].find((p) => p.files.some((f) => f.id === fileRow?.id));
      await guard(owner?.user_id);
      owner.files = owner.files.filter((f) => f.id !== fileRow.id);
    },
    // 모든 로그인 계정이 부른다. 직원은 필요·만료 +12일, 매니저는 필요·+200일, 중간관리자는 해당 없음, 그 밖(대표·부대표·회장)은 미확인
    async myHealth() {
      const p = await me();
      if (!p || !p.role) return null;
      const today = todayKST();
      const spec = { staff: ["yes", 12], manager: ["yes", 200], supervisor: ["no", null] }[p.role] ?? ["unknown", null];
      const exp = spec[1] == null ? null : addDays(today, spec[1]);
      return { need: spec[0], issued_on: exp ? addDays(exp, -365) : null, expires_on: exp, days_left: exp ? spec[1] : null, today };
    },
  };
}
