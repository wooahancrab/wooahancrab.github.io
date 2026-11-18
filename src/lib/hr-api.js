// 인사 현황 서버 호출 모음(supabase/hr.sql). 화면은 api.hr() 로 이 객체를 받아 쓴다. 설계 8절.
// 읽고 쓰기는 앱이 표·보관함에 직접 하고, 누가 볼 수 있는지는 DB 접근 규칙(RLS)이 막는다(여기는 편의일 뿐 보안 경계가 아니다).
// 약속: ① 직원 자료를 모듈 변수에 두지 않는다(호출마다 새로 받는다) ② 목록 응답에 급여 금액을 받지 않는다(hr_secret 에서 pay_amount 를 고르지 않는다)
//       ③ 서버 오류의 message·details·hint 는 화면·콘솔에 쓰지 않는다(Postgres 는 실패한 행의 값=급여를 details 에 담는다) — 코드와 고정 문구만
//       ④ 브라우저 저장 공간·주소(URL)·콘솔에 직원 값을 쓰지 않는다
import { hrError, hrLog, daysLeft, fileError, extOfName, shortFileName, HR_FILE_MIME } from "./hr.js";

const BUCKET = "hr-contracts";
const SIGNED_SECONDS = 60; // 임시 주소는 60초만 산다. 누를 때마다 새로 만들고 저장하지 않는다
const MIME_ALIAS = { "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };
const NET_RE = /failed to fetch|networkerror|load failed|network request failed|timed? ?out/i;
const FORBID_RE = /permission denied|row-level security|unauthorized|not authorized|forbidden/i;
const NOT_READY_CODES = ["PGRST202", "42883", "PGRST205", "42P01"];
const MONEY_CONS = ["hr_secret_pay_chk", "hr_secret_ins_chk", "hr_secret_contract_chk"];
const DATE_CONS = ["hr_secret_hired_chk", "hr_health_need_chk", "hr_health_dates_chk"];

/**
 * PostgREST·Storage·네트워크 오류 → HrError(고정 문구). mode: "read"(읽는 중) | "write"(저장·올리기·지우기 중).
 * 서버가 준 글은 제약 이름(hr_…_chk)을 골라내는 데만 읽고 어디에도 남기지 않는다.
 */
export function mapHrError(e, mode = "read") {
  if (e && e.name === "HrError") return e;
  const code = String((e && e.code) || ""), status = String((e && (e.status || e.statusCode)) || "");
  const msg = String((e && e.message) || "");
  const pg = code || status;
  const o = { mode, pg };
  if (NOT_READY_CODES.includes(code) || /bucket not found/i.test(msg)) return hrError("not_ready", o);
  if (code === "42501" || status === "401" || status === "403" || FORBID_RE.test(msg)) return hrError("forbidden", o);
  if (code === "54000" || /hr_too_many_files/.test(msg)) return hrError("too_many_files", o);
  if (code === "23514") {
    const cons = (msg.match(/hr_[a-z_]+_chk/) || [""])[0];
    if (!cons || MONEY_CONS.includes(cons)) return hrError("invalid", { ...o, kind: "money" });
    if (DATE_CONS.includes(cons)) return hrError("invalid", { ...o, kind: "date" });
    return hrError("unknown", o); // 알 수 없는 제약
  }
  if (code === "22007" || code === "22008") return hrError("invalid", { ...o, kind: "date" });
  if (status === "413" || /payload too large|entity too large|exceeded the maximum allowed size/i.test(msg)) return hrError("too_big", { ...o, params: { nm: "", size: "" } });
  if (status === "415" || /invalid_mime_type|mime type .* is not supported/i.test(msg + " " + code)) return hrError("bad_type", { ...o, params: { nm: "" } });
  if (NET_RE.test(msg)) return hrError("network", o);
  return hrError("unknown", o);
}

const SECRET_LIST_COLS = "user_id,pay_type,ins_pension,ins_health,ins_employment,ins_accident,hired_on,contract_state,updated_at"; // pay_amount 는 일부러 뺀다
const INS_DEFAULT = "unknown";

/** sb = 비동기 함수(supabase 클라이언트를 돌려준다. 호출마다 새로 받아 로그아웃·다른 계정 로그인 뒤에도 지금 세션을 쓴다), me·listStores 는 api.js 가 넘긴다 */
export function makeHr({ sb, me, listStores }) {
  void me;
  // 서버 응답 한 줄씩 → 조건에 맞는 행만(응답이 비정상이어도 화면이 죽지 않게)
  const arr = (x) => (Array.isArray(x) ? x : []);
  const fail = (err, mode) => { const e = mapHrError(err, mode); hrLog(e); return e; };

  return {
    /** 명단 + 출근율(서버 hr_attendance_stats) + 인사 표 3개 + 사업장 → { period, from, to, today, stores, rows } */
    async list(period = "this_month") {
      const c = await sb();
      const [stats, sec, hea, files, stores] = await Promise.all([
        c.rpc("hr_attendance_stats", { p_period: period }),
        c.from("hr_secret").select(SECRET_LIST_COLS),
        c.from("hr_health").select("user_id,need,issued_on,expires_on,updated_at"),
        c.from("hr_contract_files").select("id,user_id"),
        Promise.resolve(listStores()).then((data) => ({ data, error: null }), (error) => ({ data: null, error })),
      ]);
      for (const r of [stats, sec, hea, files, stores]) if (r && r.error) throw fail(r.error, "read");
      const s = stats && stats.data;
      if (!s || typeof s !== "object" || !Array.isArray(s.rows) || typeof s.today !== "string") throw fail(null, "read");
      const secBy = new Map(arr(sec.data).map((x) => [x.user_id, x]));
      const heaBy = new Map(arr(hea.data).map((x) => [x.user_id, x]));
      const cnt = new Map();
      for (const f of arr(files.data)) cnt.set(f.user_id, (cnt.get(f.user_id) || 0) + 1);
      const rows = s.rows.map((r) => {
        const x = secBy.get(r.user_id), y = heaBy.get(r.user_id);
        const money = x && (x.pay_type === "monthly" || x.pay_type === "hourly");
        return {
          user_id: r.user_id, name: r.display_name ?? "", job_title: r.job_title ?? "", role: r.role, store_id: r.store_id ?? null,
          att: { work_type: r.work_type, counted_from: r.counted_from, sched_days: r.sched_days ?? 0, present_days: r.present_days ?? 0, rate_pct: r.rate_pct ?? null, late_count: r.late_count ?? null, missing_out: r.missing_out ?? 0, reason: r.reason ?? null },
          pay: { type: x ? x.pay_type ?? null : null, has_amount: !!money },
          ins: { pension: x ? x.ins_pension : INS_DEFAULT, health: x ? x.ins_health : INS_DEFAULT, employment: x ? x.ins_employment : INS_DEFAULT, accident: x ? x.ins_accident : INS_DEFAULT },
          hired_on: x ? x.hired_on ?? null : null,
          contract_state: x ? x.contract_state : "unknown",
          health: { need: y ? y.need : "unknown", issued_on: y ? y.issued_on ?? null : null, expires_on: y ? y.expires_on ?? null : null, days_left: y ? daysLeft(y.expires_on, s.today) : null },
          contracts: cnt.get(r.user_id) || 0,
          updated: { secret_at: x ? x.updated_at ?? null : null, health_at: y ? y.updated_at ?? null : null },
        };
      });
      return { period: s.period ?? period, from: s.from ?? "", to: s.to ?? "", today: s.today, stores: arr(stores.data).map((x) => ({ id: x.id, name: x.name, display_name: x.display_name, app_key: x.app_key, kind: x.kind })), rows };
    },

    /** 수정 시트용: 그 사람의 전체 값(금액 포함) */
    async detail(userId) {
      const c = await sb();
      const [s, h, f] = await Promise.all([
        c.from("hr_secret").select("*").eq("user_id", userId).maybeSingle(),
        c.from("hr_health").select("*").eq("user_id", userId).maybeSingle(),
        c.from("hr_contract_files").select("id,name,size,mime,uploaded_at,path").eq("user_id", userId).order("uploaded_at"),
      ]);
      for (const r of [s, h, f]) if (r && r.error) throw fail(r.error, "read");
      const sd = s.data || null, hd = h.data || null;
      // 이름: 대상 직원과 마지막으로 고친 사람. 못 읽어도(정책·오류) 시트는 열린다
      const ids = [...new Set([userId, sd && sd.updated_by, hd && hd.updated_by].filter(Boolean))];
      const names = new Map();
      try {
        const p = await c.from("profiles").select("user_id,display_name").in("user_id", ids);
        for (const r of arr(p && p.data)) names.set(r.user_id, r.display_name ?? "");
      } catch { /* 이름은 없어도 된다 */ }
      return {
        user_id: userId, name: names.get(userId) ?? "",
        secret: { pay_type: sd ? sd.pay_type ?? null : null, pay_amount: sd && Number.isInteger(sd.pay_amount) ? sd.pay_amount : null,
          ins_pension: sd ? sd.ins_pension : INS_DEFAULT, ins_health: sd ? sd.ins_health : INS_DEFAULT, ins_employment: sd ? sd.ins_employment : INS_DEFAULT, ins_accident: sd ? sd.ins_accident : INS_DEFAULT,
          hired_on: sd ? sd.hired_on ?? null : null, contract_state: sd ? sd.contract_state : "unknown", updated_at: sd ? sd.updated_at ?? null : null, updated_by_name: sd ? names.get(sd.updated_by) ?? "" : "" },
        health: { need: hd ? hd.need : "unknown", issued_on: hd ? hd.issued_on ?? null : null, expires_on: hd ? hd.expires_on ?? null : null, updated_at: hd ? hd.updated_at ?? null : null, updated_by_name: hd ? names.get(hd.updated_by) ?? "" : "" },
        files: arr(f.data).map((x) => ({ id: x.id, name: x.name, size: x.size, mime: x.mime, uploaded_at: x.uploaded_at, path: x.path })),
      };
    },

    /** 급여 "보기" 용: 그 사람 금액 하나(정수|null) */
    async payAmount(userId) {
      const c = await sb();
      const { data, error } = await c.from("hr_secret").select("pay_amount").eq("user_id", userId).maybeSingle();
      if (error) throw fail(error, "read");
      return data && Number.isInteger(data.pay_amount) ? data.pay_amount : null;
    },

    /**
     * 저장: 보낸 부분마다 전체 열을 보낸다(부분 열 갱신으로 값이 사라지지 않게). updated_by·updated_at 은 보내지 않는다(서버 트리거가 채운다).
     * secret 을 먼저 저장한다. 실패하면 HrError 에 e.saved(이미 저장된 부분)를 담는다.
     */
    async save(userId, patch = {}) {
      const c = await sb();
      const saved = [];
      const one = async (table, key, row) => {
        const { error } = await c.from(table).upsert({ user_id: userId, ...row }, { onConflict: "user_id" }).select("user_id");
        if (error) throw Object.assign(fail(error, "write"), { saved: [...saved] });
        saved.push(key);
      };
      if (patch.secret) {
        const s = patch.secret;
        await one("hr_secret", "secret", { pay_type: s.pay_type ?? null, pay_amount: s.pay_type === "monthly" || s.pay_type === "hourly" ? s.pay_amount ?? null : null,
          ins_pension: s.ins_pension, ins_health: s.ins_health, ins_employment: s.ins_employment, ins_accident: s.ins_accident, hired_on: s.hired_on || null, contract_state: s.contract_state });
      }
      if (patch.health) {
        const h = patch.health;
        await one("hr_health", "health", { need: h.need, issued_on: h.need === "yes" ? h.issued_on || null : null, expires_on: h.need === "yes" ? h.expires_on || null : null });
      }
      return { saved };
    },

    /** 근로계약서 올리기: 확장자·크기·개수를 먼저 검사 → 보관함에 올림 → 행 저장(실패하면 올린 파일을 지움) */
    async fileUpload(userId, file, opts = {}) {
      const bad = fileError(file, 0); // 개수는 서버(hr_cf_guard)가 줄 세워 검사하고 화면이 미리 자른다
      if (bad) throw bad;
      const c = await sb();
      const ext = extOfName(file.name);
      const path = `${userId}/${crypto.randomUUID()}.${ext}`;
      let type = String(file.type || "").toLowerCase();
      type = MIME_ALIAS[type] ?? type;
      if (!HR_FILE_MIME.includes(type)) type = "application/octet-stream";
      const blob = type === file.type ? file : new Blob([file], { type }); // File 은 contentType 옵션이 무시되고 file.type 이 그대로 가므로 Blob 으로 감싼다
      if (opts.onProgress) opts.onProgress({ loaded: 0, total: file.size });
      const bucket = c.storage.from(BUCKET);
      const cleanup = async () => { try { await bucket.remove([path]); } catch { /* 정리에 실패해도 원래 오류를 알린다(고아 파일은 설계 6절) */ } };
      try {
        const up = await bucket.upload(path, blob, { contentType: type, upsert: false });
        if (up && up.error) throw up.error;
        const name = Array.from(String(file.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "")).slice(0, 200).join("") || "file";
        const { data, error } = await c.from("hr_contract_files").insert({ user_id: userId, path, name, size: file.size, mime: type }).select("id,name,size,mime,uploaded_at,path");
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) throw new Error("no row");
        if (opts.onProgress) opts.onProgress({ loaded: file.size, total: file.size });
        return { id: row.id, name: row.name, size: row.size, mime: row.mime, uploaded_at: row.uploaded_at, path: row.path };
      } catch (e) {
        await cleanup(); // 올리는 도중 응답이 끊겨도 서버에는 올라갔을 수 있어서 시도한 경로는 늘 정리를 시도한다
        const err = fail(e, "write");
        if (err.code === "too_big" || err.code === "bad_type") err.params = { nm: shortFileName(file.name), size: (file.size / 1048576).toFixed(1) }; // 서버가 크기·종류로 거절한 것도 어느 파일인지 알려 준다
        throw err;
      }
    },

    /** 60초 임시 주소(문자열). 매번 새로 만들고 저장·캐시하지 않는다 */
    async fileUrl(fileRow, opts = {}) {
      const c = await sb();
      const { data, error } = await c.storage.from(BUCKET).createSignedUrl(fileRow.path, SIGNED_SECONDS, opts.download ? { download: fileRow.name || true } : undefined);
      if (error) throw fail(error, "open");
      if (!data || typeof data.signedUrl !== "string") throw fail(null, "open");
      return data.signedUrl;
    },

    /** 지우기: 보관함 파일 먼저 → 행 나중. 파일을 못 지웠으면(오류) 행을 남긴다 */
    async fileDelete(fileRow) {
      const c = await sb();
      const r = await c.storage.from(BUCKET).remove([fileRow.path]);
      if (r && r.error) throw fail(r.error, "write");
      const { error } = await c.from("hr_contract_files").delete().eq("id", fileRow.id);
      if (error) throw fail(error, "write");
    },

    /** 모든 로그인 계정: 내 보건증(서버 hr_my_health). 함수가 없거나 오류면 조용히 null */
    async myHealth() {
      try {
        const c = await sb();
        const { data, error } = await c.rpc("hr_my_health");
        if (error) { hrLog(mapHrError(error, "read")); return null; }
        if (!data || typeof data !== "object" || typeof data.need !== "string") return null;
        return { need: data.need, issued_on: data.issued_on ?? null, expires_on: data.expires_on ?? null, days_left: typeof data.days_left === "number" ? data.days_left : null, today: data.today ?? "" };
      } catch (e) { hrLog(mapHrError(e, "read")); return null; }
    },
  };
}
